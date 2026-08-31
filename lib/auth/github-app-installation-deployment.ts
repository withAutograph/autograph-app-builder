import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
  githubInstallationAuthorizationDiagnostic,
  GitHubInstallationAuthorizationError,
  readGitHubAppInstallationEnvironment,
} from "./github-app-installation";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "./preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "./preview-oauth-runtime";
import {
  providerEmulationEnvironment,
  readProviderEmulation,
} from "../integrations/local-provider-emulation";
import { providerEmulationFetch } from "../integrations/provider-emulation-fetch";
import { createPostgresGitHubInstallationAuthorizationStateStore } from "./postgres-github-installation-state";
import { logProviderConnectionFailure } from "../integrations/provider-connection-logging";
import { readGitHubUserCredentialEnvironment } from "../provisioning/github-user-credential";
import { createPostgresGitHubUserCredentialStore } from "../provisioning/postgres-github-user-credential";
import type { ProviderConnectionFailureReason } from "../integrations/provider-connection-status";
import {
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
  type ProviderConnectionReturn,
} from "../integrations/provider-connection-return";
import {
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "./workspace-onboarding";

type Authority = {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
};

type InstallationAuthorization = ReturnType<
  typeof createGitHubAppInstallationAuthorization
>;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export function createGitHubAppInstallationRouteHandlers(input: {
  origin: string;
  authorityForRequest(request: Request): Promise<Authority | undefined>;
  authorization: InstallationAuthorization;
}) {
  const origin = new URL(input.origin).origin;
  const redirect = (
    status: "connected" | "failed",
    reason?: ProviderConnectionFailureReason,
    returnState?: ProviderConnectionReturn,
  ) =>
    new Response(null, {
      status: 303,
      headers: {
        ...noStoreHeaders,
        Location: providerConnectionRedirect({
          origin,
          provider: "github",
          status,
          reason,
          returnState,
        }),
      },
    });

  return {
    async start(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (
        reason: ProviderConnectionFailureReason,
        diagnostic?: { stage: string; category?: string },
        returnState?: ProviderConnectionReturn,
      ) => {
        logProviderConnectionFailure({
          request,
          provider: "github",
          phase: "start",
          reason,
          startedAt,
          diagnostic,
        });
        return redirect("failed", reason, returnState);
      };
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/x-www-form-urlencoded"
      ) {
        return fail("request-invalid");
      }

      let authority: Authority | undefined;
      try {
        authority = await input.authorityForRequest(request);
      } catch {
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: workspaceOnboardingRedirect(
              origin,
              "workspace-setup-retry",
            ),
          },
        });
      }
      if (authority === undefined)
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
        });

      try {
        const returnState = providerConnectionReturnFromFormData(
          await request.formData(),
        );
        const result = await input.authorization.begin(authority, returnState);
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: result.redirectUrl,
          },
        });
      } catch {
        return fail("authorization-failed");
      }
    },

    async callback(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (
        reason: ProviderConnectionFailureReason,
        diagnostic?: { stage: string; category?: string },
        returnState?: ProviderConnectionReturn,
      ) => {
        logProviderConnectionFailure({
          request,
          provider: "github",
          phase: "callback",
          reason,
          startedAt,
          diagnostic,
        });
        return redirect("failed", reason, returnState);
      };
      if (request.method !== "GET") return fail("request-invalid");

      let authority: Authority | undefined;
      try {
        authority = await input.authorityForRequest(request);
      } catch {
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: workspaceOnboardingRedirect(
              origin,
              "workspace-setup-retry",
            ),
          },
        });
      }
      if (authority === undefined)
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
        });

      try {
        const result = await input.authorization.complete(
          request.url,
          authority,
        );
        if (result.status === "redirect") {
          return new Response(null, {
            status: 303,
            headers: { ...noStoreHeaders, Location: result.redirectUrl },
          });
        }
        return redirect("connected", undefined, result.returnState);
      } catch (error) {
        return fail(
          "callback-invalid",
          githubInstallationAuthorizationDiagnostic(error),
          error instanceof GitHubInstallationAuthorizationError
            ? error.returnState
            : undefined,
        );
      }
    },
  };
}

let deploymentHandlers:
  ReturnType<typeof createGitHubAppInstallationRouteHandlers> | undefined;

export function getGitHubAppInstallationDeploymentHandlers(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentHandlers !== undefined) return deploymentHandlers;
  const resolvedEnvironment = providerEmulationEnvironment(environment);
  const config = readGitHubAppInstallationEnvironment(resolvedEnvironment);
  const previewConfig = readPreviewOAuthRuntimeConfig(resolvedEnvironment);
  const database = openHostedPostgresDatabase(previewConfig.databaseUrl);
  let credentialStore:
    ReturnType<typeof createPostgresGitHubUserCredentialStore> | undefined;
  try {
    credentialStore = createPostgresGitHubUserCredentialStore({
      database,
      config: readGitHubUserCredentialEnvironment(environment),
    });
  } catch {}
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    issuer: previewConfig.issuer,
    audience: previewConfig.resource,
  });
  const emulation = readProviderEmulation(resolvedEnvironment);
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    stateStore:
      createPostgresGitHubInstallationAuthorizationStateStore(database),
    membership: {
      isActiveMember: (authority) => membership.isActiveMember(authority),
    },
    installationStore: createPostgresHostedGitHubInstallationStore(database),
    credentialStore,
    emulation,
    fetch: emulation
      ? (resource, init) =>
          providerEmulationFetch(resource as string | URL, init, emulation)
      : undefined,
  });
  deploymentHandlers = createGitHubAppInstallationRouteHandlers({
    origin: new URL(config.issuer).origin,
    authorization,
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment: resolvedEnvironment,
        headers: request.headers,
      });
      if (session === undefined) return undefined;
      return {
        issuer: config.issuer,
        audience: config.resource,
        workspaceId: session.organization.workspaceId,
        ownerUserId: session.user.id,
      };
    },
  });
  return deploymentHandlers;
}

export function createGitHubAppInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    try {
      return await getGitHubAppInstallationDeploymentHandlers(environment)[
        kind
      ](request);
    } catch {
      logProviderConnectionFailure({
        request,
        provider: "github",
        phase: kind,
        reason: "configuration-unavailable",
        startedAt,
      });
      return new Response(null, {
        status: 303,
        headers: {
          ...noStoreHeaders,
          Location:
            "/github/installations?status=failed&reason=configuration-unavailable",
        },
      });
    }
  };
}
