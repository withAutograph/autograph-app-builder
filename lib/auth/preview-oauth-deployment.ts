import { drizzleAdapter } from "better-auth/adapters/drizzle";

import * as databaseSchema from "../db/schema";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createPreviewOAuthServer,
  readPreviewOAuthRuntimeConfig,
} from "./preview-oauth-runtime";
import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";
import type { PreviewOrganizationUserAuthority } from "./preview-user-management";

type PreviewOAuthServer = ReturnType<typeof createPreviewOAuthServer>;

interface PreviewOAuthDeploymentRuntime {
  auth: PreviewOAuthServer;
  organizationAuthority: ReturnType<
    typeof createPostgresPreviewOrganizationAuthority
  >;
}

let deploymentRuntime: PreviewOAuthDeploymentRuntime | undefined;

function getPreviewOAuthDeploymentRuntime(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthDeploymentRuntime {
  if (deploymentRuntime !== undefined) return deploymentRuntime;
  const config = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const organizationAuthority = createPostgresPreviewOrganizationAuthority(
    database,
    {
      issuer: config.issuer,
      audience: config.resource,
      selfServiceSignupEnabled: config.selfServiceSignupEnabled,
    },
  );
  deploymentRuntime = {
    organizationAuthority,
    auth: createPreviewOAuthServer({
      config,
      database: drizzleAdapter(database, {
        provider: "pg",
        schema: databaseSchema,
        transaction: true,
      }),
      membership: organizationAuthority,
      userManagement: organizationAuthority,
      infrastructure: {
        environment: {
          BETTER_AUTH_INFRASTRUCTURE: environment.BETTER_AUTH_INFRASTRUCTURE,
          BETTER_AUTH_API_KEY: environment.BETTER_AUTH_API_KEY,
        },
        organizationAuthorityReady:
          environment.BETTER_AUTH_ORGANIZATION_AUTHORITY_READY ===
          "verified-v1",
      },
    }),
  };
  return deploymentRuntime;
}

/**
 * Lazily mounts one exact Preview issuer. Importing the Next.js route performs
 * no environment parsing, database connection, key creation, or client/grant
 * mutation. The first request fails closed unless every Preview binding is
 * present and exact.
 */
export function getPreviewOAuthDeploymentAuth(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return getPreviewOAuthDeploymentRuntime(environment).auth;
}

interface PreviewSessionOrganizationAuth {
  api: {
    getSession(input: { headers: Headers }): Promise<{
      session: { activeOrganizationId?: string | null };
      user: { id: string; name: string; email: string };
    } | null>;
    setActiveOrganization(input: {
      headers: Headers;
      body: { organizationId: string };
    }): Promise<{ id: string } | null>;
  };
}

/**
 * Reconcile a signed-in verified user with the one server-owned organization
 * before rendering the product. Session-create hooks remain the primary path;
 * this idempotent recovery covers sessions that predate self-serve onboarding
 * or provider-link callbacks that reuse an existing session.
 */
export async function ensurePreviewSessionOrganization(input: {
  auth: PreviewSessionOrganizationAuth;
  authority: PreviewOrganizationUserAuthority;
  headers: Headers;
}) {
  const current = await input.auth.api.getSession({ headers: input.headers });
  if (!current?.user) return undefined;

  const ensured = await input.authority.ensureOrganizationForVerifiedUser({
    userId: current.user.id,
  });
  if (current.session.activeOrganizationId !== ensured.organizationId) {
    const active = await input.auth.api.setActiveOrganization({
      headers: input.headers,
      body: { organizationId: ensured.organizationId },
    });
    if (active?.id !== ensured.organizationId) {
      throw new Error("Unable to activate the provisioned organization.");
    }
  }

  return {
    user: current.user,
    organization: ensured,
  };
}

export function ensurePreviewOAuthDeploymentSessionOrganization(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  headers: Headers;
}) {
  const runtime = getPreviewOAuthDeploymentRuntime(input.environment);
  return ensurePreviewSessionOrganization({
    auth: runtime.auth,
    authority: runtime.organizationAuthority,
    headers: input.headers,
  });
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
