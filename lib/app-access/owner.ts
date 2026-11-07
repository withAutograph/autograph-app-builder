import type { HostedSessionTenantAuthority } from "../hosted/session-authority";
import { toDurableHostedSessionRecord } from "../eve/hosted-store";
import type { HostedEveStore } from "../eve/hosted-store";
import type { createHostedOperatorOwnerContextResolver } from "../provisioning/hosted-operator-owner-context";
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import { AppAccessError } from "./errors";
import type { AppAccessRouteOwner } from "./route";

/** The browser handle names a build; verified lineage chooses its protected grant and worker. */
export const createAppAccessOwnerResolver =
  (deps: {
    sessions: Pick<HostedEveStore, "getSession" | "readCurrentBuildSession">;
    authenticate: (request: Request) => Promise<HostedSessionTenantAuthority | null | undefined>;
    resolveOwnerContext: ReturnType<typeof createHostedOperatorOwnerContextResolver>;
  }) =>
  async (request: Request, publicSessionId: string): Promise<AppAccessRouteOwner> => {
    const authority = await deps.authenticate(request);
    if (authority === null || authority === undefined) {
      throw new AppAccessError("authentication_required");
    }
    const stored = await deps.sessions.getSession(
      { ...authority, scopes: ["autograph:session"] },
      publicSessionId,
    );
    if (stored === null) {
      throw new AppAccessError("app_access_denied");
    }
    const session = toDurableHostedSessionRecord(stored);
    if (
      session.appId === undefined ||
      (["issuer", "audience", "ownerUserId", "workspaceId"] as const).some(
        (key) => session.principal[key] !== authority[key],
      )
    ) {
      throw new AppAccessError("app_access_denied");
    }
    const authoritySessionId =
      session.nativeRecoveryBinding?.originalAuthoritySessionId ?? session.sessionId;
    const logicalSessionId =
      session.nativeRecoveryBinding?.logicalSessionId ?? session.adapterSessionId;
    const readCurrent = deps.sessions.readCurrentBuildSession;
    if (readCurrent === undefined) {
      throw new AppAccessError("app_access_unavailable");
    }
    const current = await readCurrent.call(deps.sessions, {
      principal: session.principal,
      authoritySessionId,
      logicalSessionId,
    });
    if (current.appId !== session.appId || current.sourceHandoffId !== session.sourceHandoffId) {
      throw new AppAccessError("app_access_denied");
    }
    const principal = session.principal;
    const forwarded = {
      attributes: {
        "mcp:audience": principal.audience,
        "mcp:scopes": principal.scopes,
        "mcp:workspace-id": principal.workspaceId,
        ...(current.sourceHandoffId === undefined
          ? {}
          : {
              "autograph:source-handoff-id": current.sourceHandoffId,
            }),
      },
      authenticator: "mcp-oauth-jwks",
      issuer: principal.issuer,
      principalId: principal.ownerUserId,
      principalType: "user",
      subject: principal.ownerUserId,
    };
    let ownerContext: OperatorOwnerContext;
    try {
      ownerContext = await deps.resolveOwnerContext({
        adapterSessionId: current.adapterSessionId,
        authority,
        principal,
        sessionAuth: { current: forwarded, initiator: forwarded },
      });
    } catch (error) {
      if (error instanceof HostedOperatorError && error.code === "authorization_required") {
        throw new AppAccessError("app_access_denied");
      }
      throw error;
    }
    if (
      ownerContext.sessionId !== authoritySessionId ||
      ownerContext.adapterSessionId !== current.adapterSessionId ||
      ownerContext.adapterGeneration !== current.adapterGeneration
    ) {
      throw new AppAccessError("app_access_denied");
    }
    return {
      publicSessionId,
      operatorOwner: { appId: session.appId, sessionId: ownerContext.sessionId, ownerContext },
    };
  };
