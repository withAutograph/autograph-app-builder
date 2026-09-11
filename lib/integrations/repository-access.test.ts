import { describe, expect, it, vi } from "vitest";

import type {
  HostedGitHubInstallationBinding,
  HostedGitHubInstallationStore,
} from "../repository/postgres-github-installation-store";
import {
  classifyGitHubRepositoryAccess,
  parseRepositoryReference,
} from "./repository-access";
import type { GitHubRepositoryAccessProvider } from "./repository-access";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user-1",
  workspaceId: "workspace-1",
};

function binding(
  installationId: string,
  accountLogin = "withAutograph"
): HostedGitHubInstallationBinding {
  return {
    accountId: `${Number(installationId) + 100}`,
    accountLogin,
    accountType: "Organization",
    active: true,
    installationId,
    updatedAt: new Date("2026-09-01T12:00:00.000Z"),
  };
}

function store(
  bindings: HostedGitHubInstallationBinding[]
): HostedGitHubInstallationStore {
  return {
    bind: vi.fn(),
    list: vi.fn(async () => bindings),
    read: vi.fn(async () => undefined),
  };
}

function provider(
  installation: HostedGitHubInstallationBinding,
  repositoryId?: string,
  repositorySelection: "all" | "selected" = "selected",
  repositoryOverride: Record<string, unknown> = {}
): GitHubRepositoryAccessProvider {
  return {
    async inspectInstallation({ requestedPermissions }) {
      return {
        accountId: installation.accountId,
        accountLogin: installation.accountLogin,
        accountType: installation.accountType,
        grantedPermissions: requestedPermissions,
        installationId: installation.installationId,
        repositorySelection,
        selectedRepositoryIds: repositoryId ? [repositoryId] : [],
      };
    },
    async inspectRepositoryByName() {
      return repositoryId
        ? {
            archived: false,
            defaultBranch: "main",
            headSha: "1".repeat(40),
            headTree: "2".repeat(40),
            name: "app-builder-dogfood",
            owner: "withAutograph",
            repositoryId,
            repositoryVariableNames: [],
            visibility: "private",
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
        installations: store([]),
        providerFactory: vi.fn(),
        repository: "withAutograph/app-builder-dogfood",
      })
    ).resolves.toMatchObject({
      action: "connect",
      status: "authorization-required",
    });
  });

  it("requires an access update when connected installations omit the repository", async () => {
    const connected = binding("10");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        installations: store([connected]),
        providerFactory: async () => provider(connected),
        repository: "withAutograph/app-builder-dogfood",
      })
    ).resolves.toMatchObject({
      action: "update",
      scopes: [{ installationId: "10" }],
      status: "authorization-required",
    });
  });

  it("returns provider-proven immutable repository identity without trusting chat", async () => {
    const connected = binding("10");
    const result = await classifyGitHubRepositoryAccess({
      authority,
      installations: store([connected]),
      providerFactory: async () => provider(connected, "200"),
      repository: "withAutograph/app-builder-dogfood",
    });
    expect(result).toMatchObject({
      repository: {
        headSha: "1".repeat(40),
        headTree: "2".repeat(40),
        name: "app-builder-dogfood",
        owner: "withAutograph",
        repositoryId: "200",
      },
      scope: { installationId: "10" },
      status: "ready",
    });
    expect(result).toHaveProperty(
      "accessDigest",
      expect.stringMatching(/^[0-9a-f]{64}$/u)
    );
  });

  it("accepts a provider-proven repository from an all-repositories installation", async () => {
    const connected = binding("10");
    const result = await classifyGitHubRepositoryAccess({
      authority,
      installations: store([connected]),
      providerFactory: async () => provider(connected, "200", "all"),
      repository: "withAutograph/app-builder-dogfood",
    });
    expect(result).toMatchObject({
      repository: { repositoryId: "200" },
      scope: { installationId: "10" },
      status: "ready",
    });
  });

  it("requires an explicit scope choice when two installations can access the repository", async () => {
    const first = binding("10");
    const second = binding("11", "autograph-labs");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        installations: store([first, second]),
        providerFactory: async ({ installation }) =>
          provider(installation, "200"),
        repository: "withAutograph/app-builder-dogfood",
      })
    ).resolves.toMatchObject({
      scopes: [{ installationId: "10" }, { installationId: "11" }],
      status: "scope-selection-required",
    });
  });

  it("does not treat a caller-selected inaccessible installation as authority", async () => {
    const first = binding("10");
    const second = binding("11", "autograph-labs");
    await expect(
      classifyGitHubRepositoryAccess({
        authority,
        installations: store([first, second]),
        providerFactory: async () => provider(second),
        repository: "withAutograph/app-builder-dogfood",
        selectedInstallationId: "11",
      })
    ).resolves.toMatchObject({
      action: "update",
      status: "authorization-required",
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
          installations: store([connected]),
          providerFactory: async () =>
            provider(connected, "200", "selected", repositoryOverride),
          repository: "withAutograph/app-builder-dogfood",
        })
      ).resolves.toMatchObject({ status: "provider-unavailable" });
    }
  });

  it("rejects malformed repository references", () => {
    expect(() => parseRepositoryReference("selected")).toThrow(
      "repository-reference-invalid"
    );
    expect(() => parseRepositoryReference("owner/repo/extra")).toThrow(
      "repository-reference-invalid"
    );
  });
});
