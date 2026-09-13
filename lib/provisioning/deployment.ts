import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { builderResourceProvisioningFlag } from "../feature-flags";
import {
  createPostgresVercelInstallationStore,
  readActiveVercelInstallationToken,
} from "../integrations/postgres-vercel-installation";
import { readVercelIntegrationEnvironment } from "../integrations/vercel-installation";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import { builderProvisionProjectionSchema, builderProvisionRequestSchema } from "./contracts";
import { readGitHubProvisioningEnvironment } from "./github-provider";
import { readGitHubUserCredentialEnvironment } from "./github-user-credential";
import { createPostgresGitHubUserCredentialStore } from "./postgres-github-user-credential";
import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";
import { executeBuilderProvisioning, readBuilderProvisioning } from "./service";

const noStore = { "Cache-Control": "no-store" } as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderProvisioningRouteHandler(input: {
  origin: string;
  enabled: () => Promise<boolean>;
  authorityForRequest: (request: Request) => Promise<
    | {
        issuer: string;
        audience: string;
        workspaceId: string;
        ownerUserId: string;
      }
    | undefined
  >;
  execute: typeof executeBuilderProvisioning;
  read: typeof readBuilderProvisioning;
  dependencies: Parameters<typeof executeBuilderProvisioning>[0]["dependencies"];
}) {
  const { origin } = new URL(input.origin);
  return async (request: Request) => {
    try {
      if (new URL(request.url).origin !== origin)
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      const authority = await input.authorityForRequest(request);
      if (!authority)
        return Response.json(
          { error: "authentication_required" },
          { headers: noStore, status: 401 },
        );
      if (request.method === "GET") {
        const requestId = z
          .string()
          .uuid()
          .parse(new URL(request.url).searchParams.get("requestId"));
        if (new URL(request.url).searchParams.get("projection") === "1") {
          const row = await input.dependencies.journal.read({
            authority,
            requestId,
          });
          return row
            ? Response.json(
                builderProvisionProjectionSchema.parse({
                  provisioning: row.record.response,
                  revision: row.revision,
                }),
                { headers: noStore },
              )
            : Response.json({ error: "provisioning_not_found" }, { headers: noStore, status: 404 });
        }
        const result = await input.read({
          authority,
          journal: input.dependencies.journal,
          requestId,
        });
        return result
          ? Response.json(result, { headers: noStore })
          : Response.json({ error: "provisioning_not_found" }, { headers: noStore, status: 404 });
      }
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !== "application/json"
      )
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      if (!(await input.enabled()))
        return Response.json({ error: "feature_disabled" }, { headers: noStore, status: 503 });
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/u.test(length) || Number(length) > 16_384))
        return Response.json({ error: "request_invalid" }, { headers: noStore, status: 400 });
      const body = builderProvisionRequestSchema.parse(await request.json());
      if (new URL(request.url).searchParams.get("mode") === "reserve") {
        const reserved = await input.dependencies.journal.reserve({
          authority,
          now: new Date(),
          request: body,
        });
        return Response.json(reserved.record.response, { headers: noStore });
      }
      const result = await input.execute({
        authority,
        dependencies: input.dependencies,
        request: body,
      });
      return Response.json(result, { headers: noStore });
    } catch (error) {
      const conflict = error instanceof Error && error.message === "provision-request-id-reused";
      return Response.json(
        {
          error: conflict ? "request_id_conflict" : "provisioning_unavailable",
        },
        { headers: noStore, status: conflict ? 409 : 503 },
      );
    }
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getBuilderProvisioningDeploymentHandler(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (handler) return handler;
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  const vercelConfig = readVercelIntegrationEnvironment(environment);
  const vercelInstallations = createPostgresVercelInstallationStore({
    config: vercelConfig,
    database,
  });
  const dependencies: Parameters<typeof executeBuilderProvisioning>[0]["dependencies"] = {
    deactivateVercelInstallation: (installationId, now) =>
      vercelInstallations.deactivate(installationId, now),
    githubConfig: readGitHubProvisioningEnvironment(environment),
    githubCredentials: createPostgresGitHubUserCredentialStore({
      config: readGitHubUserCredentialEnvironment(environment),
      database,
    }),
    githubInstallations: createPostgresHostedGitHubInstallationStore(database),
    journal: createPostgresBuilderProvisionJournalStore(database),
    readVercelCredential: ({ authority, installationId }) =>
      readActiveVercelInstallationToken({
        authority,
        config: vercelConfig,
        database,
        installationId,
      }),
    vercelConfig,
  };
  handler = createBuilderProvisioningRouteHandler({
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
    dependencies,
    enabled: builderResourceProvisioningFlag,
    execute: executeBuilderProvisioning,
    origin: new URL(preview.issuer).origin,
    read: readBuilderProvisioning,
  });
  return handler;
}
