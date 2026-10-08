import { defineState } from "eve/context";
import { readLocalOperatorArtifactAuthority } from "../provisioning/local-operator-artifact-store";
import type { LocalOperatorArtifactAuthority } from "../provisioning/hosted-operator-artifact-store";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import { appBuilderWorkflowState } from "./workflow-state";
import { createLocalValidationLogStore } from "../repository/local-validation-log-store";
import { createPostgresValidationLogStore } from "../repository/postgres-validation-log-store";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import type { ValidationLogStore } from "../repository/validation-log";

interface LocalLogSessionBinding {
  authority: LocalOperatorArtifactAuthority;
  sessionId: string;
}
const localBinding = defineState<LocalLogSessionBinding | null>(
  "autograph-app-builder.local-validation-log-owner.v1",
  () => null,
);
interface SessionLogInput {
  // oxlint-disable-next-line anti-slop/no-unknown-parameters -- Eve's auth envelope is parsed by the hosted boundary; local ownership comes from its real context and private runtime.
  sessionAuth: unknown;
  sessionId: string;
}
const localOwner = async (input: SessionLogInput, authority: LocalOperatorArtifactAuthority) => {
  if (!input.sessionId) {
    throw new Error("The private validation session is unavailable.");
  }
  const expected = { authority, sessionId: input.sessionId };
  if (localBinding.get() === null) {
    localBinding.update(() => expected);
  }
  const assertCurrentOwner = async () => {
    if (
      JSON.stringify(localBinding.get()) !== JSON.stringify(expected) ||
      JSON.stringify(await readLocalOperatorArtifactAuthority()) !== JSON.stringify(authority)
    ) {
      throw new Error("Private validation logs belong to another owner or session.");
    }
    const current = appBuilderWorkflowState.get();
    if ("applyReceipt" in current) {
      assertApprovedPrivateApplySession({
        appId: current.appSpec.appId,
        appSpecDigest: current.appSpec.digest,
        proposalDigest: current.proposal.digest,
        sessionId: input.sessionId,
        workspaceId: current.workspace.workspaceId,
      });
    }
  };
  await assertCurrentOwner();
  return assertCurrentOwner;
};
/** Local reads bind to actual Eve state and the verified private runtime; hosted reads retain their existing forwarded auth boundary. */
export const assertValidationLogSession = async (input: SessionLogInput): Promise<void> => {
  const authority = await readLocalOperatorArtifactAuthority();
  if (authority === undefined) {
    exactForwardedSessionAuthority(input.sessionAuth);
    return;
  }
  await localOwner(input, authority);
};
/** A tool caller cannot select the profile, filesystem root or owner. */
export const validationLogStoreForSession = async (
  input: SessionLogInput,
): Promise<ValidationLogStore> => {
  const authority = await readLocalOperatorArtifactAuthority();
  if (authority === undefined) {
    const databaseUrl = process.env.DATABASE_URL;
    if (databaseUrl === undefined || databaseUrl.length === 0) {
      throw new Error(
        "Durable validation log storage is unavailable. Configure the hosted database, then retry validation.",
      );
    }
    return createPostgresValidationLogStore({
      db: openHostedPostgresDatabase(databaseUrl),
      sessionAuth: input.sessionAuth,
      sessionId: input.sessionId,
    });
  }
  return await createLocalValidationLogStore({
    assertCurrentOwner: await localOwner(input, authority),
    authority,
    sessionId: input.sessionId,
  });
};
