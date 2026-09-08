import { getPreviewOAuthDeploymentAuth } from "../auth/preview-oauth-deployment";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import {
  createHostedEveSessionService,
  type HostedEveTransport,
} from "../eve/hosted-service";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import {
  createSameOriginEveTransport,
  type HostedWorkloadIdentity,
} from "../eve/same-origin-http";
import {
  createEveSessionService,
  type EveSessionService,
} from "../eve/service";
import {
  createPrototypePreviewRequestHandler,
  createServicePrototypePreviewResolver,
} from "./browser-preview";
import { openHostedPostgresDatabase } from "./hosted-route";

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

function adapterMode(
  environment: Environment,
): "local" | "hosted" | "unavailable" {
  const local = environment.APP_BUILDER_LOCAL_ADAPTER;
  const hosted = environment.EVE_HOSTED_ADAPTER;
  if (![undefined, "0", "1"].includes(local)) return "unavailable";
  if (![undefined, "0", "1"].includes(hosted)) return "unavailable";
  if (local === "1" && hosted === "1") return "unavailable";
  if (hosted === "1") return "hosted";
  if (local === "1") return "local";
  return "unavailable";
}

export function createDeploymentPrototypePreviewRequestHandler(input: {
  environment: Environment;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
  serviceForRequest?: (
    request: Request,
  ) => Promise<EveSessionService | undefined>;
}) {
  let hosted:
    | {
        origin: string;
        issuer: string;
        audience: string;
        auth: ReturnType<typeof getPreviewOAuthDeploymentAuth>;
        membership: ReturnType<
          typeof createPostgresPreviewOrganizationAuthority
        >;
        store: ReturnType<typeof createPostgresHostedEveStore>;
        transport: HostedEveTransport;
      }
    | undefined;

  const defaultServiceForRequest = async (
    request: Request,
  ): Promise<EveSessionService | undefined> => {
    const mode = adapterMode(input.environment);
    if (mode === "unavailable") return undefined;
    if (mode === "local") return createEveSessionService(input.environment);

    if (hosted === undefined) {
      const config = readPreviewOAuthRuntimeConfig(input.environment);
      const database = openHostedPostgresDatabase(config.databaseUrl);
      hosted = {
        origin: new URL(config.issuer).origin,
        issuer: config.issuer,
        audience: config.resource,
        auth: getPreviewOAuthDeploymentAuth(input.environment),
        membership: createPostgresPreviewOrganizationAuthority(database, {
          issuer: config.issuer,
          audience: config.resource,
        }),
        store: createPostgresHostedEveStore(database),
        transport: createSameOriginEveTransport({
          config: { baseUrl: new URL(config.resource).origin },
          workloadIdentity: input.workloadIdentity,
          fetchImplementation: input.fetchImplementation,
        }),
      };
    }
    if (new URL(request.url).origin !== hosted.origin) return undefined;
    const session = await hosted.auth.api.getSession({
      headers: request.headers,
    });
    if (session?.user.id === undefined) return undefined;
    const workspaceId = await hosted.membership.activeWorkspaceForUser({
      issuer: hosted.issuer,
      audience: hosted.audience,
      ownerUserId: session.user.id,
    });
    if (workspaceId === undefined) return undefined;
    const principal = hostedPrincipalSchema.parse({
      issuer: hosted.issuer,
      audience: hosted.audience,
      workspaceId,
      ownerUserId: session.user.id,
      scopes: ["autograph:get", "autograph:session"],
    });
    return createHostedEveSessionService({
      principal,
      store: hosted.store,
      transport: hosted.transport,
    });
  };

  return createPrototypePreviewRequestHandler({
    resolvePrototype: createServicePrototypePreviewResolver({
      serviceForRequest: input.serviceForRequest ?? defaultServiceForRequest,
    }),
  });
}
