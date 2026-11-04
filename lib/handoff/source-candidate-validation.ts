import { createSourceArtifactStore } from "./source-artifacts";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import type { BuilderHandoffIntent, BuilderHandoffRecord } from "./contracts";
import { BuilderHandoffUnavailableError } from "./errors";

/** Both the browser pointer and the immutable stored bytes are independently checked. */
export const createSourceCandidateValidator = (
  database: Parameters<typeof createSourceArtifactStore>[0],
) => {
  const store = createSourceArtifactStore(database);
  return async (input: {
    authority: BuilderHandoffRecord["authority"];
    intent: BuilderHandoffIntent;
  }) => {
    const reference = input.intent.sourceCandidate;
    if (reference === undefined) {
      return;
    }
    const value = await store.readCompleted({ authority: input.authority, reference });
    if (value === undefined) {
      throw new BuilderHandoffUnavailableError();
    }
    const validated = validateApplicationSourceArtifact(value);
    if (
      validated.manifestDigest !== reference.manifestDigest ||
      validated.artifact.manifest.appId !== input.intent.appId ||
      reference.appId !== input.intent.appId
    ) {
      throw new BuilderHandoffUnavailableError();
    }
  };
};
