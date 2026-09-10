import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createBuilderDraftStore } from "../db/builder-drafts";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  builderDraftPageDataSchema,
  saveActiveBuilderDraftInputSchema,
} from "./contracts";
import { createBuilderDraftService } from "./service";

const noStore = { "Cache-Control": "no-store" } as const;
const maximumRequestBytes = 65_536;

type Environment = NodeJS.ProcessEnv | Record<string, string | undefined>;

function pageData(
  row: Awaited<
    ReturnType<ReturnType<typeof createBuilderDraftService>["readActive"]>
  >,
) {
  if (!row) return undefined;
  return builderDraftPageDataSchema.parse({
    draftId: row.draftId,
    revision: row.revision,
    record: row.record,
    updatedAt: row.updatedAt.toISOString(),
  });
}

export async function getAuthenticatedBuilderDraftContext(input: {
  environment: Environment;
  headers: Headers;
}) {
  const session = await ensurePreviewOAuthDeploymentSessionOrganization({
    environment: input.environment,
    headers: input.headers,
  });
  if (!session) return undefined;
  const preview = readPreviewOAuthRuntimeConfig(input.environment);
  return {
    authority: {
      issuer: preview.issuer,
      audience: preview.resource,
      workspaceId: session.organization.workspaceId,
      ownerUserId: session.user.id,
    },
    drafts: createBuilderDraftService({
      store: createBuilderDraftStore(
        openHostedPostgresDatabase(preview.databaseUrl),
      ),
    }),
  };
}

/** Request-fresh RSC read; callers pass `await headers()` from their route. */
export async function readAuthenticatedActiveBuilderDraft(input: {
  environment: Environment;
  headers: Headers;
}) {
  const context = await getAuthenticatedBuilderDraftContext(input);
  if (!context) return undefined;
  return pageData(await context.drafts.readActive(context.authority));
}

export async function readAuthenticatedBuilderDraft(input: {
  environment: Environment;
  headers: Headers;
  draftId: string;
}) {
  const context = await getAuthenticatedBuilderDraftContext(input);
  if (!context) return undefined;
  const row = await context.drafts.read(context.authority, input.draftId);
  return row?.status === "active" ? pageData(row) : undefined;
}

/** Scheduled-maintenance entry point. Do not invoke from actions or requests. */
export async function deleteInactiveBuilderDraftsForMaintenance(input: {
  environment: Environment;
  now?: () => Date;
  maxAgeMs?: number;
}) {
  const preview = readPreviewOAuthRuntimeConfig(input.environment);
  return createBuilderDraftService({
    store: createBuilderDraftStore(
      openHostedPostgresDatabase(preview.databaseUrl),
    ),
    now: input.now,
  }).deleteInactiveSince(input.maxAgeMs);
}

export function createBuilderDraftRouteHandler(input: {
  origin: string;
  authorityForRequest(request: Request): Promise<
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
  const origin = new URL(input.origin).origin;
  return async (request: Request) => {
    try {
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/json"
      )
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      const length = request.headers.get("content-length");
      if (
        length &&
        (!/^\d+$/u.test(length) || Number(length) > maximumRequestBytes)
      )
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      const authority = await input.authorityForRequest(request);
      if (!authority)
        return Response.json(
          { error: "authentication_required" },
          { status: 401, headers: noStore },
        );
      const raw = await request.text();
      if (new TextEncoder().encode(raw).byteLength > maximumRequestBytes)
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      const saved = await input.drafts.saveActive(
        authority,
        saveActiveBuilderDraftInputSchema.parse(JSON.parse(raw)),
      );
      return Response.json(
        {
          draftId: saved.row.draftId,
          revision: saved.row.revision,
          updatedAt: saved.row.updatedAt.toISOString(),
          idempotent: saved.idempotent,
          concurrent: saved.concurrent,
        },
        { headers: noStore },
      );
    } catch (error) {
      const invalid =
        error instanceof z.ZodError ||
        error instanceof SyntaxError ||
        (error instanceof Error &&
          error.message === "builder-draft-contention");
      return Response.json(
        { error: invalid ? "request_invalid" : "draft_unavailable" },
        { status: invalid ? 400 : 503, headers: noStore },
      );
    }
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

/** Intended route import: `getBuilderDraftDeploymentHandler(process.env)`. */
export function getBuilderDraftDeploymentHandler(environment: Environment) {
  if (handler) return handler;
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  handler = createBuilderDraftRouteHandler({
    origin: new URL(preview.issuer).origin,
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment,
        headers: request.headers,
      });
      return session
        ? {
            issuer: preview.issuer,
            audience: preview.resource,
            workspaceId: session.organization.workspaceId,
            ownerUserId: session.user.id,
          }
        : undefined;
    },
    drafts: createBuilderDraftService({
      store: createBuilderDraftStore(database),
    }),
  });
  return handler;
}
