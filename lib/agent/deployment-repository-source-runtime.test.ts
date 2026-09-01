import { describe, expect, it, vi } from "vitest";

import type { SandboxSession } from "eve/sandbox";

const mocks = vi.hoisted(() => ({
  cloneGitHubSourceWorkspace: vi.fn(),
  inspectExistingRepositorySnapshotReceipt: vi.fn(),
  recordPreparedSandboxWorkspace: vi.fn(),
}));

vi.mock("../repository/sandbox-github-source", () => ({
  cloneGitHubSourceWorkspace: mocks.cloneGitHubSourceWorkspace,
}));
vi.mock("../repository/source-receipt", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../repository/source-receipt")>()),
  inspectExistingRepositorySnapshotReceipt:
    mocks.inspectExistingRepositorySnapshotReceipt,
}));
vi.mock("../repository/supported-template", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../repository/supported-template")
  >()),
  recordPreparedSandboxWorkspace: mocks.recordPreparedSandboxWorkspace,
}));

import {
  createRepositoryAccessContinuationService,
  type RepositoryAccessContinuationStore,
} from "../integrations/repository-access-continuation";
import type { HostedGitHubInstallationBinding } from "../repository/postgres-github-installation-store";
import { createRepositoryAccessRuntime } from "./deployment-repository-access-runtime";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};
const sourceSha = "1".repeat(40);
const sourceTree = "2".repeat(40);
const digest = "a".repeat(64);
const installation: HostedGitHubInstallationBinding = {
  installationId: "10",
  accountId: "110",
  accountLogin: "withAutograph",
  accountType: "Organization",
  active: true,
  updatedAt: new Date("2026-09-01T12:00:00.000Z"),
};

function runtimeFixture() {
  let currentSha = sourceSha;
  let currentTree = sourceTree;
  let available = true;
  const provider = {
    async inspectInstallation({
      requestedPermissions,
    }: {
      requestedPermissions: unknown;
    }) {
      return {
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection: "selected",
        selectedRepositoryIds: available ? ["200"] : [],
        grantedPermissions: requestedPermissions,
      };
    },
    async inspectRepositoryByName() {
      return available
        ? {
            repositoryId: "200",
            owner: "withAutograph",
            name: "app-builder-dogfood",
            archived: false,
            visibility: "private",
            defaultBranch: "main",
            headSha: currentSha,
            headTree: currentTree,
            repositoryVariableNames: ["REPOSITORY_RELEASE_ENABLED"],
          }
        : undefined;
    },
    async inspectRepository() {
      return {
        repositoryId: "200",
        owner: "withAutograph",
        name: "app-builder-dogfood",
        visibility: "private",
        defaultBranch: "main",
        headSha: currentSha,
        headTree: currentTree,
        repositoryVariableNames: ["REPOSITORY_RELEASE_ENABLED"],
      };
    },
    async acquireRepositoryReadCredential() {
      return { token: "ghs_exact_repository_read_credential" };
    },
  };
  const continuationStore: RepositoryAccessContinuationStore = {
    async create() {},
    async authorize() {
      return undefined;
    },
    async consume() {
      return undefined;
    },
    async listAuthorizedForSession() {
      return [];
    },
  };
  const runtime = createRepositoryAccessRuntime({
    authority,
    origin: "https://builder.example",
    installations: {
      async read() {
        return undefined;
      },
      async list() {
        return [installation];
      },
      async bind() {
        return installation;
      },
    },
    providerFactory: vi.fn(async () => provider),
    continuations: createRepositoryAccessContinuationService({
      store: continuationStore,
    }),
  });
  return {
    runtime,
    driftSource() {
      currentSha = "5".repeat(40);
      currentTree = "6".repeat(40);
    },
    removeAccess() {
      available = false;
    },
  };
}

describe("deployment existing-repository source preparation", () => {
  it("prepares a ready source without a preceding access tool call and preserves its receipt across a new call id", async () => {
    mocks.cloneGitHubSourceWorkspace.mockResolvedValue({
      snapshot: { sourceSha, sourceTree },
      workspaceDigest: digest,
    });
    mocks.inspectExistingRepositorySnapshotReceipt.mockReturnValue({
      version: 3,
      sourceKind: "existing-repository",
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
      adapter: "arrusted-development-v0",
      eligibilityDigest: "b".repeat(64),
      contractDigest: "c".repeat(64),
      releaseEnabled: false,
      digest: "d".repeat(64),
    });
    mocks.recordPreparedSandboxWorkspace.mockResolvedValue({
      workspaceId: "sandbox-source",
      workspacePath: "/workspace/repository",
      sourcePath: "/workspace/repository",
      sourceSha,
      sourceTree,
      workspaceDigest: digest,
      adapter: "arrusted-development-v0",
      eligibilityDigest: "b".repeat(64),
    });
    const fixture = runtimeFixture();
    const access = await fixture.runtime.classify({
      repository: "withAutograph/app-builder-dogfood",
    });
    if (access.status !== "ready") throw new Error("expected ready access");
    const first = await fixture.runtime.prepareExistingSource({
      repository: "withAutograph/app-builder-dogfood",
      access,
      currentAccessReceipt: undefined,
      sessionId: "session-source",
      callId: "call-one",
      sandbox: { id: "sandbox-source" } as SandboxSession,
    });
    const retried = await fixture.runtime.prepareExistingSource({
      repository: "withAutograph/app-builder-dogfood",
      access,
      currentAccessReceipt: first.accessReceipt,
      currentGitHubSource: first.githubSource,
      sessionId: "session-source",
      callId: "call-two",
      sandbox: { id: "sandbox-source" } as SandboxSession,
    });

    expect(retried.githubSource).toEqual(first.githubSource);
    expect(retried.accessReceipt).toEqual(first.accessReceipt);
    expect(first.githubSource.resolvedByCallId).toBe("call-one");
    expect(mocks.cloneGitHubSourceWorkspace).toHaveBeenCalledTimes(2);
  });

  it("rejects tampered access state and fresh provider source or access drift", async () => {
    const fixture = runtimeFixture();
    const access = await fixture.runtime.classify({
      repository: "withAutograph/app-builder-dogfood",
    });
    if (access.status !== "ready") throw new Error("expected ready access");
    const base = {
      repository: "withAutograph/app-builder-dogfood",
      access,
      sessionId: "session-source",
      callId: "call-one",
      sandbox: { id: "sandbox-source" } as SandboxSession,
    };
    await expect(
      fixture.runtime.prepareExistingSource({
        ...base,
        currentAccessReceipt: {
          version: 1,
          sessionId: "session-source",
          repository: {
            repositoryId: "200",
            owner: "withAutograph",
            name: "app-builder-dogfood",
            defaultBranch: "main",
            headSha: sourceSha,
            headTree: sourceTree,
          },
          scope: {
            installationId: "10",
            accountLogin: "withAutograph",
            accountType: "Organization",
          },
          providerAccessDigest: access.accessDigest,
          confirmedByCallId: "call-zero",
          digest: "0".repeat(64),
        },
      }),
    ).rejects.toThrow();

    fixture.driftSource();
    await expect(
      fixture.runtime.prepareExistingSource({
        ...base,
        currentAccessReceipt: undefined,
      }),
    ).rejects.toThrow("source changed");

    const accessFixture = runtimeFixture();
    const ready = await accessFixture.runtime.classify({
      repository: "withAutograph/app-builder-dogfood",
    });
    if (ready.status !== "ready") throw new Error("expected ready access");
    accessFixture.removeAccess();
    await expect(
      accessFixture.runtime.prepareExistingSource({
        ...base,
        access: ready,
        currentAccessReceipt: undefined,
      }),
    ).rejects.toThrow();
  });
});
