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
import { createPostgresRepositoryAccessContinuationStore } from "../integrations/postgres-repository-access-continuation";
import { createRepositoryAccessContinuationService } from "../integrations/repository-access-continuation";
import { logProviderConnectionFailure } from "../integrations/provider-connection-logging";
import { readGitHubUserCredentialEnvironment } from "../provisioning/github-user-credential";
import { createPostgresGitHubUserCredentialStore } from "../provisioning/postgres-github-user-credential";
import type { ProviderConnectionFailureReason } from "../integrations/provider-connection-status";
import {
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
} from "../integrations/provider-connection-return";
import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";
import { signInForWorkspaceRedirect, workspaceOnboardingRedirect } from "./workspace-onboarding";

interface Authority {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
}

type InstallationAuthorization = ReturnType<typeof createGitHubAppInstallationAuthorization>;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createGitHubAppInstallationRouteHandlers(input: {
  origin: string;
  authorityForRequest: (request: Request) => Promise<Authority | undefined>;
  authorization: InstallationAuthorization;
  onConnected?: (input: {
    authority: Authority;
    returnState: ProviderConnectionReturn;
  }) => Promise<string | undefined>;
}) {
  const { origin } = new URL(input.origin);
  const redirect = (
    status: "connected" | "failed",
    reason?: ProviderConnectionFailureReason,
    returnState?: ProviderConnectionReturn,
  ) =>
    new Response(null, {
      headers: {
        ...noStoreHeaders,
        Location: providerConnectionRedirect({
          origin,
          provider: "github",
          reason,
          returnState,
          status,
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
        returnState?: ProviderConnectionReturn,
      ) => {
        logProviderConnectionFailure({
          diagnostic,
          phase: "callback",
          provider: "github",
          reason,
          request,
          startedAt,
        });
        return redirect("failed", reason, returnState);
      };
      if (request.method !== "GET") {return fail("request-invalid");}

      let authority: Authority | undefined;
      try {
        authority = await input.authorityForRequest(request);
      } catch {
        return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: workspaceOnboardingRedirect(origin, "workspace-setup-retry"),
          },
          status: 303,
        });
      }
      if (authority === undefined)
        {return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
          status: 303,
        });}

      try {
        const result = await input.authorization.complete(request.url, authority);
        if (result.status === "redirect") {
          return new Response(null, {
            headers: { ...noStoreHeaders, Location: result.redirectUrl },
            status: 303,
          });
        }
        const continuationRedirect = await input.onConnected?.({
          authority,
          returnState: result.returnState,
        });
        if (continuationRedirect) {
          return new Response(null, {
            headers: { ...noStoreHeaders, Location: continuationRedirect },
            status: 303,
          });
        }
        return redirect("connected", undefined, result.returnState);
      } catch (error) {
        return fail(
          "callback-invalid",
          githubInstallationAuthorizationDiagnostic(error),
          error instanceof GitHubInstallationAuthorizationError ? error.returnState : undefined,
        );
      }
    },

    async start(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (
        reason: ProviderConnectionFailureReason,
        diagnostic?: { stage: string; category?: string },
        returnState?: ProviderConnectionReturn,
      ) => {
        logProviderConnectionFailure({
          diagnostic,
          phase: "start",
          provider: "github",
          reason,
          request,
          startedAt,
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
          headers: {
            ...noStoreHeaders,
            Location: workspaceOnboardingRedirect(origin, "workspace-setup-retry"),
          },
          status: 303,
        });
      }
      if (authority === undefined)
        {return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
          status: 303,
        });}

      try {
        const returnState = providerConnectionReturnFromFormData(await request.formData());
        const result = await input.authorization.begin(authority, returnState);
        return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: result.redirectUrl,
          },
          status: 303,
        });
      } catch {
        return fail("authorization-failed");
      }
    },
  };
}

let deploymentHandlers: ReturnType<typeof createGitHubAppInstallationRouteHandlers> | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getGitHubAppInstallationDeploymentHandlers(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentHandlers !== undefined) {return deploymentHandlers;}
  const resolvedEnvironment = providerEmulationEnvironment(environment);
  const config = readGitHubAppInstallationEnvironment(resolvedEnvironment);
  const previewConfig = readPreviewOAuthRuntimeConfig(resolvedEnvironment);
  const database = openHostedPostgresDatabase(previewConfig.databaseUrl);
  let credentialStore: ReturnType<typeof createPostgresGitHubUserCredentialStore> | undefined;
  try {
    credentialStore = createPostgresGitHubUserCredentialStore({
      config: readGitHubUserCredentialEnvironment(environment),
      database,
    });
  } catch {
    // Fall back to the default credential store when configuration is unavailable.
  }
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
      ? (resource, init) => providerEmulationFetch(resource as string | URL, init, emulation)
      : undefined,
    installationStore: createPostgresHostedGitHubInstallationStore(database),
    membership: {
      isActiveMember: (authority) => membership.isActiveMember(authority),
    },
    stateStore: createPostgresGitHubInstallationAuthorizationStateStore(database),
  });
  const repositoryAccessContinuations = createRepositoryAccessContinuationService({
    store: createPostgresRepositoryAccessContinuationStore(database),
  });
  deploymentHandlers = createGitHubAppInstallationRouteHandlers({
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment: resolvedEnvironment,
        headers: request.headers,
      });
      if (session === undefined) {return;}
      return {
        audience: config.resource,
        issuer: config.issuer,
        ownerUserId: session.user.id,
        workspaceId: session.organization.workspaceId,
      };
    },
    authorization,
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async onConnected({ authority, returnState }) {
      if (!returnState.resumeKey) {return;}
      return repositoryAccessContinuations.authorize({
        authority,
        continuationId: returnState.resumeKey,
      });
    },
    origin: new URL(config.issuer).origin,
  });
  return deploymentHandlers;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createGitHubAppInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request): Promise<Response> => {
    const startedAt = Date.now();
    try {
      return await getGitHubAppInstallationDeploymentHandlers(environment)[kind](request);
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
          Location: "/github/installations?status=failed&reason=configuration-unavailable",
        },
        status: 303,
      });
    }
  };
}
