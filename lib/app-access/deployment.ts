import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "../db/hosted-postgres";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createVercelWorkloadIdentity } from "../eve/vercel-workload-identity";
import { createHostedOperatorOwnerContextResolver } from "../provisioning/hosted-operator-owner-context";
import { createPostgresBuilderHandoffStore } from "../handoff/postgres-store";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { AppAccessError, appAccessErrorStatus } from "./errors";
import { createAppAccessOperatorClient } from "./operator-client";
import { createAppAccessRouteHandler } from "./route";
import { createAppAccessOwnerResolver } from "./owner";
import { reportRepositoryProductionFailure } from "../provisioning/repository-production-diagnostic";

const createDeployment = (environment: NodeJS.ProcessEnv) => {
  const config = readPreviewOAuthRuntimeConfig(environment);
  const endpoint = environment.REPOSITORY_PRODUCTION_OPERATOR_URL;
  if (endpoint === undefined || endpoint === "") {
    throw new AppAccessError("app_access_unavailable");
  }
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const sessions = createPostgresHostedEveStore(database);
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    issuer: config.issuer,
    audience: config.resource,
  });
  const resolveOwnerContext = createHostedOperatorOwnerContextResolver({
    issuer: config.issuer,
    audience: config.resource,
    sessions,
    handoffs: createPostgresBuilderHandoffStore(database),
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
    isActiveMember: (authority) => membership.isActiveMember(authority),
  });
  const operator = createAppAccessOperatorClient({
    endpoint,
    token: createVercelWorkloadIdentity().token,
  });
  return createAppAccessRouteHandler({
    origin: new URL(config.issuer).origin,
    ...operator,
    resolveOwner: createAppAccessOwnerResolver({
      sessions,
      resolveOwnerContext,
      authenticate: async (request) => {
        const signedIn = await ensurePreviewOAuthDeploymentSessionOrganization({
          headers: request.headers,
          environment,
        });
        if (signedIn === null || signedIn === undefined) {
          return null;
        }
        return {
          issuer: config.issuer,
          audience: config.resource,
          ownerUserId: signedIn.user.id,
          workspaceId: signedIn.organization.workspaceId,
        };
      },
    }),
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
    reportRepositoryProductionFailure("access_deployment", "binding_unavailable", error);
    const safe =
      error instanceof AppAccessError ? error : new AppAccessError("app_access_unavailable");
    return Response.json(
      { code: safe.code, message: safe.message },
      { status: appAccessErrorStatus(safe.code), headers: { "cache-control": "no-store" } },
    );
  }
};
