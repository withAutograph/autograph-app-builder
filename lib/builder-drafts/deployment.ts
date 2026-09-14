import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createBuilderDraftStore } from "../db/builder-drafts";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { builderDraftPageDataSchema, saveActiveBuilderDraftInputSchema } from "./contracts";
import { createBuilderDraftService } from "./service";

const noStore = { "Cache-Control": "no-store" } as const;
const maximumRequestBytes = 65_536;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function pageData(
  row: Awaited<ReturnType<ReturnType<typeof createBuilderDraftService>["readActive"]>>,
) {
  if (!row) {
    return;
  }
  return builderDraftPageDataSchema.parse({
    draftId: row.draftId,
    record: row.record,
    revision: row.revision,
    updatedAt: row.updatedAt.toISOString(),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function getAuthenticatedBuilderDraftContext(input: {
  environment: Environment;
  headers: Headers;
}) {
  const session = await ensurePreviewOAuthDeploymentSessionOrganization({
    environment: input.environment,
    headers: input.headers,
  });
  if (!session) {
    return;
  }
  const preview = readPreviewOAuthRuntimeConfig(input.environment);
  return {
    authority: {
      audience: preview.resource,
      issuer: preview.issuer,
      ownerUserId: session.user.id,
      workspaceId: session.organization.workspaceId,
    },
    drafts: createBuilderDraftService({
      store: createBuilderDraftStore(openHostedPostgresDatabase(preview.databaseUrl)),
    }),
  };
}

/** Request-fresh RSC read; callers pass `await headers()` from their route. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readAuthenticatedActiveBuilderDraft(input: {
  environment: Environment;
  headers: Headers;
}) {
  const context = await getAuthenticatedBuilderDraftContext(input);
  if (!context) {
    return;
  }
  return pageData(await context.drafts.readActive(context.authority));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readAuthenticatedBuilderDraft(input: {
  environment: Environment;
  headers: Headers;
  draftId: string;
}) {
  const context = await getAuthenticatedBuilderDraftContext(input);
  if (!context) {
    return;
  }
  const row = await context.drafts.read(context.authority, input.draftId);
  // An opaque, tenant-authorized draft ID is used for provider-return
  // recovery. It must remain readable after the active draft has been
  // archived by a handoff; only the active-draft query filters by status.
  return pageData(row);
}

/** Scheduled-maintenance entry point. Do not invoke from actions or requests. */
// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
export async function deleteInactiveBuilderDraftsForMaintenance(input: {
  environment: Environment;
  now?: () => Date;
  maxAgeMs?: number;
}) {
  const preview = readPreviewOAuthRuntimeConfig(input.environment);
  return createBuilderDraftService({
    now: input.now,
    store: createBuilderDraftStore(openHostedPostgresDatabase(preview.databaseUrl)),
  }).deleteInactiveSince(input.maxAgeMs);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderDraftRouteHandler(input: {
  origin: string;
  authorityForRequest: (request: Request) => Promise<
    | {
        issuer: string;
        audience: string;
        workspaceId: string;
        ownerUserId: string;
      }
    | undefined
  >;
  drafts: ReturnType<typeof createBuilderDraftService>;
}) {
  const { origin } = new URL(input.origin);
  return async (request: Request) => {
    try {
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
      ) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/u.test(length) || Number(length) > maximumRequestBytes)) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      const authority = await input.authorityForRequest(request);
      if (!authority) {
        return Response.json(
          { error: "authentication_required" },
          { headers: noStore, status: 401 },
        );
      }
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > maximumRequestBytes) {
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      }
      const saved = await input.drafts.saveActive(
        authority,
        saveActiveBuilderDraftInputSchema.parse(JSON.parse(raw)),
      );
      return Response.json(
        {
          concurrent: saved.concurrent,
          draftId: saved.row.draftId,
          idempotent: saved.idempotent,
          revision: saved.row.revision,
          updatedAt: saved.row.updatedAt.toISOString(),
        },
        { headers: noStore },
      );
    } catch (error) {
      if (
        error instanceof Error &&
        ["builder-draft-archived", "builder-draft-stale"].includes(error.message)
      ) {
        return Response.json(
          { error: "draft_no_longer_active" },
          { headers: noStore, status: 409 },
        );
      }
      const invalid =
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error && error.message === "builder-draft-contention");
      return Response.json(
        { error: invalid ? "request_invalid" : "draft_unavailable" },
        { headers: noStore, status: invalid ? 400 : 503 },
      );
    }
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

/** Intended route import: `getBuilderDraftDeploymentHandler(process.env)`. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getBuilderDraftDeploymentHandler(environment: Environment) {
  if (handler) {
    return handler;
  }
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  handler = createBuilderDraftRouteHandler({
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment,
        headers: request.headers,
      });
      return session
        ? {
            audience: preview.resource,
            issuer: preview.issuer,
            ownerUserId: session.user.id,
            workspaceId: session.organization.workspaceId,
          }
        : undefined;
    },
    drafts: createBuilderDraftService({
      store: createBuilderDraftStore(database),
    }),
    origin: new URL(preview.issuer).origin,
  });
  return handler;
}
