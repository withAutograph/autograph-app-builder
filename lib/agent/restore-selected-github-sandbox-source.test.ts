import { describe, expect, it, vi } from "vitest";
import type { ImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import { recordRepositoryAccessReceipt } from "./repository-access-state";
import {
  restoreSelectedGitHubSandboxSource,
  selectedGitHubSourceForSandboxRestore,
} from "./restore-selected-github-sandbox-source";
import {
  clearVercelSessionGitSource,
  configureVercelSessionGitSource,
  readVercelSessionGitSource,
  resolveVercelSessionGitSource,
} from "@/lib/sandbox/vercel-session-source";

const access = {
  accessDigest: "3".repeat(64),
  repository: {
    archived: false as const,
    defaultBranch: "main",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    name: "private-app",
    owner: "example",
    repositoryId: "200",
    repositoryVariableNames: [],
    visibility: "private" as const,
  },
  scope: {
    accountLogin: "example",
    accountType: "Organization" as const,
    installationId: "10",
  },
  status: "ready" as const,
};
const receipt = recordRepositoryAccessReceipt({
  access,
  confirmedByCallId: "call-one",
  // oxlint-disable-next-line sonarjs/no-undefined-assignment -- the receipt API requires an explicit absent prior value
  current: undefined,
  sessionId: "session-one",
});
const source: ImmutableGitHubSourceReceipt = {
  digest: "4".repeat(64),
  installationIdentityDigest: "5".repeat(64),
  repository: {
    defaultBranch: "main",
    digest: "6".repeat(64),
    headSha: access.repository.headSha,
    headTree: access.repository.headTree,
    installationIdentityDigest: "5".repeat(64),
    name: access.repository.name,
    owner: access.repository.owner,
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: access.repository.repositoryId,
    version: 2,
    visibility: "private",
  },
  resolvedByCallId: "call-one",
  resolvedRef: "refs/heads/review/branch",
  resolvedSha: access.repository.headSha,
  resolvedTree: access.repository.headTree,
  version: 2,
};

describe("selected GitHub sandbox source restoration", () => {
  it("recreates baseline compute at the saved platform commit while retaining the publication branch", async () => {
    const acquireExistingSourceCredential = vi.fn().mockResolvedValue({ token: "fresh-token" });
    try {
      restoreSelectedGitHubSandboxSource({
        accessReceipt: receipt,
        frozenRevision: "a".repeat(40),
        githubSource: source,
        runtime: async () => await Promise.resolve({ acquireExistingSourceCredential }),
        sessionId: "session-one",
      });
      expect(acquireExistingSourceCredential).not.toHaveBeenCalled();
      expect(await resolveVercelSessionGitSource("session-one")).toMatchObject({
        revision: "a".repeat(40),
        token: "fresh-token",
      });
      expect(source.resolvedRef).toBe("refs/heads/review/branch");
    } finally {
      clearVercelSessionGitSource("session-one");
    }
  });
  it("restores a saved app when its older source-state slot is empty", async () => {
    const acquireExistingSourceCredential = vi.fn().mockResolvedValue({ token: "fresh-token" });
    const recovered = selectedGitHubSourceForSandboxRestore({
      // oxlint-disable-next-line sonarjs/no-undefined-assignment -- model an old session without a source-state receipt.
      sourceState: undefined,
      workflowState: source,
    });
    try {
      restoreSelectedGitHubSandboxSource({
        accessReceipt: receipt,
        githubSource: recovered,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        runtime: async () => ({ acquireExistingSourceCredential }),
        sessionId: "session-one",
      });
      expect(await resolveVercelSessionGitSource("session-one")).toMatchObject({
        revision: "review/branch",
        token: "fresh-token",
      });
    } finally {
      clearVercelSessionGitSource("session-one");
    }
    expect(() =>
      selectedGitHubSourceForSandboxRestore({
        sourceState: source,
        workflowState: {
          ...source,
          repository: { ...source.repository, repositoryId: "999" },
        },
      }),
    ).toThrow("different GitHub repositories");
    expect(() =>
      selectedGitHubSourceForSandboxRestore({
        sourceState: source,
        workflowState: { ...source, resolvedRef: "refs/heads/another-branch" },
      }),
    ).toThrow("different GitHub repositories or branches");
  });

  it("refreshes the selected repository and branch before replacement compute opens", async () => {
    const acquireExistingSourceCredential = vi.fn().mockResolvedValue({ token: "fresh-token" });
    configureVercelSessionGitSource({
      sessionId: "session-one",
      source: { token: "expired-token", url: "https://github.com/example/private-app.git" },
    });
    try {
      restoreSelectedGitHubSandboxSource({
        accessReceipt: receipt,
        githubSource: source,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        runtime: async () => ({ acquireExistingSourceCredential }),
        sessionId: "session-one",
      });
      expect(acquireExistingSourceCredential).not.toHaveBeenCalled();
      expect(readVercelSessionGitSource("session-one")).toBeUndefined();
      expect(await resolveVercelSessionGitSource("session-one")).toEqual({
        revision: "review/branch",
        token: "fresh-token",
        url: "https://github.com/example/private-app.git",
      });
      expect(acquireExistingSourceCredential).toHaveBeenCalledWith({
        installationId: "10",
        repository: { name: "private-app", owner: "example", repositoryId: "200" },
        sessionId: "session-one",
      });
      expect(readVercelSessionGitSource("other-session")).toBeUndefined();
    } finally {
      clearVercelSessionGitSource("session-one");
    }
  });

  it("rejects another session or repository without reusing an old token", () => {
    const acquireExistingSourceCredential = vi.fn();
    configureVercelSessionGitSource({
      sessionId: "session-one",
      source: { token: "expired-token", url: "https://github.com/example/private-app.git" },
    });
    expect(() => {
      restoreSelectedGitHubSandboxSource({
        accessReceipt: { ...receipt, sessionId: "other-session" },
        githubSource: source,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        runtime: async () => ({ acquireExistingSourceCredential }),
        sessionId: "session-one",
      });
    }).toThrow("belongs to another session or repository");
    expect(acquireExistingSourceCredential).not.toHaveBeenCalled();
    expect(readVercelSessionGitSource("session-one")).toBeUndefined();
  });

  it("clears stale credentials when GitHub access has failed", async () => {
    const acquireExistingSourceCredential = vi
      .fn()
      .mockRejectedValue(new Error("GitHub access revoked"));
    configureVercelSessionGitSource({
      sessionId: "session-one",
      source: { token: "expired-token", url: "https://github.com/example/private-app.git" },
    });
    restoreSelectedGitHubSandboxSource({
      accessReceipt: receipt,
      githubSource: source,
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      runtime: async () => ({ acquireExistingSourceCredential }),
      sessionId: "session-one",
    });
    await expect(resolveVercelSessionGitSource("session-one")).rejects.toThrow(
      "GitHub access revoked",
    );
    expect(readVercelSessionGitSource("session-one")).toBeUndefined();
  });
});
