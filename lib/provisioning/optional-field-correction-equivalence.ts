import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { addOptionalTextField } from "../repository/optional-text-field";
import type { OverlayChange } from "../repository/target-apply";
import { GENERATED_RELEASE_MEMBERS } from "./hosted-operator-sandbox-launcher";
import {
  assertCheckedOptionalFieldReleaseSource,
  assertOptionalTextProductionTransition,
  readOptionalTextReleasePredecessor,
  readTransitionForRecoveredOptionalField,
} from "./repository-production-schema-revision";

type Transition = Parameters<typeof assertOptionalTextProductionTransition>[0];
type ReleasePair = Omit<Transition, "appId">;
type OriginalRelease = Omit<ReleasePair, "prior"> & {
  prior?: ReleasePair["prior"] | undefined;
};
const recoveredArtifactFailure = "original-predecessor-artifact";
type RecoveredPairFailure =
  | "original-predecessor-cue"
  | typeof recoveredArtifactFailure
  | "deterministic-cue-replay";
export type OptionalFieldCorrectionFailure =
  | RecoveredPairFailure
  | "release-coordinates"
  | "corrected-release"
  | "installed-predecessor"
  | "original-archive"
  | "schema-equivalence"
  | "compiler-inputs"
  | "reviewed-head-diff"
  | "original-release-compatible";

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

class RecoveredPairError extends Error {
  readonly reason: RecoveredPairFailure;
  constructor(reason: RecoveredPairFailure, options?: ErrorOptions) {
    super(reason, options);
    this.name = "RecoveredPairError";
    this.reason = reason;
  }
}

const changedExistingLabels = (prior: Artifact, candidate: Artifact) =>
  prior.schema.models.flatMap((model) => {
    const candidateModel = candidate.schema.models.find(({ id }) => id === model.id);
    return model.fields.flatMap(({ id, label }) => {
      const found = candidateModel?.fields.find((field) => field.id === id)?.label;
      return found === undefined || found === label ? [] : [{ canonical: label, stale: found }];
    });
  });

const replaceSingleLabel = (
  bytes: Buffer,
  labels: { canonical: string; stale: string },
  failure: RecoveredPairFailure,
) => {
  const raw = bytes.toString("utf-8");
  if (!Buffer.from(raw).equals(bytes)) {
    throw new RecoveredPairError(failure);
  }
  const canonical = JSON.stringify(labels.canonical);
  const index = raw.indexOf(canonical);
  if (index === -1 || index !== raw.lastIndexOf(canonical)) {
    throw new RecoveredPairError(failure);
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
    throw new RecoveredPairError(recoveredArtifactFailure);
  }
  const staleCue = replaceSingleLabel(canonicalCue, labels, "original-predecessor-cue");
  if (
    sha256(canonicalCue) !== corrected.priorCueSha256 ||
    sha256(staleCue) !== original.priorCueSha256
  ) {
    throw new RecoveredPairError("original-predecessor-cue");
  }
  const recoveredArtifact = Buffer.from(
    replaceSingleLabel(
      corrected.prior.files["app-artifact.json"],
      labels,
      recoveredArtifactFailure,
    ),
  );
  let field: ReturnType<typeof readTransitionForRecoveredOptionalField>;
  try {
    field = readTransitionForRecoveredOptionalField({
      appId,
      publishedPrior: corrected.prior,
      publishedPriorCueSha256: corrected.priorCueSha256,
      recoveredArtifact,
      candidate: original.candidate,
      candidateCueSha256: original.candidateCueSha256,
    });
  } catch (error) {
    throw new RecoveredPairError(recoveredArtifactFailure, { cause: error });
  }
  const replay = (cue: string, pair: OriginalRelease) => {
    try {
      const result = addOptionalTextField(cue, field);
      return (
        result.releaseId === pair.candidate.releaseId &&
        sha256(result.content) === pair.candidateCueSha256
      );
    } catch {
      return false;
    }
  };
  if (!replay(staleCue, original) || !replay(canonicalCue.toString("utf-8"), corrected)) {
    throw new RecoveredPairError("deterministic-cue-replay");
  }
  const prior = artifactSchema.parse(JSON.parse(recoveredArtifact.toString("utf-8")));
  return { prior, candidate };
};

const readOriginalPair = (input: CorrectionEquivalenceInput, canonicalPrior: Artifact) => {
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
  const expected = new Map<string, { before: string; after: string }>();
  if (original.candidateCueSha256 !== corrected.candidateCueSha256) {
    expected.set(cuePath, {
      before: original.candidateCueSha256,
      after: corrected.candidateCueSha256,
    });
  }
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

interface CorrectionEquivalenceInput {
  appId: string;
  original: OriginalRelease;
  corrected: ReleasePair;
  installed: PredecessorIdentity;
  published: PredecessorIdentity;
  headChanges: readonly OverlayChange[];
  publishedPriorCue?: Buffer | undefined;
}

const readCheckedOnlineAddition = (appId: string, pair: ReleasePair) =>
  readTransitionForRecoveredOptionalField({
    appId,
    publishedPrior: pair.prior,
    publishedPriorCueSha256: pair.priorCueSha256,
    recoveredArtifact: pair.prior.files["app-artifact.json"],
    candidate: pair.candidate,
    candidateCueSha256: pair.candidateCueSha256,
  });

const originalHasCheckedOnlineAddition = (appId: string, pair: ReleasePair): boolean => {
  try {
    readCheckedOnlineAddition(appId, pair);
    return true;
  } catch {
    return false;
  }
};

/** Same approved CUE and app artifact, with only exact generated member changes. */
const checkGeneratedReleaseCorrection = (
  input: CorrectionEquivalenceInput,
  cuePath: string,
): OptionalFieldCorrectionFailure | null => {
  const { appId, original, corrected } = input;
  try {
    assertCheckedOptionalFieldReleaseSource({
      appId,
      release: original.candidate,
      cueSha256: original.candidateCueSha256,
    });
  } catch {
    return "original-archive";
  }
  try {
    readCheckedOnlineAddition(appId, corrected);
  } catch {
    return "corrected-release";
  }
  if (
    !original.candidate.files["app-artifact.json"].equals(
      corrected.candidate.files["app-artifact.json"],
    )
  ) {
    return "schema-equivalence";
  }
  if (
    !isDeepStrictEqual(
      compilerInputs(original.candidate, cuePath),
      compilerInputs(corrected.candidate, cuePath),
    )
  ) {
    return "compiler-inputs";
  }
  if (originalHasCheckedOnlineAddition(appId, { ...corrected, candidate: original.candidate })) {
    return "original-release-compatible";
  }
  return matchesDraftChanges({ ...input, cuePath }) ? null : "reviewed-head-diff";
};

const checkOptionalFieldCorrection = (
  input: CorrectionEquivalenceInput,
): OptionalFieldCorrectionFailure | null => {
  const { appId, original, corrected, installed, published } = input;
  const generatedOnly =
    original.priorCueSha256 === corrected.priorCueSha256 &&
    original.candidateCueSha256 === corrected.candidateCueSha256;
  const casingCorrection =
    original.priorCueSha256 !== corrected.priorCueSha256 &&
    original.candidateCueSha256 !== corrected.candidateCueSha256;
  if (
    ![
      original.prior === undefined || original.prior.releaseId === corrected.prior.releaseId,
      original.candidate.releaseId === corrected.candidate.releaseId,
      /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/u.test(corrected.candidate.releaseId),
      generatedOnly || casingCorrection,
    ].every(Boolean)
  ) {
    return "release-coordinates";
  }
  const cuePath = `apps/${appId}/schema/${appId}.cue`;
  let stage: OptionalFieldCorrectionFailure = "corrected-release";
  try {
    const nextPair = checkedOnlinePair(appId, corrected);
    const sameActiveRelease =
      isDeepStrictEqual(nextPair.identity, installed) &&
      isDeepStrictEqual(nextPair.identity, published);
    if (!sameActiveRelease) {
      return "installed-predecessor";
    }
    if (generatedOnly) {
      return checkGeneratedReleaseCorrection(input, cuePath);
    }
    stage = "original-archive";
    const oldPair = readOriginalPair(input, nextPair.prior);
    if (oldPair === null) {
      return stage;
    }
    stage = "schema-equivalence";
    const sameExistingSchema = isDeepStrictEqual(
      lowerCaseExistingLabels(oldPair.prior, oldPair.prior),
      lowerCaseExistingLabels(nextPair.prior, nextPair.prior),
    );
    const sameRequestedChange = isDeepStrictEqual(
      lowerCaseExistingLabels(oldPair.candidate, oldPair.prior),
      lowerCaseExistingLabels(nextPair.candidate, nextPair.prior),
    );
    if (!sameExistingSchema || !sameRequestedChange) {
      return stage;
    }
    stage = "compiler-inputs";
    const sameCompilerInputs = isDeepStrictEqual(
      compilerInputs(original.candidate, cuePath),
      compilerInputs(corrected.candidate, cuePath),
    );
    if (!sameCompilerInputs) {
      return stage;
    }
    stage = "reviewed-head-diff";
    return matchesDraftChanges({ ...input, cuePath }) ? null : stage;
  } catch (error) {
    return error instanceof RecoveredPairError ? error.reason : stage;
  }
};

/**
 * Compare the original approved and corrected checked releases. The caller
 * supplies the exact owner-bound installed identity, verified Git history and
 * sealed draft changes. This check grants no authority to retrieve those inputs.
 */
export const verifyOptionalFieldCorrectionEquivalence = (
  input: CorrectionEquivalenceInput,
  reportFailure?: (reason: OptionalFieldCorrectionFailure) => void,
): boolean => {
  const failure = checkOptionalFieldCorrection(input);
  if (failure === null) {
    return true;
  }
  reportFailure?.(failure);
  return false;
};
