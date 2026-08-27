import { drizzleAdapter } from "better-auth/adapters/drizzle";

import * as databaseSchema from "../db/schema";
import { createPostgresOAuthMembershipAuthority } from "../eve/postgres-workspace-membership";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createPreviewOAuthServer,
  readPreviewOAuthRuntimeConfig,
} from "./preview-oauth-runtime";

let deploymentAuth: ReturnType<typeof createPreviewOAuthServer> | undefined;

/**
 * Lazily mounts one exact Preview issuer. Importing the Next.js route performs
 * no environment parsing, database connection, key creation, or client/grant
 * mutation. The first request fails closed unless every Preview binding is
 * present and exact.
 */
export function getPreviewOAuthDeploymentAuth(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentAuth !== undefined) return deploymentAuth;
  const config = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(config.databaseUrl);
  deploymentAuth = createPreviewOAuthServer({
    config,
    database: drizzleAdapter(database, {
      provider: "pg",
      schema: databaseSchema,
      transaction: true,
    }),
    membership: createPostgresOAuthMembershipAuthority(database),
  });
  return deploymentAuth;
}

export function createPreviewOAuthRequestHandler(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  getAuth?: typeof getPreviewOAuthDeploymentAuth;
}) {
  return async (request: Request): Promise<Response> => {
    try {
      const auth = (input.getAuth ?? getPreviewOAuthDeploymentAuth)(
        input.environment,
      );
      return await auth.handler(request);
    } catch {
      return Response.json(
        { error: "preview_oauth_unavailable" },
        {
          status: 503,
          headers: { "Cache-Control": "no-store" },
        },
      );
    }
  };
}

export function createPreviewOAuthWellKnownHandler(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  getAuth?: typeof getPreviewOAuthDeploymentAuth;
}) {
  const requestHandler = createPreviewOAuthRequestHandler(input);
  return (request: Request) => {
    const url = new URL(request.url);
    url.pathname = "/api/auth/.well-known/oauth-authorization-server";
    return requestHandler(
      new Request(url, {
        method: "GET",
        headers: request.headers,
      }),
    );
  };
}
