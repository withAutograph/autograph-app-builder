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
import { builderProvisionRequestSchema } from "./contracts";
import { readGitHubProvisioningEnvironment } from "./github-provider";
import { readGitHubUserCredentialEnvironment } from "./github-user-credential";
import { createPostgresGitHubUserCredentialStore } from "./postgres-github-user-credential";
import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";
import { executeBuilderProvisioning, readBuilderProvisioning } from "./service";
import { readStarterSourceEnvironment } from "./starter-source";

const noStore = { "Cache-Control": "no-store" } as const;

export function createBuilderProvisioningRouteHandler(input: {
  origin: string;
  enabled(): Promise<boolean>;
  authorityForRequest(request: Request): Promise<
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
  dependencies: Parameters<
    typeof executeBuilderProvisioning
  >[0]["dependencies"];
}) {
  const origin = new URL(input.origin).origin;
  return async (request: Request) => {
    try {
      if (new URL(request.url).origin !== origin)
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
      if (request.method === "GET") {
        const requestId = z
          .string()
          .uuid()
          .parse(new URL(request.url).searchParams.get("requestId"));
        const result = await input.read({
          authority,
          requestId,
          journal: input.dependencies.journal,
        });
        return result
          ? Response.json(result, { headers: noStore })
          : Response.json(
              { error: "provisioning_not_found" },
              { status: 404, headers: noStore },
            );
      }
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
      if (!(await input.enabled()))
        return Response.json(
          { error: "feature_disabled" },
          { status: 503, headers: noStore },
        );
      const length = request.headers.get("content-length");
      if (length && (!/^\d+$/u.test(length) || Number(length) > 16_384))
        return Response.json(
          { error: "request_invalid" },
          { status: 400, headers: noStore },
        );
      const body = builderProvisionRequestSchema.parse(await request.json());
      const result = await input.execute({
        authority,
        request: body,
        dependencies: input.dependencies,
      });
      return Response.json(result, { headers: noStore });
    } catch (error) {
      const conflict =
        error instanceof Error &&
        error.message === "provision-request-id-reused";
      return Response.json(
        {
          error: conflict ? "request_id_conflict" : "provisioning_unavailable",
        },
        { status: conflict ? 409 : 503, headers: noStore },
      );
    }
  };
}

let handler: ((request: Request) => Promise<Response>) | undefined;

export function getBuilderProvisioningDeploymentHandler(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (handler) return handler;
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  const vercelConfig = readVercelIntegrationEnvironment(environment);
  const vercelInstallations = createPostgresVercelInstallationStore({
    database,
    config: vercelConfig,
  });
  const dependencies: Parameters<
    typeof executeBuilderProvisioning
  >[0]["dependencies"] = {
    journal: createPostgresBuilderProvisionJournalStore(database),
    githubInstallations: createPostgresHostedGitHubInstallationStore(database),
    githubCredentials: createPostgresGitHubUserCredentialStore({
      database,
      config: readGitHubUserCredentialEnvironment(environment),
    }),
    githubConfig: readGitHubProvisioningEnvironment(environment),
    starterConfig: readStarterSourceEnvironment(environment),
    vercelConfig,
    readVercelCredential: ({ authority, installationId }) =>
      readActiveVercelInstallationToken({
        database,
        config: vercelConfig,
        authority,
        installationId,
      }),
    deactivateVercelInstallation: (installationId, now) =>
      vercelInstallations.deactivate(installationId, now),
  };
  handler = createBuilderProvisioningRouteHandler({
    origin: new URL(preview.issuer).origin,
    enabled: builderResourceProvisioningFlag,
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
    execute: executeBuilderProvisioning,
    read: readBuilderProvisioning,
    dependencies,
  });
  return handler;
}
