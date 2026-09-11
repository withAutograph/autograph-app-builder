import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { deriveBuilderAppId } from "../provisioning/names";
import { createPostgresBuilderProvisionJournalStore } from "../provisioning/postgres-journal";
import type { BuilderProvisionJournalStore } from "../provisioning/journal";
import { createPostgresBuilderHandoffStore } from "./postgres-store";
import { activeBuilderModelIdSchema } from "../integrations/active-model";
import { builderHandoffDestinationSchema, type BuilderHandoffIntent } from "./contracts";
import {
  BuilderHandoffConflictError,
  BuilderHandoffUnavailableError,
  createBuilderHandoffService,
} from "./service";

const noStore = { "Cache-Control": "no-store" } as const;
const maximumRequestBytes = 64 * 1_024;

class BuilderHandoffRequestError extends Error {}

function hasCanonicalRequestOrigin(request: Request, origin: string) {
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === origin) return true;
  const canonicalUrl = new URL(origin);
  return (
    requestUrl.protocol === canonicalUrl.protocol &&
    request.headers.get("host") === canonicalUrl.host
  );
}

async function readBoundedJson(request: Request) {
  if (request.body === null) throw new BuilderHandoffRequestError();
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    bytes += next.value.byteLength;
    if (bytes > maximumRequestBytes) {
      await reader.cancel();
      throw new BuilderHandoffRequestError();
    }
    chunks.push(next.value);
  }
  const body = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  } catch {
    throw new BuilderHandoffRequestError();
  }
}

export const builderHandoffCreateRequestSchema = z
  .object({
    version: z.literal(1),
    creationRequestId: z.string().uuid(),
    destination: builderHandoffDestinationSchema.optional(),
    provisioningRequestId: z.string().uuid().optional(),
    appName: z.string().trim().min(1).max(120),
    repository: z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .max(100)
          .regex(/^[A-Za-z0-9._-]+$/u),
        private: z.boolean(),
      })
      .strict(),
    brief: z.string().trim().min(1).max(32_000),
    modelId: activeBuilderModelIdSchema,
    connections: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .strict();

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;
type HandoffService = ReturnType<typeof createBuilderHandoffService>;

export type BuilderHandoffPageData = {
  version: 1;
  handoffId: string;
  expiresAt: string;
  status: "prepared" | "continued" | "expired";
  intent: BuilderHandoffIntent;
  destination: "codex" | "cursor";
  cursorInstallReady: boolean;
  mcpUrl: string;
  /** Current journal revision when this handoff has provider work. */
  provisioningRevision?: number;
};

export function createBuilderHandoffRouteHandler(input: {
  origin: string;
  authorityForRequest: (request: Request) => Promise<Authority | undefined>;
  journal: BuilderProvisionJournalStore;
  handoffs: HandoffService;
}) {
  const { origin } = new URL(input.origin);
  return async (request: Request) => {
    try {
      if (
        request.method !== "POST" ||
        !hasCanonicalRequestOrigin(request, origin) ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
      )
        return Response.json({ error: "request_invalid" }, { status: 400, headers: noStore });
      const contentLength = request.headers.get("content-length");
      if (
        contentLength &&
        (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumRequestBytes)
      )
        return Response.json({ error: "request_invalid" }, { status: 400, headers: noStore });
      const authority = await input.authorityForRequest(request);
      if (!authority)
        return Response.json(
          { error: "authentication_required" },
          { status: 401, headers: noStore },
        );
      const body = builderHandoffCreateRequestSchema.parse(await readBoundedJson(request));
      const provision = body.provisioningRequestId
        ? await input.journal.read({
            authority,
            requestId: body.provisioningRequestId,
          })
        : undefined;
      if (body.provisioningRequestId && !provision)
        return Response.json({ error: "handoff_unavailable" }, { status: 404, headers: noStore });
      const github = provision?.record.response.github;
      const appName = provision?.record.request.appName ?? body.appName;
      const repository = provision?.record.request.repository ?? body.repository;
      const created = await input.handoffs.create({
        authority,
        creationRequestId: body.creationRequestId,
        intent: {
          ...(body.destination === undefined ? {} : { destination: body.destination }),
          appName,
          appId: provision?.record.response.appId ?? deriveBuilderAppId(appName),
          brief: body.brief,
          repository: {
            requestedName: repository.name,
            private: repository.private,
            ...(github?.status === "succeeded" ? { resolvedFullName: github.fullName } : {}),
          },
          modelId: body.modelId,
          connections: body.connections,
          ...(provision === undefined
            ? {}
            : {
                providers: provision.record.request.providers,
                provisioningRequestId: provision.requestId,
                provisioningRequestDigest: provision.requestDigest,
                provisioning: provision.record.response,
              }),
        },
      });
      return Response.json(
        {
          version: 1,
          handoffId: created.handoffId,
          expiresAt: created.expiresAt.toISOString(),
        },
        { headers: noStore },
      );
    } catch (error) {
      if (error instanceof BuilderHandoffRequestError || error instanceof z.ZodError)
        return Response.json({ error: "request_invalid" }, { status: 400, headers: noStore });
      if (error instanceof BuilderHandoffConflictError)
        return Response.json({ error: "request_id_conflict" }, { status: 409, headers: noStore });
      return Response.json({ error: "handoff_unavailable" }, { status: 503, headers: noStore });
    }
  };
}

function handoffErrorResponse(error: unknown) {
  if (error instanceof BuilderHandoffUnavailableError)
    return Response.json({ error: "handoff_unavailable" }, { status: 404, headers: noStore });
  if (error instanceof BuilderHandoffConflictError)
    return Response.json({ error: "request_id_conflict" }, { status: 409, headers: noStore });
  if (error instanceof BuilderHandoffRequestError || error instanceof z.ZodError)
    return Response.json({ error: "request_invalid" }, { status: 400, headers: noStore });
  return Response.json({ error: "handoff_unavailable" }, { status: 503, headers: noStore });
}

export function createBuilderHandoffStatusRouteHandler(input: {
  pageData: (request: Request, handoffId: string) => Promise<BuilderHandoffPageData | undefined>;
}) {
  return async (request: Request, handoffId: string) => {
    try {
      const data = await input.pageData(request, handoffId);
      return data
        ? Response.json(data, { headers: noStore })
        : Response.json({ error: "authentication_required" }, { status: 401, headers: noStore });
    } catch (error) {
      return handoffErrorResponse(error);
    }
  };
}

export function createBuilderHandoffRenewRouteHandler(input: {
  origin: string;
  authorityForRequest: (request: Request) => Promise<Authority | undefined>;
  handoffs: HandoffService;
}) {
  const { origin } = new URL(input.origin);
  return async (request: Request, handoffId: string) => {
    try {
      if (
        request.method !== "POST" ||
        !hasCanonicalRequestOrigin(request, origin) ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
      )
        throw new BuilderHandoffRequestError();
      const contentLength = request.headers.get("content-length");
      if (
        contentLength &&
        (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumRequestBytes)
      )
        throw new BuilderHandoffRequestError();
      const authority = await input.authorityForRequest(request);
      if (!authority)
        return Response.json(
          { error: "authentication_required" },
          { status: 401, headers: noStore },
        );
      const body = z
        .object({ creationRequestId: z.string().uuid() })
        .strict()
        .parse(await readBoundedJson(request));
      const renewed = await input.handoffs.renew({
        authority,
        handoffId,
        ...body,
      });
      return Response.json(
        {
          version: 1,
          handoffId: renewed.handoffId,
          expiresAt: renewed.expiresAt.toISOString(),
        },
        { headers: noStore },
      );
    } catch (error) {
      return handoffErrorResponse(error);
    }
  };
}

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;
const deploymentDatabases = new Map<string, ReturnType<typeof openHostedPostgresDatabase>>();

function deploymentContext(environment: Environment) {
  const preview = readPreviewOAuthRuntimeConfig(environment);
  let database = deploymentDatabases.get(preview.databaseUrl);
  if (!database) {
    database = openHostedPostgresDatabase(preview.databaseUrl);
    deploymentDatabases.set(preview.databaseUrl, database);
  }
  return {
    preview,
    database,
    handoffs: createBuilderHandoffService({
      store: createPostgresBuilderHandoffStore(database),
    }),
    async authorityForHeaders(headers: Headers) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment,
        headers,
      });
      return session
        ? hostedTenantAuthoritySchema.parse({
            issuer: preview.issuer,
            audience: preview.resource,
            workspaceId: session.organization.workspaceId,
            ownerUserId: session.user.id,
          })
        : undefined;
    },
  };
}

export async function getBuilderHandoffPageData(input: {
  environment: Environment;
  headers: Headers;
  handoffId: string;
}): Promise<BuilderHandoffPageData | undefined> {
  const context = deploymentContext(input.environment);
  const authority = await context.authorityForHeaders(input.headers);
  if (!authority) return undefined;
  const { status, record } = await context.handoffs.status({
    authority,
    handoffId: input.handoffId,
  });
  const currentProvisioning = record.intent.provisioningRequestId
    ? await createPostgresBuilderProvisionJournalStore(context.database).read({
        authority,
        requestId: record.intent.provisioningRequestId,
      })
    : undefined;
  const { isCursorClientReady } = await import("../auth/cursor-client");
  return {
    version: 1,
    handoffId: record.handoffId,
    expiresAt: record.expiresAt.toISOString(),
    status,
    intent: currentProvisioning
      ? { ...record.intent, provisioning: currentProvisioning.record.response }
      : record.intent,
    destination: record.intent.destination ?? "codex",
    cursorInstallReady: await isCursorClientReady(context.database, context.preview.resource),
    mcpUrl: context.preview.resource,
    ...(currentProvisioning ? { provisioningRevision: currentProvisioning.revision } : {}),
  };
}

/**
 * Finds only a still-pending, owner-scoped provisioning handoff. The builder
 * uses this to resume durable provider work; settled and provider-less
 * handoffs deliberately return users to a fresh builder.
 */
export async function findAuthenticatedPendingBuilderHandoff(input: {
  environment: Environment;
  headers: Headers;
}): Promise<{ handoffId: string } | undefined> {
  const context = deploymentContext(input.environment);
  const authority = await context.authorityForHeaders(input.headers);
  if (!authority) return undefined;
  const record = await context.handoffs.findLatestPending({ authority });
  return record ? { handoffId: record.handoffId } : undefined;
}

export function getBuilderHandoffStatusDeploymentHandler(environment: Environment) {
  return createBuilderHandoffStatusRouteHandler({
    pageData: (request, handoffId) =>
      getBuilderHandoffPageData({
        environment,
        headers: request.headers,
        handoffId,
      }),
  });
}

export function getBuilderHandoffRenewDeploymentHandler(environment: Environment) {
  // Compose inside the error boundary so setup failures also remain no-store.
  return async (request: Request, handoffId: string) => {
    try {
      const context = deploymentContext(environment);
      return await createBuilderHandoffRenewRouteHandler({
        origin: new URL(context.preview.issuer).origin,
        handoffs: context.handoffs,
        authorityForRequest: (request) => context.authorityForHeaders(request.headers),
      })(request, handoffId);
    } catch (error) {
      return handoffErrorResponse(error);
    }
  };
}

export function getBuilderHandoffDeploymentHandler(environment: Environment) {
  const context = deploymentContext(environment);
  return createBuilderHandoffRouteHandler({
    origin: new URL(context.preview.issuer).origin,
    journal: createPostgresBuilderProvisionJournalStore(context.database),
    handoffs: context.handoffs,
    authorityForRequest: (request) => context.authorityForHeaders(request.headers),
  });
}
