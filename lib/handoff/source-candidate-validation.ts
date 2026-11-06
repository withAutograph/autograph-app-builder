import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { createSourceArtifactStore } from "./source-artifacts";
import { validateApplicationSourceArtifact } from "./application-source-bytes";
import type { BuilderHandoffIntent, BuilderHandoffRecord } from "./contracts";
import { BuilderHandoffUnavailableError } from "./errors";

/** Both the browser pointer and the immutable stored bytes are independently checked. */
export const createOwnedSourceCandidateValidator =
  (inputPorts: {
    readCompleted: ReturnType<typeof createSourceArtifactStore>["readCompleted"];
    isActiveMember: (authority: BuilderHandoffRecord["authority"]) => Promise<boolean>;
  }) =>
  async (input: { authority: BuilderHandoffRecord["authority"]; intent: BuilderHandoffIntent }) => {
    const reference = input.intent.sourceCandidate;
    if (reference === undefined) {
      return;
    }
    if (!(await inputPorts.isActiveMember(input.authority))) {
      throw new BuilderHandoffUnavailableError();
    }
    const value = await inputPorts.readCompleted({ authority: input.authority, reference });
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
    // The immutable artifact read can outlast membership. Recheck immediately before
    // handing it to creation/redemption; this is not a cross-store transaction.
    if (!(await inputPorts.isActiveMember(input.authority))) {
      throw new BuilderHandoffUnavailableError();
    }
  };

export const createSourceCandidateValidator = (
  database: Parameters<typeof createSourceArtifactStore>[0],
) =>
  createOwnedSourceCandidateValidator({
    isActiveMember: async (authority) =>
      await createPostgresPreviewOrganizationAuthority(database, {
        audience: authority.audience,
        issuer: authority.issuer,
      }).isActiveMember(authority),
    readCompleted: async (selection) =>
      await createSourceArtifactStore(database).readCompleted(selection),
  });
