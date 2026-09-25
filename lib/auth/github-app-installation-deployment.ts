import { createPostgresPreviewOrganizationAuthority } from "./postgres-organization-user-authority";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppHttpProvider,
  parseGitHubAppHttpProviderCredentials,
} from "../repository/github-app-http-provider";
import { classifyGitHubRepositoryAccess } from "../integrations/repository-access";
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
import type { RepositoryAccessResult } from "../integrations/repository-access";
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

interface GuidedRepositoryAccess {
  inspect: (input: {
    authority: Authority;
    continuationId: string;
  }) => Promise<
    { repository: { fullName: string; owner: string }; selectedInstallationId?: string } | undefined
  >;
  classify: (input: {
    authority: Authority;
    repository: string;
    selectedInstallationId?: string;
  }) => Promise<RepositoryAccessResult>;
  authorize: (input: {
    authority: Authority;
    continuationId: string;
  }) => Promise<string | undefined>;
}

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;
const EXISTING_CONNECTION_MODE = "existing";
const REQUEST_INVALID = "request-invalid";
const AUTHORIZATION_EXPIRED = "authorization-expired";
const PROVIDER_UNAVAILABLE = "provider-unavailable";
const ACCOUNT_CHOICE_REQUIRED = "account-choice-required";
const REPOSITORY_ACCESS_MISSING = "repository-access-missing";
const GITHUB_ORIGIN = "https://github.com";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function installationSettingsUrl(input: {
  accountLogin: string;
  accountType: "Organization" | "User";
  installationId: string;
}) {
  const path =
    input.accountType === "Organization"
      ? `/organizations/${encodeURIComponent(input.accountLogin)}/settings/installations/${input.installationId}`
      : `/settings/installations/${input.installationId}`;
  return new URL(path, GITHUB_ORIGIN).toString();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createGitHubAppInstallationRouteHandlers(input: {
  origin: string;
  authorityForRequest: (request: Request) => Promise<Authority | undefined>;
  authorization: InstallationAuthorization;
  repositoryAccess?: GuidedRepositoryAccess;
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
  const redirectLocation = (location: string) =>
    new Response(null, {
      headers: { ...noStoreHeaders, Location: location },
      status: 303,
    });
  const checkRepositoryAccess = async (
    authority: Authority,
    returnState: ProviderConnectionReturn,
  ) => {
    if (returnState.resumeKey === undefined || input.repositoryAccess === undefined) {
      return { kind: "none" } as const;
    }
    const continuationId = returnState.resumeKey;
    const target = await input.repositoryAccess.inspect({ authority, continuationId });
    if (target === undefined) {
      return { kind: AUTHORIZATION_EXPIRED } as const;
    }
    const access = await input.repositoryAccess.classify({
      authority,
      repository: target.repository.fullName,
      selectedInstallationId: target.selectedInstallationId,
    });
    if (access.status === "ready") {
      const callback = await input.repositoryAccess.authorize({ authority, continuationId });
      return callback === undefined
        ? ({ kind: AUTHORIZATION_EXPIRED } as const)
        : ({ callback, kind: "ready" } as const);
    }
    if (access.status === "provider-unavailable") {
      return { kind: PROVIDER_UNAVAILABLE } as const;
    }
    if (access.status === "scope-selection-required") {
      return { kind: ACCOUNT_CHOICE_REQUIRED } as const;
    }
    const matchingScopes = access.scopes.filter(
      (scope) =>
        scope.accountLogin.toLowerCase() === target.repository.owner.toLowerCase() &&
        (target.selectedInstallationId === undefined ||
          scope.installationId === target.selectedInstallationId),
    );
    const configurationUrl =
      matchingScopes.length === 1 && matchingScopes[0]
        ? installationSettingsUrl(matchingScopes[0])
        : undefined;
    return { configurationUrl, kind: "missing", target } as const;
  };
  const finishConnection = async (
    authority: Authority,
    returnState: ProviderConnectionReturn,
    via: "existing" | "installation",
    fail: (reason: ProviderConnectionFailureReason) => Response,
  ): Promise<Response> => {
    const access = await checkRepositoryAccess(authority, returnState);
    if (access.kind === "ready") {
      return redirectLocation(access.callback);
    }
    if (access.kind === AUTHORIZATION_EXPIRED || access.kind === PROVIDER_UNAVAILABLE) {
      return fail(access.kind);
    }
    if (access.kind === ACCOUNT_CHOICE_REQUIRED) {
      return fail(ACCOUNT_CHOICE_REQUIRED);
    }
    if (access.kind === "missing") {
      if (access.configurationUrl !== undefined) {
        return redirectLocation(access.configurationUrl);
      }
      if (via === "existing") {
        const setup = await input.authorization.begin(authority, returnState);
        return redirectLocation(setup.redirectUrl);
      }
      return fail(REPOSITORY_ACCESS_MISSING);
    }
    const continuationRedirect = await input.onConnected?.({ authority, returnState });
    return continuationRedirect === undefined
      ? redirect("connected", undefined, returnState)
      : redirectLocation(continuationRedirect);
  };

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
      if (request.method !== "GET") {
        return fail(REQUEST_INVALID);
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
      if (authority === undefined) {
        return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
          status: 303,
        });
      }

      try {
        const result = await input.authorization.complete(request.url, authority);
        if (result.status === "redirect") {
          return redirectLocation(result.redirectUrl);
        }
        return await finishConnection(authority, result.returnState, result.via, (reason) =>
          fail(reason, undefined, result.returnState),
        );
      } catch (error) {
        let reason: ProviderConnectionFailureReason = "callback-invalid";
        if (
          error instanceof GitHubInstallationAuthorizationError &&
          error.category === "access_denied"
        ) {
          reason = "access-denied";
        }
        return fail(
          reason,
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
        return fail(REQUEST_INVALID);
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
      if (authority === undefined) {
        return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: signInForWorkspaceRedirect(origin),
          },
          status: 303,
        });
      }

      try {
        const formData = await request.formData();
        const returnState = providerConnectionReturnFromFormData(formData);
        const mode = formData.get("connectionMode");
        if (mode !== null && mode !== EXISTING_CONNECTION_MODE) {
          return fail(REQUEST_INVALID, undefined, returnState);
        }
        const access = await checkRepositoryAccess(authority, returnState);
        if (access.kind === "ready") {
          return redirectLocation(access.callback);
        }
        if (access.kind === AUTHORIZATION_EXPIRED || access.kind === PROVIDER_UNAVAILABLE) {
          return fail(access.kind, undefined, returnState);
        }
        if (access.kind === ACCOUNT_CHOICE_REQUIRED) {
          return fail(ACCOUNT_CHOICE_REQUIRED, undefined, returnState);
        }
        if (access.kind === "missing" && access.configurationUrl !== undefined) {
          return redirectLocation(access.configurationUrl);
        }
        const target = access.kind === "missing" ? access.target : undefined;
        const authorizationTarget = target
          ? { accountLogin: target.repository.owner, installationId: target.selectedInstallationId }
          : undefined;
        if (authorizationTarget !== undefined && authorizationTarget.installationId === undefined) {
          delete authorizationTarget.installationId;
        }
        const result = await input.authorization.beginExisting(
          authority,
          returnState,
          authorizationTarget,
        );
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
    async target(request: Request, continuationId: string) {
      const authority = await input.authorityForRequest(request);
      if (!authority || !input.repositoryAccess) {
        return;
      }
      return input.repositoryAccess.inspect({ authority, continuationId });
    },
  };
}

let deploymentHandlers: ReturnType<typeof createGitHubAppInstallationRouteHandlers> | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function getGitHubAppInstallationDeploymentHandlers(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentHandlers !== undefined) {
    return deploymentHandlers;
  }
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
  const installations = createPostgresHostedGitHubInstallationStore(database);
  const providerFetch = emulation
    ? (resource: string | URL | Request, init?: RequestInit) => {
        const url = new URL(resource instanceof Request ? resource.url : resource);
        return providerEmulationFetch(
          `${emulation.githubOrigin}${url.pathname}${url.search}`,
          init,
          emulation,
        );
      }
    : undefined;
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    credentialStore,
    emulation,
    fetch: emulation
      ? (resource, init) => providerEmulationFetch(resource as string | URL, init, emulation)
      : undefined,
    installationStore: installations,
    membership: {
      isActiveMember: (authority) => membership.isActiveMember(authority),
    },
    stateStore: createPostgresGitHubInstallationAuthorizationStateStore(database),
  });
  const repositoryAccessContinuations = createRepositoryAccessContinuationService({
    store: createPostgresRepositoryAccessContinuationStore(database),
  });
  const classify = (value: {
    authority: Authority;
    repository: string;
    selectedInstallationId?: string;
  }) => {
    const providerCredentials = parseGitHubAppHttpProviderCredentials({
      appId: config.appId,
      privateKey: resolvedEnvironment.GITHUB_APP_PRIVATE_KEY,
    });
    const options = {
      authority: value.authority,
      installations,
      providerFactory: ({ installation }: { installation: { installationId: string } }) =>
        createGitHubAppHttpProvider({
          config: { ...providerCredentials, installationId: installation.installationId },
          fetch: providerFetch,
        }),
      repository: value.repository,
      selectedInstallationId: value.selectedInstallationId,
    };
    return classifyGitHubRepositoryAccess(options);
  };
  deploymentHandlers = createGitHubAppInstallationRouteHandlers({
    async authorityForRequest(request) {
      const session = await ensurePreviewOAuthDeploymentSessionOrganization({
        environment: resolvedEnvironment,
        headers: request.headers,
      });
      if (session === undefined) {
        return;
      }
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
      if (!returnState.resumeKey) {
        return;
      }
      return repositoryAccessContinuations.authorize({
        authority,
        continuationId: returnState.resumeKey,
      });
    },
    origin: new URL(config.issuer).origin,
    repositoryAccess: {
      authorize: (value) => repositoryAccessContinuations.authorize(value),
      classify,
      inspect: (value) => repositoryAccessContinuations.inspect(value),
    },
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function verifiedGitHubConnectionTarget(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  headers: Headers;
  resumeKey: string;
}) {
  try {
    const config = readGitHubAppInstallationEnvironment(
      providerEmulationEnvironment(input.environment),
    );
    return await getGitHubAppInstallationDeploymentHandlers(input.environment).target(
      new Request(new URL("/github/installations", config.issuer), { headers: input.headers }),
      input.resumeKey,
    );
  } catch {
    // No verified target is available for this page load.
  }
}
