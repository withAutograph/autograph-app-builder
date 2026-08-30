import { drizzleAdapter } from "better-auth/adapters/drizzle";

import * as databaseSchema from "../db/schema";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createPreviewOAuthServer,
  readPreviewOAuthRuntimeConfig,
  type PreviewOAuthRuntimeConfig,
} from "./preview-oauth-runtime";
import { selfServiceSignupFlag } from "../feature-flags";
import { readProviderEmulation } from "../integrations/local-provider-emulation";
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

export function selfServiceSignupAuthority(
  environment: PreviewOAuthRuntimeConfig["environment"],
  managedAuthority: () => Promise<boolean> = selfServiceSignupFlag,
  emulated = false,
) {
  return environment === "local" || emulated
    ? async () => true
    : managedAuthority;
}

function getPreviewOAuthDeploymentRuntime(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthDeploymentRuntime {
  if (deploymentRuntime !== undefined) return deploymentRuntime;
  let config: ReturnType<typeof readPreviewOAuthRuntimeConfig>;
  try {
    config = readPreviewOAuthRuntimeConfig(environment);
  } catch (cause) {
    throw new Error("preview-oauth-config", { cause });
  }
  const database = openHostedPostgresDatabase(config.databaseUrl);
  let providerEmulation: ReturnType<typeof readProviderEmulation>;
  try {
    providerEmulation = readProviderEmulation(environment);
  } catch (cause) {
    throw new Error("preview-oauth-emulation-config", { cause });
  }
  const organizationAuthority = createPostgresPreviewOrganizationAuthority(
    database,
    {
      issuer: config.issuer,
      audience: config.resource,
    },
    {
      isSelfServiceSignupEnabled: selfServiceSignupAuthority(
        config.environment,
        selfServiceSignupFlag,
        Boolean(providerEmulation),
      ),
    },
  );
  let auth: PreviewOAuthServer;
  try {
    auth = createPreviewOAuthServer({
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
    });
  } catch (cause) {
    throw new Error("preview-oauth-server", { cause });
  }
  deploymentRuntime = { organizationAuthority, auth };
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
      const response = await auth.handler(request);
      if (new URL(request.url).pathname === "/api/auth/sign-in/social") {
        let hasRedirect = false;
        try {
          const payload = (await response.clone().json()) as { url?: unknown };
          hasRedirect = typeof payload.url === "string";
        } catch {
          // The response shape is diagnostic only; auth owns the response.
        }
        console.info(
          JSON.stringify({
            level: "info",
            message: "preview_oauth_sign_in_response",
            status: response.status,
            hasRedirect,
          }),
        );
      }
      return response;
    } catch (error) {
      console.error(
        JSON.stringify({
          level: "error",
          message: "preview_oauth_unavailable",
          reason:
            error instanceof Error && error.message.startsWith("preview-oauth-")
              ? error.message
              : "preview-oauth-request",
        }),
      );
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
