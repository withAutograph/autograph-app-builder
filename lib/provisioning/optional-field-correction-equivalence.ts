import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { addOptionalTextField } from "../repository/optional-text-field";
import type { OverlayChange } from "../repository/target-apply";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import {
  assertOptionalTextProductionTransition,
  readOptionalTextReleasePredecessor,
  readTransitionForRecoveredOptionalField,
} from "./repository-production-schema-revision";

type Transition = Parameters<typeof assertOptionalTextProductionTransition>[0];
type ReleasePair = Omit<Transition, "appId">;
type OriginalRelease = Omit<ReleasePair, "prior"> & {
  prior?: ReleasePair["prior"] | undefined;
};

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
const sha256 = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");

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

const changedExistingLabels = (prior: Artifact, candidate: Artifact) =>
  prior.schema.models.flatMap((model) => {
    const candidateModel = candidate.schema.models.find(({ id }) => id === model.id);
    return model.fields.flatMap(({ id, label }) => {
      const found = candidateModel?.fields.find((field) => field.id === id)?.label;
      return found === undefined || found === label ? [] : [{ canonical: label, stale: found }];
    });
  });

const replaceSingleLabel = (bytes: Buffer, labels: { canonical: string; stale: string }) => {
  const raw = bytes.toString("utf-8");
  if (!Buffer.from(raw).equals(bytes)) {
    throw new Error("The checked label source is not UTF-8.");
  }
  const canonical = JSON.stringify(labels.canonical);
  const index = raw.indexOf(canonical);
  if (index === -1 || index !== raw.lastIndexOf(canonical)) {
    throw new Error("The checked label does not have a unique literal.");
  }
  return raw.slice(0, index) + JSON.stringify(labels.stale) + raw.slice(index + canonical.length);
};

const recoverOriginalPair = (input: {
  appId: string;
  original: OriginalRelease;
  corrected: ReleasePair;
  canonicalCue: Buffer;
  canonicalPrior: Artifact;
}) => {
  const { appId, original, corrected, canonicalCue, canonicalPrior } = input;
  const candidate = readArtifact(original.candidate);
  const changes = changedExistingLabels(canonicalPrior, candidate);
  const [labels] = changes;
  if (
    changes.length !== 1 ||
    labels === undefined ||
    labels.canonical.toLowerCase() !== labels.stale.toLowerCase()
  ) {
    throw new Error("The original draft must differ by exactly one existing label's casing.");
  }
  const staleCue = replaceSingleLabel(canonicalCue, labels);
  if (
    sha256(canonicalCue) !== corrected.priorCueSha256 ||
    sha256(staleCue) !== original.priorCueSha256
  ) {
    throw new Error("The deterministic predecessor source does not match the reviewed CUE.");
  }
  const recoveredArtifact = Buffer.from(
    replaceSingleLabel(corrected.prior.files["app-artifact.json"], labels),
  );
  const field = readTransitionForRecoveredOptionalField({
    appId,
    publishedPrior: corrected.prior,
    publishedPriorCueSha256: corrected.priorCueSha256,
    recoveredArtifact,
    candidate: original.candidate,
    candidateCueSha256: original.candidateCueSha256,
  });
  const replay = (cue: string, pair: OriginalRelease) => {
    const result = addOptionalTextField(cue, field);
    return (
      result.releaseId === pair.candidate.releaseId &&
      sha256(result.content) === pair.candidateCueSha256
    );
  };
  if (!replay(staleCue, original) || !replay(canonicalCue.toString("utf-8"), corrected)) {
    throw new Error("The reviewed addition cannot be replayed exactly against both predecessors.");
  }
  const prior = artifactSchema.parse(JSON.parse(recoveredArtifact.toString("utf-8")));
  return { prior, candidate };
};

const readOriginalPair = (
  input: Parameters<typeof verifyOptionalFieldCorrectionEquivalence>[0],
  canonicalPrior: Artifact,
) => {
  const { appId, original, corrected, publishedPriorCue } = input;
  const { prior } = original;
  if (prior === undefined) {
    return publishedPriorCue === undefined
      ? null
      : recoverOriginalPair({
          appId,
          original,
          corrected,
          canonicalPrior,
          canonicalCue: publishedPriorCue,
        });
  }
  return checkedOnlinePair(appId, { ...original, prior });
};

const matchesDraftChanges = (input: {
  appId: string;
  cuePath: string;
  original: OriginalRelease;
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
  original: OriginalRelease;
  corrected: ReleasePair;
  installed: PredecessorIdentity;
  published: PredecessorIdentity;
  headChanges: readonly OverlayChange[];
  publishedPriorCue?: Buffer | undefined;
}): boolean => {
  const { appId, original, corrected, installed, published } = input;
  if (
    ![
      original.prior === undefined || original.prior.releaseId === corrected.prior.releaseId,
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
    const nextPair = checkedOnlinePair(appId, corrected);
    const sameActiveRelease =
      isDeepStrictEqual(nextPair.identity, installed) &&
      isDeepStrictEqual(nextPair.identity, published);
    if (!sameActiveRelease) {
      return false;
    }
    const oldPair = readOriginalPair(input, nextPair.prior);
    if (oldPair === null) {
      return false;
    }
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
    if (![sameExistingSchema, sameRequestedChange, sameCompilerInputs].every(Boolean)) {
      return false;
    }
    return matchesDraftChanges({ ...input, cuePath });
  } catch {
    return false;
  }
};
