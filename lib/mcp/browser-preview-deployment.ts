import { getPreviewOAuthDeploymentAuth } from "../auth/preview-oauth-deployment";
import { getPrototypeChunk } from "../agent/postgres-prototype-chunks";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createHostedEveSessionService } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import { createPostgresHostedEveStore } from "../eve/postgres-hosted-store";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { createEveSessionService } from "../eve/service";
import type { EveSessionService } from "../eve/service";
import {
  createPrototypePreviewRequestHandler,
  createServicePrototypePreviewResolver,
} from "./browser-preview";
import { openHostedPostgresDatabase } from "./hosted-route";

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function adapterMode(environment: Environment): "local" | "hosted" | "unavailable" {
  const local = environment.APP_BUILDER_LOCAL_ADAPTER;
  const hosted = environment.EVE_HOSTED_ADAPTER;
  if (![undefined, "0", "1"].includes(local)) {
    return "unavailable";
  }
  if (![undefined, "0", "1"].includes(hosted)) {
    return "unavailable";
  }
  if (local === "1" && hosted === "1") {
    return "unavailable";
  }
  if (hosted === "1") {
    return "hosted";
  }
  if (local === "1") {
    return "local";
  }
  return "unavailable";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createDeploymentPrototypePreviewRequestHandler(input: {
  environment: Environment;
  workloadIdentity: HostedWorkloadIdentity;
  fetchImplementation?: typeof fetch;
  serviceForRequest?: (request: Request) => Promise<EveSessionService | undefined>;
}) {
  let hosted:
    | {
        origin: string;
        issuer: string;
        audience: string;
        auth: ReturnType<typeof getPreviewOAuthDeploymentAuth>;
        membership: ReturnType<typeof createPostgresPreviewOrganizationAuthority>;
        database: ReturnType<typeof openHostedPostgresDatabase>;
        store: ReturnType<typeof createPostgresHostedEveStore>;
        transport: HostedEveTransport;
      }
    | undefined;

  const hostedContextForRequest = async (request: Request) => {
    if (hosted === undefined) {
      const config = readPreviewOAuthRuntimeConfig(input.environment);
      const database = openHostedPostgresDatabase(config.databaseUrl);
      const store = createPostgresHostedEveStore(database);
      hosted = {
        audience: config.resource,
        auth: getPreviewOAuthDeploymentAuth(input.environment),
        database,
        issuer: config.issuer,
        membership: createPostgresPreviewOrganizationAuthority(database, {
          audience: config.resource,
          issuer: config.issuer,
        }),
        origin: new URL(config.issuer).origin,
        store,
        transport: createSameOriginEveTransport({
          config: { baseUrl: new URL(config.resource).origin },
          fetchImplementation: input.fetchImplementation,
          async verifyReadAuthority({ principal, sessionId, adapterSessionId }) {
            const session = await store.getSession(principal, sessionId);
            return session !== null && session.adapterSessionId === adapterSessionId;
          },
          workloadIdentity: input.workloadIdentity,
        }),
      };
    }
    if (new URL(request.url).origin !== hosted.origin) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional context result.
      return undefined;
    }
    const session = await hosted.auth.api.getSession({
      headers: request.headers,
    });
    if (session?.user.id === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional context result.
      return undefined;
    }
    const workspaceId = await hosted.membership.activeWorkspaceForUser({
      audience: hosted.audience,
      issuer: hosted.issuer,
      ownerUserId: session.user.id,
    });
    if (workspaceId === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional context result.
      return undefined;
    }
    const principal = hostedPrincipalSchema.parse({
      audience: hosted.audience,
      issuer: hosted.issuer,
      ownerUserId: session.user.id,
      scopes: ["autograph:get", "autograph:session"],
      workspaceId,
    });
    const service = createHostedEveSessionService({
      principal,
      store: hosted.store,
      transport: hosted.transport,
    });
    return { database: hosted.database, principal, service };
  };

  const defaultServiceForRequest = async (
    request: Request,
  ): Promise<EveSessionService | undefined> => {
    const mode = adapterMode(input.environment);
    if (mode === "unavailable") {
      return undefined;
    }
    if (mode === "local") {
      return createEveSessionService(input.environment);
    }
    const context = await hostedContextForRequest(request);
    return context?.service;
  };

  return createPrototypePreviewRequestHandler({
    resolvePrototype: createServicePrototypePreviewResolver({
      serviceForRequest: input.serviceForRequest ?? defaultServiceForRequest,
    }),
    resolveStreamedPrototype: async ({ request, sessionId }) => {
      if (adapterMode(input.environment) !== "hosted") {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional resolver result.
        return undefined;
      }
      const context = await hostedContextForRequest(request);
      if (context === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional resolver result.
        return undefined;
      }
      const session = await context.service.get({ cursor: 0, limit: 1, sessionId });
      const artifact = session.prototypeRef;
      if (artifact === undefined || artifact.sessionId !== sessionId) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional resolver result.
        return undefined;
      }
      const key = {
        path: artifact.path,
        principal: context.principal,
        sessionId,
        transferDigest: artifact.digest,
      };
      return {
        artifact,
        readChunk: async (chunkIndex: number) =>
          await getPrototypeChunk(context.database, { ...key, chunkIndex }),
      };
    },
  });
}
