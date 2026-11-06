import { z } from "zod";

import type { BuilderHandoffIntent } from "../handoff/contracts";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { parseRepositoryReference } from "../integrations/repository-access";
import type { RepositoryAccessResult } from "../integrations/repository-access";
import type { VercelInstallationBinding } from "../integrations/vercel-installation";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type { RepositoryAccessToolInput } from "./repository-access-tool";
import { readJsonStringChecks } from "./streaming-json-pointer";
import { readPreparedHandoffContext } from "./handoff-context";

// Cache infrastructure only. Handoff, membership, bindings, and decrypted
// credentials are re-read for the authenticated tenant on each invocation.
let providerDatabase: ReturnType<typeof openHostedPostgresDatabase> | undefined;

// The additive providers field is supplied by the handoff backend. The
// intersection also accepts records written before provider selections existed.
type PreparedIntent = BuilderHandoffIntent & {
  providers?: { githubInstallationId?: string; vercelInstallationId?: string };
};
interface SessionAuth {
  current: { attributes: Record<string, string>; issuer: string };
  initiator: { attributes: Record<string, string>; issuer: string };
}
const sourceHandoffIdSchema = z.uuid();
const handoffSourceAttribute = "autograph:source-handoff-id";
const issuerSchema = z.url();
const handoffUnavailableMessage = "Provider authority is unavailable.";
const authorizationRequiredStatus = "authorization-required" as const;
const providerUnavailableStatus = "provider-unavailable" as const;
const retryAction = "retry" as const;

/** Call only after the durable handoff reader has verified the session. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function preparedHandoffReturnPath(sessionAuth: SessionAuth) {
  const parsed = z
    .object({
      initiator: z.object({
        attributes: z.object({
          [handoffSourceAttribute]: sourceHandoffIdSchema,
        }),
      }),
    })
    .safeParse(sessionAuth);
  return parsed.success
    ? (`/handoff/${parsed.data.initiator.attributes[handoffSourceAttribute]}` as const)
    : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function preparedGitHubRepository(intent: PreparedIntent) {
  return (
    intent.repository.resolvedFullName ??
    (intent.provisioning?.github.status === "succeeded"
      ? intent.provisioning.github.fullName
      : undefined)
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function withPreparedGitHubSelection(
  input: RepositoryAccessToolInput,
  intent: PreparedIntent | undefined,
): RepositoryAccessToolInput {
  if (!intent || input.selectedInstallationId !== undefined) {
    return input;
  }
  const preparedRepository = preparedGitHubRepository(intent);
  if (
    preparedRepository === undefined ||
    preparedRepository === "" ||
    preparedRepository.toLowerCase() !== input.repository.toLowerCase()
  ) {
    return input;
  }
  const selectedInstallationId =
    intent.providers?.githubInstallationId ??
    (intent.provisioning?.github.status === "succeeded"
      ? intent.provisioning.github.installationId
      : undefined);
  return selectedInstallationId !== undefined && selectedInstallationId !== ""
    ? { ...input, selectedInstallationId }
    : input;
}

interface VercelCredential {
  binding: VercelInstallationBinding;
  token: string;
}
type Authority = ReturnType<typeof exactForwardedSessionAuthority>["authority"];
interface VercelScope {
  installationId: string;
  type: "team" | "user";
  id: string;
  slug: string;
}
export type PreparedVercelAccess =
  | { status: "not-selected" }
  | { status: "resource-unavailable"; action: "review-selection" }
  | {
      status: "authorization-required";
      action: "reconnect";
      reconnectUrl?: string;
    }
  | { status: "provider-unavailable"; action: "retry"; retryable: true }
  | {
      status: "ready";
      scope: VercelScope;
      project?: { id: string; name: string; productionBranch?: string };
    };

const unavailable = (): PreparedVercelAccess => ({
  action: "retry",
  retryable: true,
  status: providerUnavailableStatus,
});
const reconnect = (): PreparedVercelAccess => ({
  action: "reconnect",
  status: authorizationRequiredStatus,
});

type VercelProjectAccessStage = "credential-read" | "provider-fetch" | "provider-json";
const resourceUnavailable = { action: "review-selection", status: "resource-unavailable" } as const;
const retryAfterHeader = "retry-after";
interface PreparedRepositoryProjection {
  private: boolean;
  requestedName: string;
  fullName?: string;
}
interface VercelEmulationOptions {
  apiOrigin?: string;
  fetch?: (resource: string | URL, init?: RequestInit) => Promise<Response>;
}
const projectApiOrigin = "https://api.vercel.com";
const providerUserAgent = "autograph-app-builder";
const requireGithubExpected = { expected: "github", pointer: "/link/type" };
const requireServicesFramework = { expected: "services", pointer: "/framework" };
const requireServicesRoot = { expected: ".", pointer: "/rootDirectory" };
const requireOidcEnabled = { expectedLiteral: "true", pointer: "/oidcTokenConfig/enabled" };
const vercelProjectAccessReasons = {
  authorizationRequired: authorizationRequiredStatus,
  credentialUnavailable: "credential-unavailable",
  installationMismatch: "installation-mismatch",
  projectResponseMismatch: "project-response-mismatch",
  projectUnavailable: "project-unavailable",
  providerUnavailable: providerUnavailableStatus,
  rateLimited: "rate-limited",
  readFailed: "read-failed",
  scopeMismatch: "scope-mismatch",
} as const;
interface VercelProjectAccessFailure {
  stage: VercelProjectAccessStage;
  reason: (typeof vercelProjectAccessReasons)[keyof typeof vercelProjectAccessReasons];
  credentialsPresent?: boolean;
  bindingActive?: boolean;
  installationMatches?: boolean;
  expectedScopeIdMatches?: boolean;
  expectedScopeTypeMatches?: boolean;
  httpStatus?: number;
  retryAfterPresent?: boolean;
  idMatches?: boolean;
  namePresent?: boolean;
  accountMatches?: boolean;
  errorClass?: "type_error" | "error" | "other";
}

const recordVercelProjectAccessFailure = (read: () => VercelProjectAccessFailure) => {
  try {
    console.info("[builder:vercel-project-access]", JSON.stringify(read()));
  } catch {
    /* Advisory diagnostics never change access classification. */
  }
};

const readVercelProjectAccess = async (input: {
  authority: Authority;
  projectId: string;
  requireServicesRoot?: boolean;
  requirePublicAppConfiguration?: boolean;
  requireExpectedRepositoryId?: string;

  projectName?: string;
  installationId: string;
  expectedScope?: { id: string; type: "team" | "user" };
  readCredential: (input: {
    authority: Authority;
    installationId: string;
  }) => Promise<VercelCredential | undefined>;
  fetch?: typeof fetch;
  apiOrigin?: string;
}): Promise<PreparedVercelAccess> => {
  let diagnosticStage: VercelProjectAccessStage = "credential-read";
  try {
    const credential = await input.readCredential({
      authority: input.authority,
      installationId: input.installationId,
    });
    if (!credential || !credential.binding.active) {
      recordVercelProjectAccessFailure(() => ({
        bindingActive: credential?.binding.active === true,
        credentialsPresent: Boolean(credential),
        reason: vercelProjectAccessReasons.credentialUnavailable,
        stage: diagnosticStage,
      }));
      return reconnect();
    }
    const { binding, token } = credential;
    if (binding.installationId !== input.installationId) {
      recordVercelProjectAccessFailure(() => ({
        bindingActive: true,
        credentialsPresent: true,
        installationMatches: false,
        reason: vercelProjectAccessReasons.installationMismatch,
        stage: diagnosticStage,
      }));
      return unavailable();
    }
    if (
      input.expectedScope &&
      (binding.scopeId !== input.expectedScope.id || binding.scopeType !== input.expectedScope.type)
    ) {
      recordVercelProjectAccessFailure(() => ({
        expectedScopeIdMatches: binding.scopeId === input.expectedScope?.id,
        expectedScopeTypeMatches: binding.scopeType === input.expectedScope?.type,
        installationMatches: true,
        reason: vercelProjectAccessReasons.scopeMismatch,
        stage: diagnosticStage,
      }));
      return resourceUnavailable;
    }
    diagnosticStage = "provider-fetch";
    const url = new URL(
      `${input.apiOrigin ?? projectApiOrigin}/v9/projects/${encodeURIComponent(input.projectId)}`,
    );
    if (binding.scopeType === "team") {
      url.searchParams.set("teamId", binding.scopeId);
    }
    const response = await (input.fetch ?? fetch)(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": providerUserAgent,
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 403 && response.headers.has(retryAfterHeader)) {
      recordVercelProjectAccessFailure(() => ({
        httpStatus: response.status,
        reason: vercelProjectAccessReasons.rateLimited,
        retryAfterPresent: true,
        stage: diagnosticStage,
      }));
      await response.body?.cancel();
      return unavailable();
    }
    if (response.status === 404) {
      recordVercelProjectAccessFailure(() => ({
        httpStatus: response.status,
        reason: vercelProjectAccessReasons.projectUnavailable,
        retryAfterPresent: response.headers.has(retryAfterHeader),
        stage: diagnosticStage,
      }));
      await response.body?.cancel();
      return resourceUnavailable;
    }
    if ([401, 403].includes(response.status)) {
      recordVercelProjectAccessFailure(() => ({
        httpStatus: response.status,
        reason: vercelProjectAccessReasons.authorizationRequired,
        retryAfterPresent: response.headers.has(retryAfterHeader),
        stage: diagnosticStage,
      }));
      await response.body?.cancel();
      return reconnect();
    }
    if (response.status !== 200) {
      recordVercelProjectAccessFailure(() => ({
        httpStatus: response.status,
        reason: vercelProjectAccessReasons.providerUnavailable,
        retryAfterPresent: response.headers.has(retryAfterHeader),
        stage: diagnosticStage,
      }));
      await response.body?.cancel();
      return unavailable();
    }
    diagnosticStage = "provider-json";
    const checks = [
      { expected: input.projectId, pointer: "/id" },
      { capture: true, pointer: "/name" },
      {
        expected: binding.scopeId,
        optional: input.requireServicesRoot !== true,
        pointer: "/accountId",
      },
      { capture: true, optional: true, pointer: "/link/productionBranch" },
    ];
    if (input.requireServicesRoot === true) {
      checks.push(requireServicesFramework, requireServicesRoot);
    }
    if (input.requireExpectedRepositoryId !== undefined) {
      checks.push(requireGithubExpected, {
        expectedDecimal: input.requireExpectedRepositoryId,
        pointer: "/link/repoId",
      });
    }
    if (input.requirePublicAppConfiguration === true) {
      checks.push(
        {
          expected: "prod_deployment_urls_and_all_previews",
          pointer: "/ssoProtection/deploymentType",
        },
        requireOidcEnabled,
        { expected: "team", pointer: "/oidcTokenConfig/issuerMode" },
      );
    }
    const observed = await readJsonStringChecks(response.body, checks);
    const [idMatches, hasName, accountMatches] = observed.matches;
    if (observed.matches.some((matches) => !matches)) {
      recordVercelProjectAccessFailure(() => ({
        accountMatches,
        httpStatus: response.status,
        idMatches,
        namePresent: hasName,
        reason: vercelProjectAccessReasons.projectResponseMismatch,
        stage: diagnosticStage,
      }));
      return unavailable();
    }
    const project = {
      id: input.projectId,
      name: observed.values[1] ?? input.projectName ?? input.projectId,
    } satisfies NonNullable<Extract<PreparedVercelAccess, { status: "ready" }>["project"]>;
    const productionBranch = observed.values.at(-1);
    if (productionBranch !== undefined) {
      project.productionBranch = productionBranch;
    }
    return {
      project,
      scope: {
        id: binding.scopeId,
        installationId: input.installationId,
        slug: binding.slug,
        type: binding.scopeType,
      },
      status: "ready",
    };
  } catch (error) {
    recordVercelProjectAccessFailure(() => {
      let errorClass: VercelProjectAccessFailure["errorClass"] = "other";
      if (error instanceof TypeError) {
        errorClass = "type_error";
      } else if (error instanceof Error) {
        errorClass = "error";
      }
      return {
        errorClass,
        reason: vercelProjectAccessReasons.readFailed,
        stage: diagnosticStage,
      };
    });
    return unavailable();
  }
};

/** Read one exact owner-selected Vercel project under a current installation grant. */
// eslint-disable-next-line eslint/func-style -- Keep provider access helpers as declarations.
export async function readOwnerVercelProjectAccess(input: {
  authority: Authority;
  projectId: string;
  requireServicesRoot?: boolean;
  requirePublicAppConfiguration?: boolean;
  requireExpectedRepositoryId?: string;
  expectedScope?: VercelScope;

  installationId: string;
  readCredential: (input: {
    authority: Authority;
    installationId: string;
  }) => Promise<VercelCredential | undefined>;
  fetch?: typeof fetch;
  apiOrigin?: string;
}): Promise<PreparedVercelAccess> {
  return await readVercelProjectAccess(input);
}

/** Server-only credential read followed by a fresh, read-only provider request. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readPreparedVercelAccess(input: {
  intent: PreparedIntent;
  requireServicesRoot?: boolean;
  requirePublicAppConfiguration?: boolean;
  requireExpectedRepositoryId?: string;

  authority: Authority;
  readCredential: (input: {
    authority: Authority;
    installationId: string;
  }) => Promise<VercelCredential | undefined>;
  fetch?: typeof fetch;
  apiOrigin?: string;
}): Promise<PreparedVercelAccess> {
  const project =
    input.intent.provisioning?.vercel.status === "succeeded"
      ? input.intent.provisioning.vercel
      : undefined;
  const installationId = input.intent.providers?.vercelInstallationId ?? project?.installationId;
  if (installationId === undefined || installationId === "") {
    return { status: "not-selected" };
  }
  if (project !== undefined) {
    if (project.installationId !== installationId) {
      return resourceUnavailable;
    }
    const accessInput: Parameters<typeof readVercelProjectAccess>[0] = {
      authority: input.authority,
      expectedScope: project.scope,
      installationId,
      projectId: project.projectId,
      projectName: project.name,
      readCredential: input.readCredential,
      requireExpectedRepositoryId: input.requireExpectedRepositoryId,
      requirePublicAppConfiguration: input.requirePublicAppConfiguration,
      requireServicesRoot: input.requireServicesRoot,
    };
    if (input.fetch !== undefined) {
      accessInput.fetch = input.fetch;
    }
    if (input.apiOrigin !== undefined) {
      accessInput.apiOrigin = input.apiOrigin;
    }
    return await readVercelProjectAccess(accessInput);
  }
  try {
    const credential = await input.readCredential({
      authority: input.authority,
      installationId,
    });
    if (!credential || !credential.binding.active) {
      return reconnect();
    }
    if (credential.binding.installationId !== installationId) {
      return unavailable();
    }
    const { binding, token } = credential;
    const path =
      binding.scopeType === "team"
        ? `/v2/teams/${encodeURIComponent(binding.scopeId)}`
        : "/v2/user";
    const url = new URL(`${input.apiOrigin ?? "https://api.vercel.com"}${path}`);
    const response = await (input.fetch ?? fetch)(url, {
      cache: "no-store",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
        "User-Agent": "autograph-app-builder",
      },
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(20_000),
    });
    // Classify status before reading provider bodies, which can contain secrets
    // or an HTML outage page. Match the existing provider credential semantics.
    if (response.status === 403 && response.headers.has(retryAfterHeader)) {
      await response.body?.cancel();
      return unavailable();
    }
    if (response.status === 404) {
      await response.body?.cancel();
      return { action: "review-selection", status: "resource-unavailable" };
    }
    if ([401, 403].includes(response.status)) {
      await response.body?.cancel();
      return reconnect();
    }
    if (response.status !== 200) {
      await response.body?.cancel();
      return unavailable();
    }
    const scope: VercelScope = {
      id: binding.scopeId,
      installationId,
      slug: binding.slug,
      type: binding.scopeType,
    };
    const {
      matches: [scopeMatches],
    } = await readJsonStringChecks(response.body, [
      {
        expected: binding.scopeId,
        pointer: binding.scopeType === "team" ? "/id" : "/user/id",
      },
    ]);
    if (!scopeMatches) {
      return unavailable();
    }
    return { scope, status: "ready" };
  } catch {
    return unavailable();
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPreparedAppContextReader(input: {
  readHandoff: (sessionAuth: SessionAuth) => Promise<PreparedIntent | undefined>;
  github: (
    sessionAuth: SessionAuth,
    input: RepositoryAccessToolInput,
  ) => Promise<RepositoryAccessResult>;
  vercel: (sessionAuth: SessionAuth, intent: PreparedIntent) => Promise<PreparedVercelAccess>;
}) {
  return async (sessionAuth: SessionAuth) => {
    // The trusted reader establishes tenant ownership before any provider work.
    const intent = await input.readHandoff(sessionAuth);
    if (intent === undefined) {
      return { status: "not-prepared" as const };
    }
    const repository = preparedGitHubRepository(intent);
    let github: RepositoryAccessResult | undefined;
    if (repository !== undefined && repository !== "") {
      try {
        github = await input.github(
          sessionAuth,
          withPreparedGitHubSelection({ repository }, intent),
        );
      } catch {
        github = {
          repository: parseRepositoryReference(repository),
          status: providerUnavailableStatus,
        };
      }
    }
    let vercel: PreparedVercelAccess;
    try {
      vercel = await input.vercel(sessionAuth, intent);
    } catch {
      vercel = unavailable();
    }
    const returnTo = preparedHandoffReturnPath(sessionAuth);
    const reconnectUrl = (provider: "github" | "vercel") =>
      returnTo !== undefined && returnTo !== ""
        ? new URL(
            `/${provider}/installations?${new URLSearchParams({ returnTo })}`,
            // readHandoff has already verified this originating session.
            z.object({ initiator: z.object({ issuer: issuerSchema }) }).parse(sessionAuth).initiator
              .issuer,
          ).toString()
        : undefined;
    const githubAccess: {
      status: string;
      scope?: { accountLogin: string; accountType: string; installationId: string };
      action?: "reconnect" | "retry";
      reconnectUrl?: string;
      retryable?: true;
    } = github === undefined ? { status: "not-prepared" } : { status: github.status };
    if (github?.status === "ready") {
      githubAccess.scope = {
        accountLogin: github.scope.accountLogin,
        accountType: github.scope.accountType,
        installationId: github.scope.installationId,
      };
    }
    if (github?.status === authorizationRequiredStatus) {
      githubAccess.action = "reconnect";
      githubAccess.reconnectUrl = reconnectUrl("github");
    }
    if (github?.status === providerUnavailableStatus) {
      githubAccess.action = retryAction;
      githubAccess.retryable = true;
    }
    const repositoryProjection: PreparedRepositoryProjection = {
      private: intent.repository.private,
      requestedName: intent.repository.requestedName,
    };
    if (repository !== undefined && repository !== "") {
      repositoryProjection.fullName = repository;
    }
    // Explicit projection: never spread auth, credentials, raw provider payloads,
    // or the provisioning journal into durable model-visible output.
    return {
      access: {
        github: githubAccess,
        vercel:
          vercel.status === "authorization-required"
            ? { ...vercel, reconnectUrl: reconnectUrl("vercel") }
            : vercel,
      },
      app: {
        brief: intent.brief,
        connections: [...intent.connections],
        id: intent.appId,
        modelId: intent.modelId,
        name: intent.appName,
      },
      provisioning: intent.provisioning
        ? {
            github: intent.provisioning.github.status,
            vercel: intent.provisioning.vercel.status,
          }
        : undefined,
      repository: repositoryProjection,
      resources: {
        github:
          intent.provisioning?.github.status === "succeeded"
            ? {
                fullName: intent.provisioning.github.fullName,
                installationId: intent.provisioning.github.installationId,
                repositoryId: intent.provisioning.github.repositoryId,
              }
            : undefined,
        vercel:
          intent.provisioning?.vercel.status === "succeeded"
            ? {
                installationId: intent.provisioning.vercel.installationId,
                name: intent.provisioning.vercel.name,
                projectId: intent.provisioning.vercel.projectId,
                scope: {
                  id: intent.provisioning.vercel.scope.id,
                  slug: intent.provisioning.vercel.scope.slug,
                  type: intent.provisioning.vercel.scope.type,
                },
              }
            : undefined,
      },
      status: "prepared" as const,
    };
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function readPreparedAppContext(sessionAuth: SessionAuth) {
  const parsedSessionAuth = z
    .object({
      current: z.object({ attributes: z.record(z.string(), z.string()), issuer: z.url() }),
      initiator: z.object({ attributes: z.record(z.string(), z.string()), issuer: z.url() }),
    })
    .parse(sessionAuth);
  return await createPreparedAppContextReader({
    async github(auth, value) {
      const { repositoryAccessRuntimeForSession } =
        await import("./deployment-repository-access-runtime");
      const runtime = await repositoryAccessRuntimeForSession(auth);
      return await runtime.classify(value);
    },
    readHandoff: readPreparedHandoffContext,
    async vercel(auth, intent) {
      const { authority, principal } = exactForwardedSessionAuthority(auth);
      const [
        { createPostgresWorkspaceMembership },
        { openHostedPostgresDatabase },
        { readActiveVercelInstallationToken },
        { readVercelIntegrationEnvironment },
        { providerEmulationEnvironment, readProviderEmulation },
        { providerEmulationFetch },
      ] = await Promise.all([
        import("../eve/postgres-workspace-membership"),
        import("../mcp/hosted-route"),
        import("../integrations/postgres-vercel-installation"),
        import("../integrations/vercel-installation"),
        import("../integrations/local-provider-emulation"),
        import("../integrations/provider-emulation-fetch"),
      ]);
      return await readPreparedVercelAccess({
        authority,
        intent,
        async readCredential(value) {
          const environment = providerEmulationEnvironment(process.env);
          const config = readVercelIntegrationEnvironment(environment);
          if (config.issuer !== authority.issuer || config.resource !== authority.audience) {
            throw new Error(handoffUnavailableMessage);
          }
          providerDatabase ??= openHostedPostgresDatabase(environment.DATABASE_URL ?? "");
          const database = providerDatabase;
          if (
            !(await createPostgresWorkspaceMembership(database).isMember({
              principal,
              workspaceId: authority.workspaceId,
            }))
          ) {
            throw new Error(handoffUnavailableMessage);
          }
          return await readActiveVercelInstallationToken({
            ...value,
            config,
            database,
          });
        },
        ...(() => {
          const emulation = readProviderEmulation(process.env);
          const options: VercelEmulationOptions = {};
          if (emulation !== undefined) {
            options.apiOrigin = emulation.vercelOrigin;
            options.fetch = async (resource, init) =>
              await providerEmulationFetch(resource, init, emulation);
          }
          return options;
        })(),
      });
    },
  })(parsedSessionAuth);
}
