import type { DurableHostedSessionRecord } from "./hosted-store";
import type { resolveHostedOperatorOwnerContext } from "../provisioning/hosted-operator-owner-context";

interface ForwardedOwnerAttributes {
  "mcp:audience": string;
  "mcp:scopes": readonly string[];
  "mcp:workspace-id": string;
  "autograph:source-handoff-id"?: string;
}

/** Uses the previously authenticated canonical principal only to re-resolve live session and membership ownership. */
export const assertHostedBuildDecisionOwner = async (
  session: DurableHostedSessionRecord,
  dependencies?: { resolveOwner: typeof resolveHostedOperatorOwnerContext },
): Promise<void> => {
  const { principal } = session;
  const authority = {
    audience: principal.audience,
    issuer: principal.issuer,
    ownerUserId: principal.ownerUserId,
    workspaceId: principal.workspaceId,
  };
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
  let resolveOwner = dependencies?.resolveOwner;
  if (resolveOwner === undefined) {
    const ownerContext = await import("../provisioning/hosted-operator-owner-context");
    resolveOwner = ownerContext.resolveHostedOperatorOwnerContext;
  }
  let owner;
  try {
    owner = await resolveOwner({
      adapterSessionId: session.adapterSessionId,
      authority,
      environment: process.env,
      principal,
      sessionAuth: { current: auth, initiator: auth },
    });
  } catch (error) {
    const { HostedOperatorError } = await import("../provisioning/hosted-operator-contract");
    let reason = "owner_context_invalid";
    if (error instanceof HostedOperatorError) {
      reason =
        error.code === "authorization_required" ? "ownership_denied" : "owner_context_unavailable";
    }
    console.info(JSON.stringify({ event: "app_builder.approved_build_owner_boundary", reason }));
    throw error;
  }
  if (
    owner.sessionId !== session.sessionId ||
    owner.adapterGeneration !== session.adapterGeneration
  ) {
    throw new Error("Approved build continuation ownership changed.");
  }
};
