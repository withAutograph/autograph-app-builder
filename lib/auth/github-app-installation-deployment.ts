import {
  providerEmulationEnvironment,
  readProviderEmulation,
} from "../integrations/local-provider-emulation";
import { createPostgresRepositoryAccessContinuationStore } from "../integrations/postgres-repository-access-continuation";
import { logProviderConnectionFailure } from "../integrations/provider-connection-logging";
import {
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
} from "../integrations/provider-connection-return";
import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";
import type { ProviderConnectionFailureReason } from "../integrations/provider-connection-status";
import { providerEmulationFetch } from "../integrations/provider-emulation-fetch";
import { createRepositoryAccessContinuationService } from "../integrations/repository-access-continuation";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { readGitHubUserCredentialEnvironment } from "../provisioning/github-user-credential";
import { createPostgresGitHubUserCredentialStore } from "../provisioning/postgres-github-user-credential";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
  githubInstallationAuthorizationDiagnostic,
  GitHubInstallationAuthorizationError,
  readGitHubAppInstallationEnvironment,
} from "./github-app-installation";
import { createPostgresGitHubInstallationAuthorizationStateStore } from "./postgres-github-installation-state";
import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";
import { ensurePreviewOAuthDeploymentSessionOrganization } from "./preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "./preview-oauth-runtime";
import {
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "./workspace-onboarding";

interface Authority {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
}

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
  onConnected?(input: {
    authority: Authority;
    returnState: ProviderConnectionReturn;
  }): Promise<string | undefined>;
}) {
  const { origin } = new URL(input.origin);
  const redirect = (
    status: "connected" | "failed",
    reason?: ProviderConnectionFailureReason,
    returnState?: ProviderConnectionReturn
  ) =>
    new Response(null, {
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
      status: 303,
    });

  return {
    async callback(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (
        reason: ProviderConnectionFailureReason,
        diagnostic?: { stage: string; category?: string },
        returnState?: ProviderConnectionReturn
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
              "workspace-setup-retry"
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
          authority
        );
        if (result.status === "redirect") {
          return new Response(null, {
            status: 303,
            headers: { ...noStoreHeaders, Location: result.redirectUrl },
          });
        }
        const continuationRedirect = await input.onConnected?.({
          authority,
          returnState: result.returnState,
        });
        if (continuationRedirect) {
          return new Response(null, {
            status: 303,
            headers: { ...noStoreHeaders, Location: continuationRedirect },
          });
        }
        return redirect("connected", undefined, result.returnState);
      } catch (error) {
        return fail(
          "callback-invalid",
          githubInstallationAuthorizationDiagnostic(error),
          error instanceof GitHubInstallationAuthorizationError
            ? error.returnState
            : undefined
        );
      }
    },

    async start(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (
        reason: ProviderConnectionFailureReason,
        diagnostic?: { stage: string; category?: string },
        returnState?: ProviderConnectionReturn
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
              "workspace-setup-retry"
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
          await request.formData()
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
  };
}

let deploymentHandlers:
  | ReturnType<typeof createGitHubAppInstallationRouteHandlers>
  | undefined;

export function getGitHubAppInstallationDeploymentHandlers(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
) {
  if (deploymentHandlers !== undefined) {
    return deploymentHandlers;
  }
  const resolvedEnvironment = providerEmulationEnvironment(environment);
  const config = readGitHubAppInstallationEnvironment(resolvedEnvironment);
  const previewConfig = readPreviewOAuthRuntimeConfig(resolvedEnvironment);
  const database = openHostedPostgresDatabase(previewConfig.databaseUrl);
  let credentialStore:
    | ReturnType<typeof createPostgresGitHubUserCredentialStore>
    | undefined;
  try {
    credentialStore = createPostgresGitHubUserCredentialStore({
      config: readGitHubUserCredentialEnvironment(environment),
      database,
    });
  } catch {}
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    audience: previewConfig.resource,
    issuer: previewConfig.issuer,
  });
  const emulation = readProviderEmulation(resolvedEnvironment);
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    credentialStore,
    emulation,
    fetch: emulation
      ? (resource, init) =>
          providerEmulationFetch(resource as string | URL, init, emulation)
      : undefined,
    installationStore: createPostgresHostedGitHubInstallationStore(database),
    membership: {
      isActiveMember: (authority) => membership.isActiveMember(authority),
    },
    stateStore:
      createPostgresGitHubInstallationAuthorizationStateStore(database),
  });
  const repositoryAccessContinuations =
    createRepositoryAccessContinuationService({
      store: createPostgresRepositoryAccessContinuationStore(database),
    });
  deploymentHandlers = createGitHubAppInstallationRouteHandlers({
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
    authorization,
    async onConnected({ authority, returnState }) {
      if (!returnState.resumeKey) return undefined;
      return repositoryAccessContinuations.authorize({
        authority,
        continuationId: returnState.resumeKey,
      });
    },
    origin: new URL(config.issuer).origin,
  });
  return deploymentHandlers;
}

export function createGitHubAppInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>
) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    try {
      return await getGitHubAppInstallationDeploymentHandlers(environment)[
        kind
      ](request);
    } catch {
      logProviderConnectionFailure({
        phase: kind,
        provider: "github",
        reason: "configuration-unavailable",
        request,
        startedAt,
      });
      return new Response(null, {
        headers: {
          ...noStoreHeaders,
          Location:
            "/github/installations?status=failed&reason=configuration-unavailable",
        },
        status: 303,
      });
    }
  };
}
