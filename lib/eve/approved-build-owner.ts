import type { DurableHostedSessionRecord } from "./hosted-store";

interface ForwardedOwnerAttributes {
  "mcp:audience": string;
  "mcp:scopes": readonly string[];
  "mcp:workspace-id": string;
  "autograph:source-handoff-id"?: string;
}

/** Uses the previously authenticated canonical principal only to re-resolve live session and membership ownership. */
export const assertHostedBuildDecisionOwner = async (
  session: DurableHostedSessionRecord,
): Promise<void> => {
  const { principal } = session;
  const attributes: ForwardedOwnerAttributes = {
    "mcp:audience": principal.audience,
    "mcp:scopes": principal.scopes,
    "mcp:workspace-id": principal.workspaceId,
  };
  if (session.sourceHandoffId !== undefined) {
    attributes["autograph:source-handoff-id"] = session.sourceHandoffId;
  }
  const auth = {
    attributes,
    authenticator: "mcp-oauth-jwks",
    issuer: principal.issuer,
    principalId: principal.ownerUserId,
    principalType: "user",
    subject: principal.ownerUserId,
  };
  const { resolveHostedOperatorOwnerContext } =
    await import("../provisioning/hosted-operator-owner-context");
  const owner = await resolveHostedOperatorOwnerContext({
    adapterSessionId: session.adapterSessionId,
    authority: principal,
    environment: process.env,
    principal,
    sessionAuth: { current: auth, initiator: auth },
  });
  if (
    owner.sessionId !== session.sessionId ||
    owner.adapterGeneration !== session.adapterGeneration
  ) {
    throw new Error("Approved build continuation ownership changed.");
  }
};
