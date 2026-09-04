import {
  ConnectionAuthorizationFailedError,
  ConnectionAuthorizationRequiredError,
  defineInteractiveAuthorization,
  type ConnectionPrincipal,
  type InteractiveAuthorizationDefinition,
} from "eve/connections";
import type { SandboxSession } from "eve/sandbox";

import { readGitHubAppInstallationEnvironment } from "../auth/github-app-installation";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { createPostgresRepositoryAccessContinuationStore } from "../integrations/postgres-repository-access-continuation";
import {
  classifyGitHubRepositoryAccess,
  type GitHubRepositoryAccessProvider,
  type ReadyRepositoryAccess,
  type RepositoryAccessResult,
} from "../integrations/repository-access";
import { createRepositoryAccessContinuationService } from "../integrations/repository-access-continuation";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createGitHubAppSourceResolutionAdapter,
  type GitHubAppSourceResolutionProvider,
} from "../repository/github-app-adapter";
import {
  createGitHubAppHttpProvider,
  parseGitHubAppHttpProviderCredentials,
} from "../repository/github-app-http-provider";
import {
  mergeHostedGitHubInstallationBindings,
  createPostgresHostedGitHubInstallationStore,
} from "../repository/postgres-github-installation-store";
import {
  assertExactImmutableGitHubSourceReceipt,
  resolveImmutableExistingSource,
  type ImmutableGitHubSourceReceipt,
} from "../repository/github-publication";
import { readSandboxGitHubSourceSnapshot } from "../repository/sandbox-github-source";
import {
  inspectExistingRepositorySnapshotReceipt,
  type SourceReceipt,
} from "../repository/source-receipt";
import {
  recordPreparedSandboxWorkspace,
  type PreparedSandboxWorkspace,
} from "../repository/supported-template";
import {
  assertResolvedSourceMatchesRepositoryAccess,
  recordRepositoryAccessReceipt,
  type RepositoryAccessReceipt,
} from "./repository-access-state";
import { configureVercelSessionGitSource } from "../sandbox/vercel-session-source";

const failed = (reason: string, message: string, retryable = false) =>
  new ConnectionAuthorizationFailedError("github-repository-access", {
    reason,
    retryable,
    message,
  });

function exactPrincipal(
  principal: ConnectionPrincipal,
  expected: { ownerUserId: string; issuer: string },
) {
  if (
    principal.type !== "user" ||
    principal.id !== expected.ownerUserId ||
    principal.issuer !== expected.issuer
  ) {
    throw failed(
      "principal_mismatch",
      "The GitHub access request does not match the signed-in user.",
    );
  }
}

export interface RepositoryAccessRuntime {
  classify(input: {
    repository: string;
    selectedInstallationId?: string;
  }): Promise<RepositoryAccessResult>;
  authorization(input: {
    repository: string;
    selectedInstallationId?: string;
    sessionId: string;
    requestId: string;
  }): InteractiveAuthorizationDefinition<{ continuationId: string }>;
  resumeAuthorizedForSession(input: {
    sessionId: string;
    fetchImplementation?: typeof fetch;
  }): Promise<number>;
  prepareExistingSource(input: {
    repository: string;
    selectedInstallationId?: string;
    access: ReadyRepositoryAccess;
    currentAccessReceipt: RepositoryAccessReceipt | undefined;
    sessionId: string;
    callId: string;
    /** Resolves the Eve sandbox only after provider source is configured. */
    sandbox: SandboxSession | (() => Promise<SandboxSession>);
    currentGitHubSource?: ImmutableGitHubSourceReceipt;
  }): Promise<{
    accessReceipt: RepositoryAccessReceipt;
    githubSource: ImmutableGitHubSourceReceipt;
    sourceReceipt: SourceReceipt;
    workspace: PreparedSandboxWorkspace;
  }>;
}

type GitHubRepositorySourceProvider = GitHubRepositoryAccessProvider &
  GitHubAppSourceResolutionProvider & {
    acquireRepositoryReadCredential(input: {
      repositoryId: string;
    }): Promise<{ token: string }>;
  };

function repositorySourceProvider(
  value: GitHubRepositoryAccessProvider,
): value is GitHubRepositorySourceProvider {
  const candidate = value as Partial<GitHubRepositorySourceProvider>;
  return (
    typeof candidate.inspectRepository === "function" &&
    typeof candidate.acquireRepositoryReadCredential === "function"
  );
}

export function createRepositoryAccessRuntime(input: {
  authority: {
    issuer: string;
    audience: string;
    workspaceId: string;
    ownerUserId: string;
  };
  origin: string;
  installations: Parameters<
    typeof classifyGitHubRepositoryAccess
  >[0]["installations"];
  providerFactory: Parameters<
    typeof classifyGitHubRepositoryAccess
  >[0]["providerFactory"];
  continuations: ReturnType<typeof createRepositoryAccessContinuationService>;
}): RepositoryAccessRuntime {
  const classify = (value: {
    repository: string;
    selectedInstallationId?: string;
  }) =>
    classifyGitHubRepositoryAccess({
      authority: input.authority,
      ...value,
      installations: input.installations,
      providerFactory: input.providerFactory,
    });

  return {
    classify,
    async prepareExistingSource(value) {
      const initialAccessReceipt = recordRepositoryAccessReceipt({
        current: value.currentAccessReceipt,
        sessionId: value.sessionId,
        confirmedByCallId: value.callId,
        access: value.access,
      });
      const listed = (await input.installations.list?.(input.authority)) ?? [];
      const legacy = await input.installations.read(input.authority);
      const binding = mergeHostedGitHubInstallationBindings(
        listed,
        legacy,
      ).find(
        (candidate) =>
          candidate.active &&
          candidate.installationId === value.access.scope.installationId &&
          candidate.accountLogin === value.access.scope.accountLogin &&
          candidate.accountType === value.access.scope.accountType,
      );
      if (binding === undefined)
        throw new Error(
          "The selected GitHub installation is no longer active.",
        );
      const provider = await input.providerFactory({
        authority: input.authority,
        installation: binding,
      });
      if (!repositorySourceProvider(provider))
        throw new Error("GitHub source preparation is unavailable.");

      const ref = `refs/heads/${value.access.repository.defaultBranch}`;
      const observedGitHubSource = await resolveImmutableExistingSource({
        adapter: createGitHubAppSourceResolutionAdapter(provider),
        expectedInstallationId: binding.installationId,
        repositoryId: value.access.repository.repositoryId,
        ref,
        expectedSha: value.access.repository.headSha,
        expectedTree: value.access.repository.headTree,
        resolvedByCallId: value.callId,
      });
      // Repository metadata is diagnostic context, not a source-drift gate.
      // The provider-created checkout below is the source the builder uses.
      assertExactImmutableGitHubSourceReceipt(observedGitHubSource);
      const githubSource = observedGitHubSource;
      const credential = await provider.acquireRepositoryReadCredential({
        repositoryId: value.access.repository.repositoryId,
      });
      configureVercelSessionGitSource({
        sessionId: value.sessionId,
        source: {
          url: `https://github.com/${value.access.repository.owner}/${value.access.repository.name}.git`,
          token: credential.token,
        },
      });
      // The Vercel backend now supplies this source directly to
      // `Sandbox.create({ source: { type: "git", ... } })`. No shell clone,
      // manifest, or predicted checkout shape sits between provider access and
      // the repository's own commands.
      const sandbox =
        typeof value.sandbox === "function"
          ? await value.sandbox()
          : value.sandbox;
      const cloned = {
        snapshot: await readSandboxGitHubSourceSnapshot(sandbox),
        workspaceDigest: value.access.repository.headTree,
      };
      const sourceReceipt = inspectExistingRepositorySnapshotReceipt(
        cloned.snapshot,
      );
      // GitHub already authorized the clone. Do not repeat a speculative
      // permission/readback gate after the provider operation succeeded.
      const confirmed = value.access;
      const accessReceipt = recordRepositoryAccessReceipt({
        current: initialAccessReceipt,
        sessionId: value.sessionId,
        confirmedByCallId: value.callId,
        access: confirmed,
      });
      assertResolvedSourceMatchesRepositoryAccess({
        access: accessReceipt,
        source: githubSource,
      });
      const workspace = await recordPreparedSandboxWorkspace({
        sandbox,
        callId: value.callId,
        sourcePath: sourceReceipt.sourcePath,
        sourceSha: sourceReceipt.sourceSha,
        sourceTree: sourceReceipt.sourceTree,
        eligibilityDigest: sourceReceipt.eligibilityDigest,
        workspaceDigest: cloned.workspaceDigest,
      });
      return { accessReceipt, githubSource, sourceReceipt, workspace };
    },
    async resumeAuthorizedForSession(value) {
      const candidates = await input.continuations.authorizedForSession({
        authority: input.authority,
        sessionId: value.sessionId,
      });
      let resumed = 0;
      for (const candidate of candidates) {
        const access = await classify({
          repository: candidate.record.repository.fullName,
          ...(candidate.record.selectedInstallationId
            ? {
                selectedInstallationId: candidate.record.selectedInstallationId,
              }
            : {}),
        });
        if (access.status !== "ready") continue;
        const callback = new URL(candidate.callbackUrl);
        callback.searchParams.set("provider", "github");
        callback.searchParams.set("status", "connected");
        const response = await (value.fetchImplementation ?? fetch)(callback, {
          method: "GET",
          redirect: "manual",
          headers: { Accept: "application/json" },
        });
        if (response.status >= 200 && response.status < 400) resumed += 1;
      }
      return resumed;
    },
    authorization(value) {
      return defineInteractiveAuthorization<{ continuationId: string }>({
        displayName: "GitHub repository access",
        async getToken({ principal }) {
          exactPrincipal(principal, input.authority);
          const access = await classify(value);
          if (access.status === "ready") return { token: access.accessDigest };
          if (access.status === "provider-unavailable") {
            throw failed(
              "provider_unavailable",
              "GitHub could not confirm access to this repository.",
              true,
            );
          }
          throw new ConnectionAuthorizationRequiredError(
            "github-repository-access",
          );
        },
        async startAuthorization({ callbackUrl, principal }) {
          exactPrincipal(principal, input.authority);
          const access = await classify(value);
          if (access.status === "ready") {
            throw failed(
              "access_already_available",
              "GitHub access was already available when authorization began.",
            );
          }
          if (access.status === "scope-selection-required") {
            throw failed(
              "scope_selection_required",
              "Choose which connected GitHub account Autograph should use.",
            );
          }
          if (access.status === "provider-unavailable") {
            throw failed(
              "provider_unavailable",
              "GitHub could not confirm repository access.",
              true,
            );
          }
          const continuation = await input.continuations.create({
            authority: input.authority,
            sessionId: value.sessionId,
            requestId: value.requestId,
            repository: value.repository,
            ...(value.selectedInstallationId
              ? { selectedInstallationId: value.selectedInstallationId }
              : {}),
            callbackUrl,
          });
          const authorizeUrl = new URL("/github/installations", input.origin);
          authorizeUrl.searchParams.set("returnTo", "/");
          authorizeUrl.searchParams.set("resume", continuation.continuationId);
          const challenge = {
            url: authorizeUrl.toString(),
            expiresAt: continuation.expiresAt.toISOString(),
            displayName:
              access.action === "connect"
                ? "Connect GitHub"
                : "Update GitHub access",
            instructions:
              access.action === "connect"
                ? `Connect GitHub so Autograph can use ${value.repository}. This app continues automatically after access is confirmed.`
                : `Update GitHub access to include ${value.repository}. This app continues automatically after access is confirmed.`,
            repositoryAccess: {
              provider: "github" as const,
              action: access.action,
              repository: access.repository,
              scopes: access.scopes,
            },
          };
          return {
            challenge,
            resume: { continuationId: continuation.continuationId },
          };
        },
        async completeAuthorization({ callback, principal, resume }) {
          exactPrincipal(principal, input.authority);
          if (
            callback.method !== "GET" ||
            callback.params.provider !== "github" ||
            callback.params.status !== "connected" ||
            Object.keys(callback.params).some(
              (key) => key !== "provider" && key !== "status",
            )
          ) {
            throw failed(
              "callback_invalid",
              "GitHub access confirmation was invalid or expired.",
            );
          }
          const access = await classify(value);
          if (access.status !== "ready") {
            throw failed(
              "repository_access_missing",
              `GitHub is connected, but ${value.repository} is not included.`,
              true,
            );
          }
          const continuation = await input.continuations.consume({
            authority: input.authority,
            continuationId: resume?.continuationId ?? "",
            sessionId: value.sessionId,
            requestId: value.requestId,
            repository: value.repository,
            ...(value.selectedInstallationId
              ? { selectedInstallationId: value.selectedInstallationId }
              : {}),
          });
          if (!continuation) {
            throw failed(
              "continuation_invalid",
              "GitHub access confirmation was invalid or expired.",
            );
          }
          return { token: access.accessDigest };
        },
      });
    },
  };
}

let runtimeInput:
  | {
      database: ReturnType<typeof openHostedPostgresDatabase>;
      origin: string;
      credentials: ReturnType<typeof parseGitHubAppHttpProviderCredentials>;
    }
  | undefined;

export async function repositoryAccessRuntimeForSession(sessionAuth: unknown) {
  const { authority, principal } = exactForwardedSessionAuthority(sessionAuth);
  if (!runtimeInput) {
    const installation = readGitHubAppInstallationEnvironment(process.env);
    runtimeInput = {
      database: openHostedPostgresDatabase(process.env.DATABASE_URL ?? ""),
      origin: new URL(installation.issuer).origin,
      credentials: parseGitHubAppHttpProviderCredentials({
        appId: installation.appId,
        privateKey: process.env.GITHUB_APP_PRIVATE_KEY,
      }),
    };
  }
  const membership = createPostgresWorkspaceMembership(runtimeInput.database);
  if (
    !(await membership.isMember({
      principal,
      workspaceId: authority.workspaceId,
    }))
  ) {
    throw new Error("Repository access requires an active workspace member.");
  }
  const installations = createPostgresHostedGitHubInstallationStore(
    runtimeInput.database,
  );
  return createRepositoryAccessRuntime({
    authority,
    origin: runtimeInput.origin,
    installations,
    providerFactory: ({ installation }) =>
      createGitHubAppHttpProvider({
        config: {
          ...runtimeInput!.credentials,
          installationId: installation.installationId,
        },
      }),
    continuations: createRepositoryAccessContinuationService({
      store: createPostgresRepositoryAccessContinuationStore(
        runtimeInput.database,
      ),
    }),
  });
}

/** Internal Check-access seam for the hosted session service. */
export async function resumeAuthorizedRepositoryAccessForSession(input: {
  sessionAuth: unknown;
  sessionId: string;
  fetchImplementation?: typeof fetch;
}) {
  const runtime = await repositoryAccessRuntimeForSession(input.sessionAuth);
  return runtime.resumeAuthorizedForSession({
    sessionId: input.sessionId,
    ...(input.fetchImplementation
      ? { fetchImplementation: input.fetchImplementation }
      : {}),
  });
}
