import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "../db/hosted-postgres";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { toDurableHostedSessionRecord } from "../eve/hosted-store";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { operatorOwnerContextSchema } from "../provisioning/hosted-operator-contract";
import { AppAccessError, appAccessErrorStatus } from "./errors";
import { createAppAccessOperatorClient } from "./operator-client";
import { createAppAccessRouteHandler } from "./route";

const createDeployment = (environment: NodeJS.ProcessEnv) => {
  const config = readPreviewOAuthRuntimeConfig(environment);
  const endpoint = environment.REPOSITORY_PRODUCTION_OPERATOR_URL;
  if (endpoint === undefined || endpoint === "") {
    throw new AppAccessError("app_access_unavailable");
  }
  const sessions = createPostgresHostedEveStore(openHostedPostgresDatabase(config.databaseUrl));
  const operator = createAppAccessOperatorClient({
    endpoint,
    token: createVercelWorkloadIdentity().token,
  });
  return createAppAccessRouteHandler({
    origin: new URL(config.issuer).origin,
    ...operator,
    resolveOwner: async (request, sessionId) => {
      const signedIn = await ensurePreviewOAuthDeploymentSessionOrganization({
        headers: request.headers,
        environment,
      });
      if (signedIn === null || signedIn === undefined) {
        throw new AppAccessError("authentication_required");
      }
      const authority = {
        issuer: config.issuer,
        audience: config.resource,
        ownerUserId: signedIn.user.id,
        workspaceId: signedIn.organization.workspaceId,
      };
      const stored = await sessions.getSession(
        { ...authority, scopes: ["autograph:session"] },
        sessionId,
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
      // The operator independently reads this canonical session and checks current workspace authority.
      const ownerContext = operatorOwnerContextSchema.parse({
        authority,
        principal: session.principal,
        sessionId: session.sessionId,
        adapterSessionId: session.adapterSessionId,
        adapterGeneration: session.adapterGeneration,
        ...(session.sourceHandoffId === undefined
          ? { kind: "direct" }
          : { kind: "handoff", sourceHandoffId: session.sourceHandoffId }),
      });
      return { appId: session.appId, sessionId: session.sessionId, ownerContext };
    },
  });
};
let handler: ReturnType<typeof createDeployment> | undefined;

export const handleBuilderAppAccess = async (
  request: Request,
  sessionId: string,
): Promise<Response> => {
  try {
    handler ??= createDeployment(process.env);
    return await handler(request, sessionId);
  } catch (error) {
    const safe =
      error instanceof AppAccessError ? error : new AppAccessError("app_access_unavailable");
    return Response.json(
      { code: safe.code, message: safe.message },
      { status: appAccessErrorStatus(safe.code), headers: { "cache-control": "no-store" } },
    );
  }
};
