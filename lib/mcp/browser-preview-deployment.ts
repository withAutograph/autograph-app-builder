import { getPreviewOAuthDeploymentAuth } from "../auth/preview-oauth-deployment";
import { getPrototypeChunk } from "../agent/postgres-prototype-chunks";
import type { PrototypeChunkKey } from "../agent/postgres-prototype-chunks";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createHostedEveSessionService, HostedSessionNotFoundError } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import type { HostedEveStore } from "../eve/hosted-store";
import {
  createPostgresHostedEveStore,
  readCommittedRecoveryReceipt,
} from "../eve/postgres-hosted-store";
import { createSameOriginEveTransport } from "../eve/same-origin-http";
import type { HostedWorkloadIdentity } from "../eve/same-origin-http";
import { createEveSessionService } from "../eve/service";
import type { EveSessionService } from "../eve/service";
import {
  createPrototypePreviewRequestHandler,
  createServicePrototypePreviewResolver,
} from "./browser-preview";
import type { StreamedPrototypePreviewResolver } from "./browser-preview";
import { openHostedPostgresDatabase } from "./hosted-route";
import { createRealmContinuationRead } from "./realm-continuation-read";
import type { ResumeRealmContinuation } from "./realm-continuation-read";
import { recentDeliveryProgress } from "./contracts";

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

/** Context is supplied only after Browser authentication and active membership. */
interface OwnedPrototypePreviewContext {
  principal: HostedPrincipal;
  service: Pick<EveSessionService, "get">;
  store: Pick<HostedEveStore, "getSession">;
  readChunk: (key: PrototypeChunkKey) => Promise<string | undefined>;
}

export const createOwnedSessionStreamedPrototypePreviewResolver =
  (input: {
    contextForRequest: (request: Request) => Promise<OwnedPrototypePreviewContext | undefined>;
  }): StreamedPrototypePreviewResolver =>
  async ({ request, sessionId }) => {
    const context = await input.contextForRequest(request);
    if (context === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional resolver result explicit.
      return undefined;
    }
    const session = await context.service.get({ cursor: 0, limit: 1, sessionId });
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- get may recover the owned adapter; read its current binding afterwards.
    const stored = await context.store.getSession(context.principal, sessionId);
    const artifact = session.prototypeRef;
    if (stored === null || session.sessionId !== sessionId || stored.sessionId !== sessionId) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional resolver result explicit.
      return undefined;
    }
    const sameOwner =
      stored.principal.issuer === context.principal.issuer &&
      stored.principal.audience === context.principal.audience &&
      stored.principal.ownerUserId === context.principal.ownerUserId &&
      stored.principal.workspaceId === context.principal.workspaceId;
    if (!sameOwner || artifact === undefined) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional resolver result explicit.
      return undefined;
    }
    const recovery = stored.version === 2 ? stored.nativeRecoveryBinding : undefined;
    const recoveredLogicalArtifact =
      // oxlint-disable-next-line sonarjs/expression-complexity -- Retain every owner and logical artifact comparison.
      stored.version === 2 &&
      recovery !== undefined &&
      recovery.ownerRunId === stored.adapterSessionId &&
      recovery.sourcePublicSessionId === stored.parentSessionId &&
      artifact.sessionId === recovery.logicalSessionId;
    const adapterBound =
      artifact.sessionId === stored.adapterSessionId ||
      (stored.version === 2 && artifact.sessionId === stored.originAdapterSessionId) ||
      recoveredLogicalArtifact;
    if (!adapterBound) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep the optional resolver result explicit.
      return undefined;
    }
    // Keep the original manifest immutable. Same-handle adapter recovery may
    // retain artifacts from its recorded origin. A recovery child's canonical
    // binding also retains its original logical owner; parent IDs alone do not.
    return {
      artifact,
      authorizedSessionAlias: { artifactSessionId: artifact.sessionId, publicSessionId: sessionId },
      readChunk: async (chunkIndex) =>
        await context.readChunk({
          chunkIndex,
          path: artifact.path,
          principal: context.principal,
          sessionId: artifact.sessionId,
          transferDigest: artifact.digest,
        }),
    };
  };

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
  resumeRealmContinuation?: ResumeRealmContinuation;
}) {
  const beforeRead = createRealmContinuationRead({
    environment: input.environment,
    resume: input.resumeRealmContinuation,
  });
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
      beforeRead,
      principal,
      store: hosted.store,
      transport: hosted.transport,
    });
    return { database: hosted.database, principal, service, store: hosted.store };
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

  const preview = createPrototypePreviewRequestHandler({
    resolvePrototype: createServicePrototypePreviewResolver({
      serviceForRequest: input.serviceForRequest ?? defaultServiceForRequest,
    }),
    resolveStreamedPrototype: createOwnedSessionStreamedPrototypePreviewResolver({
      contextForRequest: async (request) => {
        if (adapterMode(input.environment) !== "hosted") {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional resolver result.
          return undefined;
        }
        const context = await hostedContextForRequest(request);
        if (context === undefined) {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Keep a consistent optional resolver result.
          return undefined;
        }
        return {
          ...context,
          readChunk: async (key) => await getPrototypeChunk(context.database, key),
        };
      },
    }),
  });
  return Object.assign(preview, {
    async readDeliveryProgress(request: Request, sessionId: string) {
      const headers = { "cache-control": "no-store" };
      try {
        if (adapterMode(input.environment) !== "hosted") {
          return new Response(null, { status: 404, headers });
        }
        const context = await hostedContextForRequest(request);
        if (context === undefined) {
          return new Response(null, { status: 404, headers });
        }
        const cutoff = Number(new URL(request.url).searchParams.get("after") ?? 0);
        if (!Number.isSafeInteger(cutoff) || cutoff < 0) {
          return new Response(null, { status: 400, headers });
        }
        // Refresh the one owned session, then use its immutable checkpoint
        // to search newest-first. Each earlier page is read only when needed.
        const observed = await context.service.get({ sessionId, cursor: cutoff, limit: 1 });
        // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Read the session binding after its checkpoint refresh settles.
        const stored = await context.store.getSession(context.principal, sessionId);
        if (observed.sessionId !== sessionId || stored === null) {
          return new Response(null, { status: 404, headers });
        }
        if (observed.error !== undefined) {
          return new Response(null, { status: 503, headers });
        }
        const { checkpoint, checkpointRef } = stored.version === 2 ? stored : {};
        const readPage = context.store.readCheckpointPage;
        const eventCount =
          checkpointRef?.eventCount ?? (checkpoint?.events.at(-1)?.index ?? -1) + 1;
        const firstIndex = cutoff <= eventCount ? cutoff : 0;
        let delivery = recentDeliveryProgress(
          checkpoint?.events.filter((event) => event.index >= firstIndex) ?? observed.events,
        )?.delivery;
        if (checkpointRef !== undefined && readPage !== undefined) {
          for (let end = eventCount; end > firstIndex;) {
            const cursor = Math.max(firstIndex, end - 100);
            // oxlint-disable-next-line eslint/no-await-in-loop -- Newest pages are searched first; stop when a delivery event is found.
            const page = await readPage.call(context.store, {
              principal: context.principal,
              sessionId,
              checkpointRef,
              cursor,
              limit: end - cursor,
            });
            if (page.checkpointDigest !== checkpointRef.digest || page.totalEvents !== eventCount) {
              return new Response(null, { status: 503, headers });
            }
            delivery = recentDeliveryProgress(page.events)?.delivery;
            if (delivery !== undefined) {
              break;
            }
            end = cursor;
          }
        }
        return Response.json(
          {
            cursor: eventCount,
            delivery,
            working: observed.status === "working",
          },
          { headers },
        );
      } catch (error) {
        const status = error instanceof HostedSessionNotFoundError ? 404 : 503;
        return new Response(null, { status, headers });
      }
    },
    async readRecoveryReceipt(
      request: Request,
      selection: { sessionId: string; logicalSessionId: string; ownerRunId: string },
    ) {
      const headers = { "cache-control": "no-store" };
      try {
        if (adapterMode(input.environment) !== "hosted") {
          return new Response(null, { status: 404, headers });
        }
        const context = await hostedContextForRequest(request);
        if (context === undefined) {
          return new Response(null, { status: 404, headers });
        }
        const receipt = await readCommittedRecoveryReceipt(context.database, {
          principal: context.principal,
          authoritySessionId: selection.sessionId,
          logicalSessionId: selection.logicalSessionId,
          ownerRunId: selection.ownerRunId,
        });
        if (receipt === null) {
          return new Response(null, { status: 404, headers });
        }
        return Response.json(
          {
            operationId: receipt.operationId,
            logicalSessionId: receipt.logicalSessionId,
            sourceOwnerRunId: receipt.sourceOwnerRunId,
            ownerRunId: receipt.ownerRunId,
            checkpointOwnerRunId: receipt.provenance.checkpointOwnerRunId,
            sourceCheckpointDigest: receipt.executionTransfer?.sourceCheckpointDigest,
          },
          { headers },
        );
      } catch {
        return new Response(null, { status: 404, headers });
      }
    },
  });
}
