import { sourceCandidateReferenceSchema } from "./application-source-contract";
import { createSourceCandidateValidator } from "./source-candidate-validation";
import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import type { isCursorClientReady } from "../auth/cursor-client";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { deriveBuilderAppId } from "../provisioning/names";
import { createPostgresBuilderProvisionJournalStore } from "../provisioning/postgres-journal";
import type { BuilderProvisionJournalStore } from "../provisioning/journal";
import { createPostgresBuilderHandoffStore } from "./postgres-store";
import type { BuilderHandoffStore } from "./service";
import { activeBuilderModelIdSchema } from "../integrations/active-model";
import { builderHandoffDestinationSchema } from "./contracts";
import type { BuilderHandoffIntent } from "./contracts";
import {
  BuilderHandoffConflictError,
  BuilderHandoffUnavailableError,
  createBuilderHandoffService,
} from "./service";

const noStore = { "Cache-Control": "no-store" } as const;
const maximumRequestBytes = 64 * 1024;

class BuilderHandoffRequestError extends Error {
  name = "BuilderHandoffRequestError";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function hasCanonicalRequestOrigin(request: Request, origin: string) {
  const requestUrl = new URL(request.url);
  if (requestUrl.origin === origin) {
    return true;
  }
  const canonicalUrl = new URL(origin);
  return (
    requestUrl.protocol === canonicalUrl.protocol &&
    request.headers.get("host") === canonicalUrl.host
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readBoundedJson(request: Request) {
  if (request.body === null) {
    throw new BuilderHandoffRequestError();
  }
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const next = await reader.read();
    if (next.done) {
      break;
    }
    bytes += next.value.byteLength;
    if (bytes > maximumRequestBytes) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
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
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    return parsed;
  } catch {
    throw new BuilderHandoffRequestError();
  }
}

export const builderHandoffCreateRequestSchema = z.strictObject({
  appName: z.string().trim().min(1).max(120),
  brief: z.string().trim().min(1).max(32_000),
  connections: z.array(z.string().trim().min(1).max(100)).max(50),
  creationRequestId: z.uuid(),
  destination: builderHandoffDestinationSchema.optional(),
  sourceCandidate: sourceCandidateReferenceSchema.optional(),
  modelId: activeBuilderModelIdSchema,
  provisioningRequestId: z.uuid().optional(),
  repository: z.strictObject({
    name: z
      .string()
      .trim()
      .min(1)
      .max(100)
      .regex(/^[A-Za-z0-9._-]+$/u),
    private: z.boolean(),
  }),
  version: z.literal(1),
});

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;
type HandoffService = ReturnType<typeof createBuilderHandoffService>;

export interface BuilderHandoffPageData {
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
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
      ) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      const contentLength = request.headers.get("content-length");
      if (
        contentLength !== null &&
        contentLength !== "" &&
        (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumRequestBytes)
      ) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      const authority = await input.authorityForRequest(request);
      if (!authority) {
        return Response.json(
          { error: "authentication_required" },
          { headers: noStore, status: 401 },
        );
      }
      const body = builderHandoffCreateRequestSchema.parse(await readBoundedJson(request));
      const provision =
        body.provisioningRequestId === undefined
          ? undefined
          : await input.journal.read({
              authority,
              requestId: body.provisioningRequestId,
            });
      if (body.provisioningRequestId !== undefined && !provision) {
        return Response.json({ error: "handoff_unavailable" }, { headers: noStore, status: 404 });
      }
      const github = provision?.record.response.github;
      const appName = provision?.record.request.appName ?? body.appName;
      const repository = provision?.record.request.repository ?? body.repository;
      const { handoffs } = input;
      const create = handoffs.create.bind(handoffs);
      const creation = {
        authority,
        creationRequestId: body.creationRequestId,
      };
      const destination: Pick<BuilderHandoffIntent, "destination"> = {};
      if (body.destination !== undefined) {
        destination.destination = body.destination;
      }
      const identified: Pick<BuilderHandoffIntent, "destination" | "appId" | "sourceCandidate"> = {
        ...destination,
        appId:
          provision?.record.response.appId ??
          body.sourceCandidate?.appId ??
          deriveBuilderAppId(appName),
      };
      if (body.sourceCandidate !== undefined) {
        identified.sourceCandidate = body.sourceCandidate;
      }
      const intentPrefix = {
        ...identified,
        appName,
        brief: body.brief,
        connections: body.connections,
        modelId: body.modelId,
      };
      const intentRepository: BuilderHandoffIntent["repository"] = {
        private: repository.private,
        requestedName: repository.name,
      };
      if (github?.status === "succeeded") {
        intentRepository.resolvedFullName = github.fullName;
      }
      const intent: BuilderHandoffIntent = { ...intentPrefix, repository: intentRepository };
      if (provision !== undefined) {
        intent.providers = provision.record.request.providers;
        intent.provisioning = provision.record.response;
        intent.provisioningRequestDigest = provision.requestDigest;
        intent.provisioningRequestId = provision.requestId;
      }
      const created = await create({ ...creation, intent });
      return Response.json(
        {
          expiresAt: created.expiresAt.toISOString(),
          handoffId: created.handoffId,
          version: 1,
        },
        { headers: noStore },
      );
    } catch (error) {
      if (error instanceof BuilderHandoffRequestError || error instanceof z.ZodError) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      if (error instanceof BuilderHandoffConflictError) {
        return Response.json({ error: "request_id_conflict" }, { headers: noStore, status: 409 });
      }
      return Response.json({ error: "handoff_unavailable" }, { headers: noStore, status: 503 });
    }
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
function handoffErrorResponse(error: unknown) {
  if (error instanceof BuilderHandoffUnavailableError) {
    return Response.json({ error: "handoff_unavailable" }, { headers: noStore, status: 404 });
  }
  if (error instanceof BuilderHandoffConflictError) {
    return Response.json({ error: "request_id_conflict" }, { headers: noStore, status: 409 });
  }
  if (error instanceof BuilderHandoffRequestError || error instanceof z.ZodError) {
    return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
  }
  return Response.json({ error: "handoff_unavailable" }, { headers: noStore, status: 503 });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderHandoffStatusRouteHandler(input: {
  pageData: (request: Request, handoffId: string) => Promise<BuilderHandoffPageData | undefined>;
}) {
  return async (request: Request, handoffId: string) => {
    try {
      const data = await input.pageData(request, handoffId);
      return data
        ? Response.json(data, { headers: noStore })
        : Response.json({ error: "authentication_required" }, { headers: noStore, status: 401 });
    } catch (error) {
      return handoffErrorResponse(error);
    }
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
      ) {
        throw new BuilderHandoffRequestError();
      }
      const contentLength = request.headers.get("content-length");
      if (
        contentLength !== null &&
        contentLength !== "" &&
        (!/^\d+$/u.test(contentLength) || Number(contentLength) > maximumRequestBytes)
      ) {
        throw new BuilderHandoffRequestError();
      }
      const authority = await input.authorityForRequest(request);
      if (!authority) {
        return Response.json(
          { error: "authentication_required" },
          { headers: noStore, status: 401 },
        );
      }
      const body = z
        .strictObject({ creationRequestId: z.uuid() })
        .parse(await readBoundedJson(request));
      const renewed = await input.handoffs.renew({
        authority,
        handoffId,
        ...body,
      });
      return Response.json(
        {
          expiresAt: renewed.expiresAt.toISOString(),
          handoffId: renewed.handoffId,
          version: 1,
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

export interface BuilderHandoffPageDependencies {
  databases: Map<string, ReturnType<typeof openHostedPostgresDatabase>>;
  readConfig: (environment: Environment) => {
    databaseUrl: string;
    issuer: string;
    resource: string;
  };
  openDatabase: typeof openHostedPostgresDatabase;
  session: (input: {
    environment: Environment;
    headers: Headers;
  }) => Promise<{ user: { id: string }; organization: { workspaceId: string } } | undefined>;
  createStore: (database: ReturnType<typeof openHostedPostgresDatabase>) => BuilderHandoffStore;
  loadCursorClient: () => Promise<{ isCursorClientReady: typeof isCursorClientReady }>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function deploymentContext(
  environment: Environment,
  dependencies?: BuilderHandoffPageDependencies,
) {
  const preview = dependencies
    ? dependencies.readConfig(environment)
    : readPreviewOAuthRuntimeConfig(environment);
  const databases = dependencies?.databases ?? deploymentDatabases;
  let database = databases.get(preview.databaseUrl);
  if (!database) {
    database = dependencies
      ? dependencies.openDatabase(preview.databaseUrl)
      : openHostedPostgresDatabase(preview.databaseUrl);
    databases.set(preview.databaseUrl, database);
  }
  return {
    async authorityForHeaders(headers: Headers) {
      const session = await (
        dependencies?.session ?? ensurePreviewOAuthDeploymentSessionOrganization
      )({
        environment,
        headers,
      });
      return session
        ? hostedTenantAuthoritySchema.parse({
            audience: preview.resource,
            issuer: preview.issuer,
            ownerUserId: session.user.id,
            workspaceId: session.organization.workspaceId,
          })
        : undefined;
    },
    database,
    handoffs: createBuilderHandoffService({
      store: dependencies
        ? dependencies.createStore(database)
        : createPostgresBuilderHandoffStore(database),
      validateSourceCandidate: createSourceCandidateValidator(database),
    }),
    preview,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function getBuilderHandoffPageData(
  input: { environment: Environment; headers: Headers; handoffId: string },
  dependencies?: BuilderHandoffPageDependencies,
): Promise<BuilderHandoffPageData | undefined> {
  const context = deploymentContext(input.environment, dependencies);
  const authority = await context.authorityForHeaders(input.headers);
  if (!authority) {
    return undefined;
  }
  const { status, record } = await context.handoffs.status({
    authority,
    handoffId: input.handoffId,
  });
  const { provisioningRequestId } = record.intent;
  const currentProvisioning =
    provisioningRequestId !== undefined && provisioningRequestId !== ""
      ? await createPostgresBuilderProvisionJournalStore(context.database).read({
          authority,
          requestId: provisioningRequestId,
        })
      : undefined;
  const { isCursorClientReady } = dependencies
    ? await dependencies.loadCursorClient()
    : await import("../auth/cursor-client");
  const page: BuilderHandoffPageData = {
    cursorInstallReady: await isCursorClientReady(context.database, context.preview.resource),
    destination: record.intent.destination ?? "codex",
    expiresAt: record.expiresAt.toISOString(),
    handoffId: record.handoffId,
    intent: currentProvisioning
      ? { ...record.intent, provisioning: currentProvisioning.record.response }
      : record.intent,
    mcpUrl: context.preview.resource,
    status,
    version: 1,
  };
  if (currentProvisioning) {
    page.provisioningRevision = currentProvisioning.revision;
  }
  return page;
}

/**
 * Finds only a still-pending, owner-scoped provisioning handoff. The builder
 * uses this to resume durable provider work; settled and provider-less
 * handoffs deliberately return users to a fresh builder.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function findAuthenticatedPendingBuilderHandoff(
  input: { environment: Environment; headers: Headers },
  dependencies?: BuilderHandoffPageDependencies,
): Promise<{ handoffId: string } | undefined> {
  const context = deploymentContext(input.environment, dependencies);
  const authority = await context.authorityForHeaders(input.headers);
  if (!authority) {
    return undefined;
  }
  const record = await context.handoffs.findLatestPending({ authority });
  return record ? { handoffId: record.handoffId } : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getBuilderHandoffStatusDeploymentHandler(
  environment: Environment,
  dependencies?: BuilderHandoffPageDependencies,
) {
  return createBuilderHandoffStatusRouteHandler({
    pageData: (request, handoffId) =>
      getBuilderHandoffPageData({ environment, handoffId, headers: request.headers }, dependencies),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getBuilderHandoffRenewDeploymentHandler(environment: Environment) {
  // Compose inside the error boundary so setup failures also remain no-store.
  return async (request: Request, handoffId: string) => {
    try {
      const context = deploymentContext(environment);
      return await createBuilderHandoffRenewRouteHandler({
        authorityForRequest: (innerRequest) => context.authorityForHeaders(innerRequest.headers),
        handoffs: context.handoffs,
        origin: new URL(context.preview.issuer).origin,
      })(request, handoffId);
    } catch (error) {
      return handoffErrorResponse(error);
    }
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getBuilderHandoffDeploymentHandler(environment: Environment) {
  const context = deploymentContext(environment);
  return createBuilderHandoffRouteHandler({
    authorityForRequest: (request) => context.authorityForHeaders(request.headers),
    handoffs: context.handoffs,
    journal: createPostgresBuilderProvisionJournalStore(context.database),
    origin: new URL(context.preview.issuer).origin,
  });
}
