import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { GeneratedAppReleaseFiles } from "./hosted-operator-sandbox-launcher";

const digest = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const manifestSchema = z.looseObject({
  app: z.string(),
  schema_version: z.string(),
  compiler: z.json(),
  sources: z.record(z.string(), digest),
  hashes: z.looseObject({
    schema: digest,
    plan: digest,
    transition_contract: digest,
    bundle: digest,
  }),
});
const fieldSchema = z.looseObject({ id: z.string() });
const changeTypeSchema = z.looseObject({
  id: z.string(),
  target_model: z.string(),
  touches: z.array(z.string()),
});
const artifactSchema = z.looseObject({
  schema: z.looseObject({
    app_id: z.string(),
    customer_id: z.string(),
    version: z.string(),
    models: z.array(
      z.looseObject({ id: z.string(), kind: z.string(), fields: z.array(fieldSchema) }),
    ),
    change_types: z.array(changeTypeSchema),
  }),
  extras: z.looseObject({
    field_metadata: z.array(z.looseObject({ model: z.string(), field: z.string() })),
  }),
});
const transitionContractSchema = z.looseObject({
  app_id: z.string(),
  customer_id: z.string(),
  version: z.string(),
  predecessors: z.array(z.looseObject({ version: z.string(), schema: z.json() })),
});
const compatibilityProofSchema = z.looseObject({
  predecessorCompatibility: z.strictObject({
    kind: z.literal("optional-text-addition-v1"),
    predecessors: z.array(
      z.strictObject({
        artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
        schema: z.json(),
        field: z.strictObject({ modelId: z.string(), fieldId: z.string() }),
      }),
    ),
  }),
});
const transitionPlanSchema = z.looseObject({
  app_id: z.string(),
  customer_id: z.string(),
  version: z.string(),
  retirements: z.tuple([]),
});
const optionalText = z.strictObject({
  id: z.string(),
  label: z.string(),
  type: z.literal("text"),
  required: z.literal(false),
  is_unique: z.literal(false),
  target_model: z.null(),
  option_set: z.tuple([]),
  lifecycle: z.literal("active"),
  management: z.literal("fixed"),
  origin: z.literal("app"),
});

interface SchemaRelease {
  files: GeneratedAppReleaseFiles;
  releaseId: string;
  manifestSha256: string;
}
const releaseCompilerScript = ".config/mise/scripts/repository/schema-release.ts";
const runtimeHashes = z.object({ operations: digest, bindings: digest, server_bindings: digest });
const unavailable = () => new Error("repository_production_schema_revision_unverified");
const sha256 = (bytes: Buffer) => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

const readRelease = (appId: string, release: SchemaRelease, cueSha256: string) => {
  const { files, manifestSha256, releaseId } = release;
  const manifest = manifestSchema.parse(JSON.parse(files["release-manifest.json"].toString()));
  const cuePath = `apps/${appId}/schema/${appId}.cue`;
  const matchingHashes = [
    sha256(files["release-manifest.json"]) === `sha256:${manifestSha256}`,
    manifest.hashes.schema === sha256(files["app-artifact.json"]),
    manifest.hashes.plan === sha256(files["transition-plan.json"]),
    manifest.hashes.transition_contract === sha256(files["transition-contract.json"]),
    manifest.hashes.bundle === sha256(files["sql-bundle.sql"]),
    manifest.sources[cuePath] === `sha256:${cueSha256}`,
  ].every(Boolean);
  const artifact = artifactSchema.parse(JSON.parse(files["app-artifact.json"].toString()));
  if (
    ![
      matchingHashes,
      manifest.app === appId,
      manifest.schema_version === releaseId,
      artifact.schema.app_id === appId,
      artifact.schema.version === releaseId,
    ].every(Boolean)
  ) {
    throw unavailable();
  }
  const sources = { ...manifest.sources };
  Reflect.deleteProperty(sources, cuePath);
  return { artifact, manifest, sources };
};

type Artifact = z.infer<typeof artifactSchema>;
const projectOptionalTextAddition = (prior: Artifact, next: Artifact) => {
  const additions = next.schema.models.flatMap((model) => {
    const before = prior.schema.models.find(({ id }) => id === model.id);
    return model.kind !== "entity" || before === undefined
      ? []
      : model.fields.flatMap((field) =>
          before.fields.some(({ id }) => id === field.id) ? [] : [{ model: model.id, field }],
        );
  });
  const [addition] = additions;
  if (
    additions.length !== 1 ||
    addition === undefined ||
    !optionalText.safeParse(addition.field).success
  ) {
    throw unavailable();
  }
  const { model, field } = addition;
  const projection: Artifact = {
    ...next,
    schema: {
      ...next.schema,
      version: prior.schema.version,
      models: next.schema.models.map((entry) =>
        entry.id === model
          ? { ...entry, fields: entry.fields.filter(({ id }) => id !== field.id) }
          : entry,
      ),
      change_types: next.schema.change_types.map((entry) => {
        const before = prior.schema.change_types.find(({ id }) => id === entry.id);
        // An existing restricted change type may also write the new field. An
        // empty prior list must keep its original semantics.
        return entry.target_model === model && before !== undefined && before.touches.length > 0
          ? { ...entry, touches: entry.touches.filter((id) => id !== field.id) }
          : entry;
      }),
    },
    extras: {
      ...next.extras,
      field_metadata: next.extras.field_metadata.filter(
        (entry) => entry.model !== model || entry.field !== field.id,
      ),
    },
  };
  return { projection, modelId: model, fieldId: field.id };
};

/** Check compiled data semantics and the exact approved CUE inputs before applying any DDL. */
export const assertOptionalTextProductionTransition = (input: {
  appId: string;
  prior: SchemaRelease;
  candidate: SchemaRelease;
  priorCueSha256: string;
  candidateCueSha256: string;
}): void => {
  const { appId, prior, candidate, priorCueSha256, candidateCueSha256 } = input;
  try {
    const previous = readRelease(appId, prior, priorCueSha256);
    const next = readRelease(appId, candidate, candidateCueSha256);
    const transition = transitionContractSchema.parse(
      JSON.parse(candidate.files["transition-contract.json"].toString()),
    );
    const plan = transitionPlanSchema.parse(
      JSON.parse(candidate.files["transition-plan.json"].toString()),
    );
    const { customer_id: customerId } = previous.artifact.schema;
    const { projection, modelId, fieldId } = projectOptionalTextAddition(
      previous.artifact,
      next.artifact,
    );
    const previousHash = sha256(prior.files["app-artifact.json"]).slice("sha256:".length);
    const { files } = candidate;
    const hashes = runtimeHashes.parse(next.manifest.hashes);
    const { predecessorCompatibility } = compatibilityProofSchema.parse(
      JSON.parse(files["operation-manifest.json"].toString()),
    );
    // This repository compiler step emits the compatibility evidence. All other
    // manifest inputs and the normalized schema still have to match exactly.
    Reflect.deleteProperty(previous.sources, releaseCompilerScript);
    Reflect.deleteProperty(next.sources, releaseCompilerScript);
    const compatible = [
      prior.releaseId !== candidate.releaseId,
      isDeepStrictEqual(previous.manifest.compiler, next.manifest.compiler),
      isDeepStrictEqual(previous.sources, next.sources),
      isDeepStrictEqual(previous.artifact, projection),
      hashes.operations === sha256(files["operation-manifest.json"]),
      hashes.bindings === sha256(files["data-operations.ts"]),
      hashes.server_bindings === sha256(files["data-server.ts"]),
      predecessorCompatibility.predecessors.some(
        (entry) =>
          entry.artifactSha256 === previousHash &&
          entry.field.modelId === modelId &&
          entry.field.fieldId === fieldId &&
          isDeepStrictEqual(entry.schema, previous.artifact.schema),
      ),
      transition.app_id === appId,
      transition.customer_id === customerId,
      transition.version === candidate.releaseId,
      transition.predecessors.some(
        (entry) =>
          entry.version === prior.releaseId &&
          isDeepStrictEqual(entry.schema, previous.artifact.schema),
      ),
      plan.app_id === appId,
      plan.customer_id === customerId,
      plan.version === candidate.releaseId,
    ].every(Boolean);
    if (!compatible) {
      throw unavailable();
    }
  } catch {
    // Artifact bodies and decoder errors stay inside the operator.
    // oxlint-disable-next-line eslint/preserve-caught-error -- Keep private compiler data out of diagnostics.
    throw unavailable();
  }
};
