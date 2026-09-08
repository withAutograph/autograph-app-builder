import { describe, expect, it, vi } from "vitest";

import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
} from "../repository/postgres-github-installation-store";
import type {
  GitHubRepositoryAccessProvider,
  GitHubRepositoryAccessProviderFactory,
} from "../integrations/repository-access";
import {
  createRepositoryAccessContinuationService,
  type RepositoryAccessContinuation,
  type RepositoryAccessContinuationStore,
} from "../integrations/repository-access-continuation";
import { createRepositoryAccessRuntime } from "./deployment-repository-access-runtime";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};
const principal = {
  type: "user" as const,
  id: authority.ownerUserId,
  issuer: authority.issuer,
};
const connection = { url: authority.audience };
const continuationId = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";
const callbackUrl =
  "https://builder.example/eve/v1/connections/github-repository-access/callback/attempt/token";
const repository = "withAutograph/app-builder-dogfood";

function sameAuthority(left: typeof authority, right: typeof authority) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function memoryContinuationStore(): RepositoryAccessContinuationStore & {
  records: RepositoryAccessContinuation[];
} {
  const records: RepositoryAccessContinuation[] = [];
  return {
    records,
    async create(record) {
      records.push(record);
    },
    async authorize(input) {
      const record = records.find(
        (candidate) =>
          candidate.continuationDigest === input.continuationDigest &&
          sameAuthority(candidate.authority, input.authority) &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
      if (!record) return undefined;
      record.authorizedAt ??= input.now;
      return record;
    },
    async consume(input) {
      const record = records.find(
        (candidate) =>
          candidate.continuationDigest === input.continuationDigest &&
          sameAuthority(candidate.authority, input.authority) &&
          candidate.sessionId === input.sessionId &&
          candidate.requestId === input.requestId &&
          candidate.repository.fullName === input.repository.fullName &&
          candidate.selectedInstallationId === input.selectedInstallationId &&
          candidate.authorizedAt !== undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
      if (!record) return undefined;
      record.consumedAt = input.now;
      return record;
    },
    async listAuthorizedForSession(input) {
      return records.filter(
        (candidate) =>
          sameAuthority(candidate.authority, input.authority) &&
          candidate.sessionId === input.sessionId &&
          candidate.authorizedAt !== undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now,
      );
    },
  };
}

const installation: HostedGitHubInstallationBinding = {
  installationId: "10",
  accountId: "110",
  accountLogin: "withAutograph",
  accountType: "Organization",
  active: true,
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
};

function installationStore(
  bindings: HostedGitHubInstallationBinding[],
): HostedGitHubInstallationStore {
  return {
    read: vi.fn(async () => undefined),
    list: vi.fn(async () => bindings),
    bind: vi.fn(),
  };
}

function mutableProvider(input: { repositoryAvailable: () => boolean }) {
  const provider: GitHubRepositoryAccessProvider = {
    async inspectInstallation({ requestedPermissions }) {
      return {
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: "selected",
        selectedRepositoryIds: input.repositoryAvailable() ? ["200"] : [],
        grantedPermissions: requestedPermissions,
      };
    },
    async inspectRepositoryByName() {
      return input.repositoryAvailable()
        ? {
            repositoryId: "200",
            owner: "withAutograph",
            name: "app-builder-dogfood",
            archived: false,
            visibility: "private",
            defaultBranch: "main",
            headSha: "1".repeat(40),
            headTree: "2".repeat(40),
            repositoryVariableNames: [],
          }
        : undefined;
    },
  };
  return vi.fn<GitHubRepositoryAccessProviderFactory>(async () => provider);
}

function runtimeFixture(input?: {
  bindings?: HostedGitHubInstallationBinding[];
  available?: boolean;
}) {
  let available = input?.available ?? false;
  const continuationStore = memoryContinuationStore();
  const continuations = createRepositoryAccessContinuationService({
    store: continuationStore,
    createId: () => continuationId,
    now: () => new Date("2026-09-01T12:00:00.000Z"),
  });
  const runtime = createRepositoryAccessRuntime({
    authority,
    origin: "https://builder.example",
    installations: installationStore(input?.bindings ?? [installation]),
    providerFactory: mutableProvider({
      repositoryAvailable: () => available,
    }),
    continuations,
  });
  return {
    runtime,
    continuations,
    continuationStore,
    makeAvailable: () => {
      available = true;
    },
  };
}

describe("deployment repository access authorization", () => {
  it("emits the closed Store In presentation while retaining server authority", async () => {
    const fixture = runtimeFixture({ bindings: [] });
    const authorization = fixture.runtime.authorization({
      repository,
      sessionId: "ses_one",
      requestId: "call_one",
    });
    const started = await authorization.startAuthorization({
      principal,
      connection,
      callbackUrl,
    });
    expect(started).toMatchObject({
      challenge: {
        displayName: "Connect GitHub",
        repositoryAccess: {
          provider: "github",
          action: "connect",
          repository: {
            owner: "withAutograph",
            name: "app-builder-dogfood",
            fullName: repository,
          },
          scopes: [],
        },
      },
      resume: { continuationId },
    });
    expect(started.challenge).not.toHaveProperty("version");
    expect(started.challenge.url).toContain("/github/installations?");
    expect(JSON.stringify(fixture.continuationStore.records)).not.toContain(
      continuationId,
    );
  });

  it("keeps a missing-repository callback retryable and consumes only provider-proven access", async () => {
    const fixture = runtimeFixture();
    const authorization = fixture.runtime.authorization({
      repository,
      selectedInstallationId: "10",
      sessionId: "ses_one",
      requestId: "call_one",
    });
    const started = await authorization.startAuthorization({
      principal,
      connection,
      callbackUrl,
    });
    await fixture.continuations.authorize({ authority, continuationId });
    const complete = () =>
      authorization.completeAuthorization({
        principal,
        connection,
        callbackUrl,
        resume: started.resume,
        callback: {
          method: "GET",
          params: { provider: "github", status: "connected" },
        },
      });

    await expect(complete()).rejects.toMatchObject({
      reason: "repository_access_missing",
      retryable: true,
    });
    expect(fixture.continuationStore.records[0]?.consumedAt).toBeUndefined();

    fixture.makeAvailable();
    await expect(complete()).resolves.toEqual({
      token: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(fixture.continuationStore.records[0]?.consumedAt).toBeInstanceOf(
      Date,
    );
  });

  it("re-reads access before Check access wakes a parked Eve callback", async () => {
    const fixture = runtimeFixture();
    const authorization = fixture.runtime.authorization({
      repository,
      sessionId: "ses_one",
      requestId: "call_one",
    });
    await authorization.startAuthorization({
      principal,
      connection,
      callbackUrl,
    });
    await fixture.continuations.authorize({ authority, continuationId });
    const fetchImplementation = vi.fn(
      async (
        resource: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1],
      ) => {
        void resource;
        void init;
        return new Response(null, { status: 204 });
      },
    );

    await expect(
      fixture.runtime.resumeAuthorizedForSession({
        sessionId: "ses_one",
        fetchImplementation,
      }),
    ).resolves.toBe(0);
    expect(fetchImplementation).not.toHaveBeenCalled();

    fixture.makeAvailable();
    await expect(
      fixture.runtime.resumeAuthorizedForSession({
        sessionId: "ses_one",
        fetchImplementation,
      }),
    ).resolves.toBe(1);
    expect(fetchImplementation.mock.calls[0]?.[0]?.toString()).toBe(
      `${callbackUrl}?provider=github&status=connected`,
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
  });
});
