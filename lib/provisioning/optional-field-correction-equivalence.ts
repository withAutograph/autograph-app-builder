import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import type { OverlayChange } from "../repository/target-apply";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import {
  assertOptionalTextProductionTransition,
  readOptionalTextReleasePredecessor,
} from "./repository-production-schema-revision";

type Transition = Parameters<typeof assertOptionalTextProductionTransition>[0];
type ReleasePair = Omit<Transition, "appId">;

interface PredecessorIdentity {
  releaseId: string;
  artifactSha256: string;
  manifestSha256: string;
  cueSha256: string;
}

const artifactSchema = z.looseObject({
  schema: z.looseObject({
    models: z.array(
      z.looseObject({
        id: z.string(),
        fields: z.array(z.looseObject({ id: z.string(), label: z.string() })),
      }),
    ),
  }),
});
const manifestSchema = z.looseObject({
  compiler: z.json(),
  sources: z.record(z.string(), z.string()),
});
const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

type Artifact = z.infer<typeof artifactSchema>;

const readArtifact = (release: ReleasePair["prior"]): Artifact =>
  artifactSchema.parse(JSON.parse(release.files["app-artifact.json"].toString("utf-8")));

const lowerCaseExistingLabels = (artifact: Artifact, prior: Artifact): Artifact => {
  const existing = new Map(
    prior.schema.models.map(({ id, fields }) => [id, new Set(fields.map((field) => field.id))]),
  );
  return {
    ...artifact,
    schema: {
      ...artifact.schema,
      models: artifact.schema.models.map((model) => ({
        ...model,
        fields: model.fields.map((field) =>
          existing.get(model.id)?.has(field.id) === true
            ? { ...field, label: field.label.toLowerCase() }
            : field,
        ),
      })),
    },
  };
};

const checkedOnlinePair = (appId: string, pair: ReleasePair) => {
  assertOptionalTextProductionTransition({ appId, ...pair });
  const artifactSha256 = sha256(pair.prior.files["app-artifact.json"]);
  const proof = readOptionalTextReleasePredecessor(pair.candidate.files);
  if (proof?.releaseId !== pair.prior.releaseId || proof.artifactSha256 !== artifactSha256) {
    throw new Error("The checked candidate does not name its prior release.");
  }
  return {
    identity: {
      releaseId: pair.prior.releaseId,
      artifactSha256,
      manifestSha256: pair.prior.manifestSha256,
      cueSha256: pair.priorCueSha256,
    },
    prior: readArtifact(pair.prior),
    candidate: readArtifact(pair.candidate),
  };
};

const compilerInputs = (candidate: ReleasePair["candidate"], cuePath: string) => {
  const { compiler, sources } = manifestSchema.parse(
    JSON.parse(candidate.files["release-manifest.json"].toString("utf-8")),
  );
  Reflect.deleteProperty(sources, cuePath);
  return { compiler, sources };
};

const matchesDraftChanges = (input: {
  appId: string;
  cuePath: string;
  original: ReleasePair;
  corrected: ReleasePair;
  headChanges: readonly OverlayChange[];
}) => {
  const { appId, cuePath, original, corrected, headChanges } = input;
  const releasePath = `apps/${appId}/schema/release/${corrected.candidate.releaseId}`;
  const expected = new Map([
    [cuePath, { before: original.candidateCueSha256, after: corrected.candidateCueSha256 }],
  ]);
  for (const member of GENERATED_RELEASE_MEMBERS) {
    const before = sha256(original.candidate.files[member]);
    const after = sha256(corrected.candidate.files[member]);
    if (before !== after) {
      expected.set(`${releasePath}/${member}`, { before, after });
    }
  }
  if (
    headChanges.length !== expected.size ||
    new Set(headChanges.map(({ path }) => path)).size !== expected.size
  ) {
    return false;
  }
  return headChanges.every(({ path, kind, before, after }) => {
    const change = expected.get(path);
    return [
      kind === "modified",
      change !== undefined,
      before?.digest === change?.before,
      after?.digest === change?.after,
      before?.mode === after?.mode,
      /^(?:644|100644)$/u.test(after?.mode ?? ""),
    ].every(Boolean);
  });
};

/**
 * Compare the original approved and corrected checked releases. The caller
 * supplies the exact owner-bound installed identity, verified Git history and
 * sealed draft changes. This check grants no authority to retrieve those inputs.
 */
export const verifyOptionalFieldCorrectionEquivalence = (input: {
  appId: string;
  original: ReleasePair;
  corrected: ReleasePair;
  installed: PredecessorIdentity;
  published: PredecessorIdentity;
  headChanges: readonly OverlayChange[];
}): boolean => {
  const { appId, original, corrected, installed, published } = input;
  if (
    ![
      original.prior.releaseId === corrected.prior.releaseId,
      original.candidate.releaseId === corrected.candidate.releaseId,
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(corrected.candidate.releaseId),
      original.priorCueSha256 !== corrected.priorCueSha256,
      original.candidateCueSha256 !== corrected.candidateCueSha256,
    ].every(Boolean)
  ) {
    return false;
  }
  const cuePath = `apps/${appId}/schema/${appId}.cue`;
  try {
    const oldPair = checkedOnlinePair(appId, original);
    const nextPair = checkedOnlinePair(appId, corrected);
    const sameActiveRelease =
      isDeepStrictEqual(nextPair.identity, installed) &&
      isDeepStrictEqual(nextPair.identity, published);
    const sameExistingSchema = isDeepStrictEqual(
      lowerCaseExistingLabels(oldPair.prior, oldPair.prior),
      lowerCaseExistingLabels(nextPair.prior, nextPair.prior),
    );
    const sameRequestedChange = isDeepStrictEqual(
      lowerCaseExistingLabels(oldPair.candidate, oldPair.prior),
      lowerCaseExistingLabels(nextPair.candidate, nextPair.prior),
    );
    const sameCompilerInputs = isDeepStrictEqual(
      compilerInputs(original.candidate, cuePath),
      compilerInputs(corrected.candidate, cuePath),
    );
    if (
      ![sameActiveRelease, sameExistingSchema, sameRequestedChange, sameCompilerInputs].every(
        Boolean,
      )
    ) {
      return false;
    }
    return matchesDraftChanges({ ...input, cuePath });
  } catch {
    return false;
  }
};
