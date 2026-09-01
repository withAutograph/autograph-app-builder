import { describe, expect, it, vi } from "vitest";

import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
} from "../repository/postgres-github-installation-store";
import {
  classifyGitHubRepositoryAccess,
  parseRepositoryReference,
  type GitHubRepositoryAccessProvider,
} from "./repository-access";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace-1",
  ownerUserId: "user-1",
};

function binding(
  installationId: string,
  accountLogin = "withAutograph",
): HostedGitHubInstallationBinding {
  return {
    installationId,
    accountId: `${Number(installationId) + 100}`,
    accountLogin,
    accountType: "Organization",
    active: true,
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  };
}

function store(
  bindings: HostedGitHubInstallationBinding[],
): HostedGitHubInstallationStore {
  return {
    read: vi.fn(async () => undefined),
    list: vi.fn(async () => bindings),
    bind: vi.fn(),
  };
}

function provider(
  installation: HostedGitHubInstallationBinding,
  repositoryId?: string,
  repositorySelection: "all" | "selected" = "selected",
  repositoryOverride: Record<string, unknown> = {},
): GitHubRepositoryAccessProvider {
  return {
    async inspectInstallation({ requestedPermissions }) {
      return {
        installationId: installation.installationId,
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        repositorySelection,
        selectedRepositoryIds: repositoryId ? [repositoryId] : [],
        grantedPermissions: requestedPermissions,
      };
    },
    async inspectRepositoryByName() {
      return repositoryId
        ? {
            repositoryId,
            owner: "withAutograph",
            name: "app-builder-dogfood",
            archived: false,
            visibility: "private",
            defaultBranch: "main",
            headSha: "1".repeat(40),
            headTree: "2".repeat(40),
            repositoryVariableNames: [],
            ...repositoryOverride,
          }
        : undefined;
    },
  };
}

describe("tenant-bound GitHub repository access", () => {
  it("requires a connection when the tenant has no installation", async () => {
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        repository: "withAutograph/app-builder-dogfood",
        installations: store([]),
        providerFactory: vi.fn(),
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      action: "connect",
    });
  });

  it("requires an access update when connected installations omit the repository", async () => {
    const connected = binding("10");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        repository: "withAutograph/app-builder-dogfood",
        installations: store([connected]),
        providerFactory: async () => provider(connected),
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      action: "update",
      scopes: [{ installationId: "10" }],
    });
  });

  it("returns provider-proven immutable repository identity without trusting chat", async () => {
    const connected = binding("10");
    const result = await classifyGitHubRepositoryAccess({
      authority,
      repository: "withAutograph/app-builder-dogfood",
      installations: store([connected]),
      providerFactory: async () => provider(connected, "200"),
    });
    expect(result).toMatchObject({
      status: "ready",
      repository: {
        repositoryId: "200",
        owner: "withAutograph",
        name: "app-builder-dogfood",
        headSha: "1".repeat(40),
        headTree: "2".repeat(40),
      },
      scope: { installationId: "10" },
    });
    expect(result).toHaveProperty(
      "accessDigest",
      expect.stringMatching(/^[0-9a-f]{64}$/u),
    );
  });

  it("accepts a provider-proven repository from an all-repositories installation", async () => {
    const connected = binding("10");
    const result = await classifyGitHubRepositoryAccess({
      authority,
      repository: "withAutograph/app-builder-dogfood",
      installations: store([connected]),
      providerFactory: async () => provider(connected, "200", "all"),
    });
    expect(result).toMatchObject({
      status: "ready",
      repository: { repositoryId: "200" },
      scope: { installationId: "10" },
    });
  });

  it("requires an explicit scope choice when two installations can access the repository", async () => {
    const first = binding("10");
    const second = binding("11", "autograph-labs");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        repository: "withAutograph/app-builder-dogfood",
        installations: store([first, second]),
        providerFactory: async ({ installation }) =>
          provider(installation, "200"),
      }),
    ).resolves.toMatchObject({
      status: "scope-selection-required",
      scopes: [{ installationId: "10" }, { installationId: "11" }],
    });
  });

  it("does not treat a caller-selected inaccessible installation as authority", async () => {
    const first = binding("10");
    const second = binding("11", "autograph-labs");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        repository: "withAutograph/app-builder-dogfood",
        selectedInstallationId: "11",
        installations: store([first, second]),
        providerFactory: async () => provider(second),
      }),
    ).resolves.toMatchObject({
      status: "authorization-required",
      action: "update",
    });
  });

  it("fails closed when the repository was archived, renamed, or transferred", async () => {
    const connected = binding("10");
    for (const repositoryOverride of [
      { archived: true },
      { name: "renamed-dogfood" },
      { owner: "another-owner" },
    ]) {
      await expect(
        classifyGitHubRepositoryAccess({
          authority,
          repository: "withAutograph/app-builder-dogfood",
          installations: store([connected]),
          providerFactory: async () =>
            provider(connected, "200", "selected", repositoryOverride),
        }),
      ).resolves.toMatchObject({ status: "provider-unavailable" });
    }
  });

  it("rejects malformed repository references", () => {
    expect(() => parseRepositoryReference("selected")).toThrow(
      "repository-reference-invalid",
    );
    expect(() => parseRepositoryReference("owner/repo/extra")).toThrow(
      "repository-reference-invalid",
    );
  });
});
