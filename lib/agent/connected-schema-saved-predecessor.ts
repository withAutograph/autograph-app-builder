import { z } from "zod";
import type { CompiledOperatorReleaseSelection } from "../provisioning/hosted-operator-artifact-selection";
import { readOptionalTextReleasePredecessor } from "../provisioning/repository-production-schema-revision";
import { readExactCompiledOperatorReleaseForSession } from "./compiled-operator-artifacts";
import type { CompiledOperatorArtifactSessionInput } from "./compiled-operator-artifacts";
import {
  canonicalSchemaPredecessorState,
  compiledSchemaPredecessorState,
} from "./schema-predecessor-state";

interface CompiledPredecessor {
  releaseId: string;
  artifactSha256: string;
  previousManifestSha256?: string;
  onlineProof: boolean;
}

const captureManifest = z.looseObject({
  sources: z.record(z.string(), z.string()),
});

const distinctManifest = (selections: readonly CompiledOperatorReleaseSelection[]) => {
  const manifests = new Set(selections.map(({ manifestSha256 }) => manifestSha256));
  return manifests.size === 1 ? [...manifests][0] : undefined;
};

/** Recover the compiled cut's original checked predecessor without using the private runtime. */
export const readConnectedSchemaSavedPredecessor = async ({
  expectedCueSha256,
  ...input
}: CompiledOperatorArtifactSessionInput & { expectedCueSha256: string }): Promise<{
  candidate: CompiledOperatorReleaseSelection;
  prior?: CompiledPredecessor;
} | null> => {
  const saved = compiledSchemaPredecessorState.get()[input.appId];
  const candidate = saved?.compiled;
  if (candidate?.appId !== input.appId || candidate.appSpecDigest !== input.appSpecDigest) {
    return null;
  }

  try {
    const captured = await readExactCompiledOperatorReleaseForSession({
      ...input,
      lookup: { artifactRef: candidate.artifactRef, appSpecDigest: candidate.appSpecDigest },
    });
    if (captured === undefined) {
      return null;
    }
    const { selection } = captured;
    const exactCapture = [
      selection.appId === candidate.appId,
      selection.artifactRef === candidate.artifactRef,
      selection.appSpecDigest === candidate.appSpecDigest,
      selection.releaseId === candidate.releaseId,
      selection.manifestSha256 === candidate.manifestSha256,
      selection.schemaSha256 === candidate.schemaSha256,
    ].every(Boolean);
    if (!exactCapture) {
      return null;
    }
    const manifest = captureManifest.parse(
      JSON.parse(captured.files["release-manifest.json"].toString("utf-8")),
    );
    const cuePath = `apps/${input.appId}/schema/${input.appId}.cue`;
    if (manifest.sources[cuePath] !== `sha256:${expectedCueSha256}`) {
      return null;
    }
    const nonSelf = saved.predecessors.filter(
      (entry) => entry.appId === input.appId && entry.releaseId !== candidate.releaseId,
    );
    const proof = readOptionalTextReleasePredecessor(captured.files);
    let prior: CompiledPredecessor | undefined;
    if (proof !== null && proof.releaseId !== candidate.releaseId) {
      const matches = (entry: CompiledOperatorReleaseSelection) =>
        entry.appId === input.appId &&
        entry.releaseId === proof.releaseId &&
        entry.schemaSha256 === proof.artifactSha256;
      const savedMatches = nonSelf.filter(matches);
      const previousManifestSha256 = distinctManifest(
        savedMatches.length > 0
          ? savedMatches
          : canonicalSchemaPredecessorState.get().filter(matches),
      );
      prior = { ...proof, onlineProof: true, previousManifestSha256 };
    } else if (proof === null && nonSelf.length === 1) {
      const [entry] = nonSelf;
      prior = {
        releaseId: entry.releaseId,
        artifactSha256: entry.schemaSha256,
        previousManifestSha256: entry.manifestSha256,
        onlineProof: false,
      };
    }
    input.signal?.throwIfAborted();
    return { candidate, prior };
  } catch {
    input.signal?.throwIfAborted();
    return null;
  }
};
