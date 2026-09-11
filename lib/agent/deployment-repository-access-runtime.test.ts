import { describe, expect, it, vi } from "vitest";

import type { BuilderHandoffIntent } from "../handoff/contracts";
import type {
  GitHubRepositoryAccessProvider,
  GitHubRepositoryAccessProviderFactory,
} from "../integrations/repository-access";
import { createRepositoryAccessContinuationService } from "../integrations/repository-access-continuation";
import type {
  RepositoryAccessContinuation,
  RepositoryAccessContinuationStore,
} from "../integrations/repository-access-continuation";
import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
} from "../repository/postgres-github-installation-store";
import { createRepositoryAccessRuntime } from "./deployment-repository-access-runtime";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};
const principal = {
  id: authority.ownerUserId,
  issuer: authority.issuer,
  type: "user" as const,
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
    async authorize(input) {
      const record = records.find(
        (candidate) =>
          candidate.continuationDigest === input.continuationDigest &&
          sameAuthority(candidate.authority, input.authority) &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now
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
          candidate.expiresAt > input.now
      );
      if (!record) return undefined;
      record.consumedAt = input.now;
      return record;
    },
    async create(record) {
      records.push(record);
    },
    async listAuthorizedForSession(input) {
      return records.filter(
        (candidate) =>
          sameAuthority(candidate.authority, input.authority) &&
          candidate.sessionId === input.sessionId &&
          candidate.authorizedAt !== undefined &&
          candidate.consumedAt === undefined &&
          candidate.expiresAt > input.now
      );
    },
    records,
  };
}

const installation: HostedGitHubInstallationBinding = {
  accountId: "110",
  accountLogin: "withAutograph",
  accountType: "Organization",
  active: true,
  installationId: "10",
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
};

function installationStore(
  bindings: HostedGitHubInstallationBinding[]
): HostedGitHubInstallationStore {
  return {
    bind: vi.fn(),
    list: vi.fn(async () => bindings),
    read: vi.fn(async () => undefined),
  };
}

function mutableProvider(input: { repositoryAvailable: () => boolean }) {
  const provider: GitHubRepositoryAccessProvider = {
    async inspectInstallation({ requestedPermissions }) {
      return {
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        grantedPermissions: requestedPermissions,
        installationId: installation.installationId,
        repositorySelection: "selected",
        selectedRepositoryIds: input.repositoryAvailable() ? ["200"] : [],
      };
    },
    async inspectRepositoryByName() {
      return input.repositoryAvailable()
        ? {
            archived: false,
            defaultBranch: "main",
            headSha: "1".repeat(40),
            headTree: "2".repeat(40),
            name: "app-builder-dogfood",
            owner: "withAutograph",
            repositoryId: "200",
            repositoryVariableNames: [],
            visibility: "private",
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
    createId: () => continuationId,
    now: () => new Date("2026-09-01T12:00:00.000Z"),
    store: continuationStore,
  });
  const runtime = createRepositoryAccessRuntime({
    authority,
    continuations,
    installations: installationStore(input?.bindings ?? [installation]),
    origin: "https://builder.example",
    providerFactory: mutableProvider({
      repositoryAvailable: () => available,
    }),
  });
  return {
    continuationStore,
    continuations,
    makeAvailable: () => {
      available = true;
    },
    runtime,
  };
}

describe("deployment repository access authorization", () => {
  it("uses the web selection among multiple installations and preserves its handoff return", async () => {
    const providerFactory = mutableProvider({
      repositoryAvailable: () => true,
    });
    const preparedIntent = {
      providers: { githubInstallationId: "10" },
      repository: {
        private: true,
        requestedName: "app-builder-dogfood",
        resolvedFullName: repository,
      },
    } as unknown as BuilderHandoffIntent;
    const runtime = createRepositoryAccessRuntime({
      authority,
      continuations: runtimeFixture().continuations,
      installations: installationStore([
        installation,
        { ...installation, installationId: "11" },
      ]),
      origin: "https://builder.example",
      preparedIntent,
      providerFactory,
      returnTo: `/handoff/${continuationId}`,
    });
    expect(await runtime.classify({ repository })).toMatchObject({
      scope: { installationId: "10" },
      status: "ready",
    });
    expect(providerFactory).toHaveBeenCalledTimes(1);
    expect(providerFactory.mock.calls[0]?.[0]).toMatchObject({
      authority,
      installation: { installationId: "10" },
    });
    const authorization = runtime.authorization({
      repository,
      requestId: "call_one",
      sessionId: "ses_one",
    });
    expect(
      await authorization.getToken({ connection, principal })
    ).toHaveProperty("token");
    providerFactory.mockImplementation(
      mutableProvider({ repositoryAvailable: () => false })
    );
    const started = await authorization.startAuthorization({
      callbackUrl,
      connection,
      principal,
    });
    expect(new URL(started.challenge.url!).searchParams.get("returnTo")).toBe(
      `/handoff/${continuationId}`
    );
  });

  it.each([
    [404, {}, "authorization-required"],
    [403, {}, "authorization-required"],
    [401, {}, "provider-unavailable"],
    [503, {}, "provider-unavailable"],
    [403, { "x-ratelimit-remaining": "0" }, "provider-unavailable"],
  ])(
    "classifies installation HTTP %s with headers %j as %s",
    async (status, headers, expected) => {
      const runtime = createRepositoryAccessRuntime({
        authority,
        continuations: runtimeFixture().continuations,
        installations: installationStore([installation]),
        origin: "https://builder.example",
        providerFactory: () => ({
          inspectInstallation: async () => {
            throw new Error(JSON.stringify({ status, response: { headers } }));
          },
          inspectRepositoryByName: async () => undefined,
        }),
      });
      expect(
        await runtime.classify({ repository, selectedInstallationId: "10" })
      ).toMatchObject({ status: expected });
    }
  );

  it("emits the closed Store In presentation while retaining server authority", async () => {
    const fixture = runtimeFixture({ bindings: [] });
    const authorization = fixture.runtime.authorization({
      repository,
      requestId: "call_one",
      sessionId: "ses_one",
    });
    const started = await authorization.startAuthorization({
      callbackUrl,
      connection,
      principal,
    });
    expect(started).toMatchObject({
      challenge: {
        displayName: "Connect GitHub",
        repositoryAccess: {
          action: "connect",
          provider: "github",
          repository: {
            fullName: repository,
            name: "app-builder-dogfood",
            owner: "withAutograph",
          },
          scopes: [],
        },
      },
      resume: { continuationId },
    });
    expect(started.challenge).not.toHaveProperty("version");
    expect(started.challenge.url).toContain("/github/installations?");
    expect(JSON.stringify(fixture.continuationStore.records)).not.toContain(
      continuationId
    );
  });

  it("keeps a missing-repository callback retryable and consumes only provider-proven access", async () => {
    const fixture = runtimeFixture();
    const authorization = fixture.runtime.authorization({
      repository,
      requestId: "call_one",
      selectedInstallationId: "10",
      sessionId: "ses_one",
    });
    const started = await authorization.startAuthorization({
      callbackUrl,
      connection,
      principal,
    });
    await fixture.continuations.authorize({ authority, continuationId });
    const complete = () =>
      authorization.completeAuthorization({
        callback: {
          method: "GET",
          params: { provider: "github", status: "connected" },
        },
        callbackUrl,
        connection,
        principal,
        resume: started.resume,
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
      Date
    );
  });

  it("re-reads access before Check access wakes a parked Eve callback", async () => {
    const fixture = runtimeFixture();
    const authorization = fixture.runtime.authorization({
      repository,
      requestId: "call_one",
      sessionId: "ses_one",
    });
    await authorization.startAuthorization({
      callbackUrl,
      connection,
      principal,
    });
    await fixture.continuations.authorize({ authority, continuationId });
    const fetchImplementation = vi.fn(
      async (
        resource: Parameters<typeof fetch>[0],
        init?: Parameters<typeof fetch>[1]
      ) => {
        void resource;
        void init;
        return new Response(null, { status: 204 });
      }
    );

    await expect(
      fixture.runtime.resumeAuthorizedForSession({
        fetchImplementation,
        sessionId: "ses_one",
      })
    ).resolves.toBe(0);
    expect(fetchImplementation).not.toHaveBeenCalled();

    fixture.makeAvailable();
    await expect(
      fixture.runtime.resumeAuthorizedForSession({
        fetchImplementation,
        sessionId: "ses_one",
      })
    ).resolves.toBe(1);
    expect(fetchImplementation.mock.calls[0]?.[0]?.toString()).toBe(
      `${callbackUrl}?provider=github&status=connected`
    );
    expect(fetchImplementation.mock.calls[0]?.[1]).toMatchObject({
      method: "GET",
      redirect: "manual",
    });
  });
});
