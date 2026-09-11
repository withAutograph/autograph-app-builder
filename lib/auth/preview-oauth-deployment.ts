import { drizzleAdapter } from "better-auth/adapters/drizzle";

import * as databaseSchema from "../db/schema";
import { selfServiceSignupFlag } from "../feature-flags";
import { readProviderEmulation } from "../integrations/local-provider-emulation";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";
import {
  createPreviewOAuthServer,
  readPreviewOAuthRuntimeConfig,
} from "./preview-oauth-runtime";
import type { PreviewOAuthRuntimeConfig } from "./preview-oauth-runtime";
import type { PreviewOrganizationUserAuthority } from "./preview-user-management";

type PreviewOAuthServer = ReturnType<typeof createPreviewOAuthServer>;

interface PreviewOAuthDeploymentRuntime {
  auth: PreviewOAuthServer;
  origin: string;
  organizationAuthority: ReturnType<
    typeof createPostgresPreviewOrganizationAuthority
  >;
}

let deploymentRuntime: PreviewOAuthDeploymentRuntime | undefined;

export function selfServiceSignupAuthority(
  environment: PreviewOAuthRuntimeConfig["environment"],
  managedAuthority: () => Promise<boolean> = selfServiceSignupFlag,
  emulated = false
) {
  return environment === "local" || emulated
    ? async () => true
    : managedAuthority;
}

function getPreviewOAuthDeploymentRuntime(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
): PreviewOAuthDeploymentRuntime {
  if (deploymentRuntime !== undefined) {
    return deploymentRuntime;
  }
  let providerEmulation: ReturnType<typeof readProviderEmulation>;
  try {
    providerEmulation = readProviderEmulation(environment);
  } catch (error) {
    const invalidFields =
      error &&
      typeof error === "object" &&
      "issues" in error &&
      Array.isArray(error.issues)
        ? error.issues
            .map((issue) =>
              issue && typeof issue === "object" && "path" in issue
                ? String((issue as { path: unknown[] }).path[0] ?? "unknown")
                : "unknown"
            )
            .join(",")
        : "unknown";
    throw new Error(`preview-oauth-emulation-config:${invalidFields}`, {
      cause: error,
    });
  }
  let config: ReturnType<typeof readPreviewOAuthRuntimeConfig>;
  try {
    config = readPreviewOAuthRuntimeConfig(environment);
  } catch (error) {
    throw new Error("preview-oauth-config", { cause: error });
  }
  const database = openHostedPostgresDatabase(config.databaseUrl);
  const organizationAuthority = createPostgresPreviewOrganizationAuthority(
    database,
    {
      audience: config.resource,
      issuer: config.issuer,
    },
    {
      isSelfServiceSignupEnabled: selfServiceSignupAuthority(
        config.environment,
        selfServiceSignupFlag,
        Boolean(providerEmulation)
      ),
    }
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
      infrastructure: {
        environment: {
          BETTER_AUTH_API_KEY: environment.BETTER_AUTH_API_KEY,
          BETTER_AUTH_INFRASTRUCTURE: environment.BETTER_AUTH_INFRASTRUCTURE,
        },
        organizationAuthorityReady:
          environment.BETTER_AUTH_ORGANIZATION_AUTHORITY_READY ===
          "verified-v1",
      },
      membership: organizationAuthority,
      userManagement: organizationAuthority,
    });
  } catch (error) {
    throw new Error("preview-oauth-server", { cause: error });
  }
  deploymentRuntime = {
    auth,
    organizationAuthority,
    origin: new URL(config.resource).origin,
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
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
) {
  return getPreviewOAuthDeploymentRuntime(environment).auth;
}

export function getPreviewOAuthDeploymentOrigin(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
) {
  return getPreviewOAuthDeploymentRuntime(environment).origin;
}

export function getPreviewOAuthDeploymentSession(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  headers: Headers;
}) {
  return getPreviewOAuthDeploymentRuntime(
    input.environment
  ).auth.api.getSession({ headers: input.headers });
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
  if (!current?.user) {
    return undefined;
  }

  const ensured = await input.authority.ensureOrganizationForVerifiedUser({
    userId: current.user.id,
  });
  if (current.session.activeOrganizationId !== ensured.organizationId) {
    const active = await input.auth.api.setActiveOrganization({
      body: { organizationId: ensured.organizationId },
      headers: input.headers,
    });
    if (active?.id !== ensured.organizationId) {
      throw new Error("Unable to activate the provisioned organization.");
    }
  }

  return {
    organization: ensured,
    user: current.user,
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
        input.environment
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
            hasRedirect,
            level: "info",
            message: "preview_oauth_sign_in_response",
            status: response.status,
          })
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
        })
      );
      return Response.json(
        { error: "preview_oauth_unavailable" },
        {
          headers: { "Cache-Control": "no-store" },
          status: 503,
        }
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
        headers: request.headers,
        method: "GET",
      })
    );
  };
}
