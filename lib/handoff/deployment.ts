import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { deriveBuilderAppId } from "../provisioning/names";
import { createPostgresBuilderProvisionJournalStore } from "../provisioning/postgres-journal";
import type { BuilderProvisionJournalStore } from "../provisioning/journal";
import { createPostgresBuilderHandoffStore } from "./postgres-store";
import {
  BuilderHandoffConflictError,
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
    modelId: z.string().trim().min(1).max(200),
    connections: z.array(z.string().trim().min(1).max(100)).max(50),
  })
  .strict();

type Authority = z.infer<typeof hostedTenantAuthoritySchema>;
type HandoffService = ReturnType<typeof createBuilderHandoffService>;

export function createBuilderHandoffRouteHandler(input: {
  origin: string;
  authorityForRequest(request: Request): Promise<Authority | undefined>;
  journal: BuilderProvisionJournalStore;
  handoffs: HandoffService;
}) {
  const origin = new URL(input.origin).origin;
  return async (request: Request) => {
    try {
      if (
        request.method !== "POST" ||
        !hasCanonicalRequestOrigin(request, origin) ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/json"
      )
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      const contentLength = request.headers.get("content-length");
      if (
        contentLength &&
        (!/^\d+$/u.test(contentLength) ||
          Number(contentLength) > maximumRequestBytes)
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
      const body = builderHandoffCreateRequestSchema.parse(
        await readBoundedJson(request),
      );
      const provision = body.provisioningRequestId
        ? await input.journal.read({
            authority,
            requestId: body.provisioningRequestId,
          })
        : undefined;
      if (body.provisioningRequestId && !provision)
        return Response.json(
          { error: "handoff_unavailable" },
          { status: 404, headers: noStore },
        );
      const github = provision?.record.response.github;
      const appName = provision?.record.request.appName ?? body.appName;
      const repository =
        provision?.record.request.repository ?? body.repository;
      const created = await input.handoffs.create({
        authority,
        creationRequestId: body.creationRequestId,
        intent: {
          appName,
          appId:
            provision?.record.response.appId ?? deriveBuilderAppId(appName),
          brief: body.brief,
          repository: {
            requestedName: repository.name,
            private: repository.private,
            ...(github?.status === "succeeded"
              ? { resolvedFullName: github.fullName }
              : {}),
          },
          modelId: body.modelId,
          connections: body.connections,
          ...(provision === undefined
            ? {}
            : {
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
      if (
        error instanceof BuilderHandoffRequestError ||
        error instanceof z.ZodError
      )
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      if (error instanceof BuilderHandoffConflictError)
        return Response.json(
          { error: "request_id_conflict" },
          { status: 409, headers: noStore },
        );
      return Response.json(
        { error: "handoff_unavailable" },
        { status: 503, headers: noStore },
      );
    }
  };
}

let deploymentHandler: ((request: Request) => Promise<Response>) | undefined;

export function getBuilderHandoffDeploymentHandler(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentHandler) return deploymentHandler;
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  deploymentHandler = createBuilderHandoffRouteHandler({
    origin: new URL(preview.issuer).origin,
    journal: createPostgresBuilderProvisionJournalStore(database),
    handoffs: createBuilderHandoffService({
      store: createPostgresBuilderHandoffStore(database),
    }),
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment,
        headers: request.headers,
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
  });
  return deploymentHandler;
}
