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
const onlinePlanSchema = z.looseObject({
  online_optional_text_addition: z.looseObject({
    kind: z.literal("optional-text-addition-v1"),
    predecessor_artifact_sha256: z.string().regex(/^[a-f0-9]{64}$/u),
    predecessor_schema: z.looseObject({ version: z.string().min(1) }),
    model_id: z.string().min(1),
    field_id: z.string().min(1),
  }),
});

const readOnlinePlan = (files: GeneratedAppReleaseFiles) => {
  const plan = onlinePlanSchema.parse(JSON.parse(files["transition-plan.json"].toString()));
  return plan.online_optional_text_addition;
};

const readCompatibility = (files: GeneratedAppReleaseFiles) =>
  compatibilityProofSchema.parse(JSON.parse(files["operation-manifest.json"].toString()))
    .predecessorCompatibility.predecessors;

/** The two checked runtime artifacts must independently name the same predecessor and field. */
export const readOptionalTextReleasePredecessor = (files: GeneratedAppReleaseFiles) => {
  try {
    const proof = readOnlinePlan(files);
    const matches = readCompatibility(files).some(
      (entry) =>
        entry.artifactSha256 === proof.predecessor_artifact_sha256 &&
        entry.field.fieldId === proof.field_id &&
        entry.field.modelId === proof.model_id &&
        isDeepStrictEqual(entry.schema, proof.predecessor_schema),
    );
    if (matches) {
      return {
        releaseId: proof.predecessor_schema.version,
        artifactSha256: proof.predecessor_artifact_sha256,
      };
    }
  } catch {
    // Invalid checked data does not authorize the draft.
  }
  return null;
};

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

/** Verify the checked compiler inputs and runtime files retained for a published draft. */
export const assertCheckedOptionalFieldReleaseSource = (input: {
  appId: string;
  release: SchemaRelease;
  cueSha256: string;
}): void => {
  const { appId, release, cueSha256 } = input;
  const { files } = release;
  const { manifest } = readRelease(appId, release, cueSha256);
  const hashes = runtimeHashes.parse(manifest.hashes);
  if (
    hashes.operations !== sha256(files["operation-manifest.json"]) ||
    hashes.bindings !== sha256(files["data-operations.ts"]) ||
    hashes.server_bindings !== sha256(files["data-server.ts"])
  ) {
    throw unavailable();
  }
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
  return {
    projection,
    modelId: model,
    fieldId: field.id,
    label: optionalText.parse(field).label,
    changeTypeIds: next.schema.change_types.flatMap(({ id, touches, target_model }) =>
      target_model === model && touches.includes(field.id) ? [id] : [],
    ),
  };
};

interface TransitionInput {
  appId: string;
  prior: SchemaRelease;
  candidate: SchemaRelease;
  priorCueSha256: string;
  candidateCueSha256: string;
}

const checkedTransition = (input: {
  appId: string;
  priorReleaseId: string;
  priorArtifactSha256: string;
  previous: ReturnType<typeof readRelease>;
  candidate: SchemaRelease;
  candidateCueSha256: string;
}) => {
  const { appId, priorReleaseId, priorArtifactSha256, candidate, candidateCueSha256, previous } =
    input;
  const next = readRelease(appId, candidate, candidateCueSha256);
  const transition = transitionContractSchema.parse(
    JSON.parse(candidate.files["transition-contract.json"].toString()),
  );
  const plan = transitionPlanSchema.parse(
    JSON.parse(candidate.files["transition-plan.json"].toString()),
  );
  const { customer_id: customerId } = previous.artifact.schema;
  const { projection, ...addition } = projectOptionalTextAddition(previous.artifact, next.artifact);
  const { modelId, fieldId } = addition;
  const { files } = candidate;
  const hashes = runtimeHashes.parse(next.manifest.hashes);
  const predecessors = readCompatibility(files);
  // This repository compiler step emits the compatibility evidence. All other
  // manifest inputs and the normalized schema still have to match exactly.
  Reflect.deleteProperty(previous.sources, releaseCompilerScript);
  Reflect.deleteProperty(next.sources, releaseCompilerScript);
  const compatible = [
    priorReleaseId !== candidate.releaseId,
    isDeepStrictEqual(previous.manifest.compiler, next.manifest.compiler),
    isDeepStrictEqual(previous.sources, next.sources),
    isDeepStrictEqual(previous.artifact, projection),
    hashes.operations === sha256(files["operation-manifest.json"]),
    hashes.bindings === sha256(files["data-operations.ts"]),
    hashes.server_bindings === sha256(files["data-server.ts"]),
    predecessors.some(
      (entry) =>
        entry.artifactSha256 === priorArtifactSha256 &&
        entry.field.modelId === modelId &&
        entry.field.fieldId === fieldId &&
        isDeepStrictEqual(entry.schema, previous.artifact.schema),
    ),
    transition.app_id === appId,
    transition.customer_id === customerId,
    transition.version === candidate.releaseId,
    transition.predecessors.some(
      (entry) =>
        entry.version === priorReleaseId &&
        isDeepStrictEqual(entry.schema, previous.artifact.schema),
    ),
    plan.app_id === appId,
    plan.customer_id === customerId,
    plan.version === candidate.releaseId,
  ].every(Boolean);
  if (!compatible) {
    throw unavailable();
  }
  return { transition, predecessors, addition };
};

/** Check compiled data semantics and the exact approved CUE inputs before applying any DDL. */
export const assertOptionalTextProductionTransition = (input: TransitionInput): void => {
  const { appId, prior, priorCueSha256 } = input;
  try {
    checkedTransition({
      ...input,
      priorReleaseId: prior.releaseId,
      priorArtifactSha256: sha256(prior.files["app-artifact.json"]).slice("sha256:".length),
      previous: readRelease(appId, prior, priorCueSha256),
    });
  } catch {
    // Artifact bodies and decoder errors stay inside the operator.
    // oxlint-disable-next-line eslint/preserve-caught-error -- Keep private compiler data out of diagnostics.
    throw unavailable();
  }
};

/**
 * Compare an original draft against the recovered prior artifact. Its toolchain
 * inputs come from the checked published prior release. No synthetic manifest
 * or recovered release is passed to the installer.
 */
export const readTransitionForRecoveredOptionalField = (input: {
  appId: string;
  publishedPrior: SchemaRelease;
  publishedPriorCueSha256: string;
  recoveredArtifact: Buffer;
  candidate: SchemaRelease;
  candidateCueSha256: string;
}) => {
  const { appId, publishedPrior, publishedPriorCueSha256, recoveredArtifact, candidate } = input;
  const published = readRelease(appId, publishedPrior, publishedPriorCueSha256);
  const artifact = artifactSchema.parse(JSON.parse(recoveredArtifact.toString("utf-8")));
  const priorArtifactSha256 = sha256(recoveredArtifact).slice("sha256:".length);
  const proof = readOnlinePlan(candidate.files);
  const { transition, predecessors, addition } = checkedTransition({
    ...input,
    priorReleaseId: publishedPrior.releaseId,
    priorArtifactSha256,
    previous: { ...published, artifact },
  });
  const contract = transition.predecessors.filter(
    ({ version }) => version === publishedPrior.releaseId,
  );
  const operation = predecessors.filter(
    ({ artifactSha256 }) => artifactSha256 === priorArtifactSha256,
  );
  const priorMatches = [
    artifact.schema.version === publishedPrior.releaseId,
    artifact.schema.app_id === appId,
    artifact.schema.customer_id === published.artifact.schema.customer_id,
    proof.predecessor_artifact_sha256 === priorArtifactSha256,
    isDeepStrictEqual(proof.predecessor_schema, artifact.schema),
    proof.model_id === addition.modelId,
    proof.field_id === addition.fieldId,
    contract.length === 1,
    isDeepStrictEqual(contract[0]?.schema, artifact.schema),
    operation.length === 1,
    isDeepStrictEqual(operation[0]?.schema, artifact.schema),
  ].every(Boolean);
  if (!priorMatches) {
    throw unavailable();
  }
  return addition;
};
