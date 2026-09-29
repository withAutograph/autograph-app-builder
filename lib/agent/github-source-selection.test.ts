import { describe, expect, it, vi } from "vitest";

import type { ExistingDraftObservation } from "../repository/github-draft-update";
import type { GitHubPublicationAdapter } from "../repository/github-publication";
import { createRepositoryObservation } from "../repository/github-publication";
import { composeGitHubPublicationRuntime } from "./github-publication-runtime";

const selection = {
  name: "arrusted-development",
  owner: "withAutograph",
  pullRequestNumber: 1514,
  repositoryId: "100",
};
const openPullRequest: ExistingDraftObservation = {
  baseBranch: "main",
  baseRepositoryId: "100",
  draft: false,
  headBranch: "codex/app-production-pilot",
  headRepositoryId: "100",
  headSha: "a".repeat(40),
  headTree: "b".repeat(40),
  name: selection.name,
  number: selection.pullRequestNumber,
  owner: selection.owner,
  pullRequestId: "151400",
  repositoryId: selection.repositoryId,
  state: "open",
};

// oxlint-disable-next-line eslint/require-await -- Any unexpected provider operation fails this test.
const unexpected = async (): Promise<never> => {
  throw new Error("Source inspection attempted another provider operation");
};

const sourceRuntime = (pullRequest = openPullRequest) => {
  // oxlint-disable-next-line eslint/require-await -- Provider read test double.
  const inspectExistingDraft = vi.fn(async () => pullRequest);
  // oxlint-disable-next-line eslint/require-await -- Provider read test double.
  const inspectRepository = vi.fn(async () =>
    createRepositoryObservation({
      defaultBranch: "main",
      headSha: pullRequest.headSha,
      headTree: pullRequest.headTree,
      installationIdentityDigest: "c".repeat(64),
      name: selection.name,
      owner: selection.owner,
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: selection.repositoryId,
      visibility: "private",
    }),
  );
  const adapter: GitHubPublicationAdapter = {
    createPrivateFreshHistoryRepository: unexpected,
    inspectDestination: unexpected,
    inspectDraftPublication: unexpected,
    inspectExistingDraft,
    inspectFreshRepositoryOutcome: unexpected,
    inspectInstallation: unexpected,
    inspectRepository,
    publishDraftPullRequest: unexpected,
    updateExistingDraft: unexpected,
  };
  const runtime = composeGitHubPublicationRuntime({
    adapter,
    enabled: true,
    proposals: { read: vi.fn(), save: vi.fn() },
    receipts: { compareAndSet: vi.fn(), read: vi.fn() },
  });
  return { inspectExistingDraft, inspectRepository, runtime };
};

describe("read-only initial GitHub source selection", () => {
  it("selects a non-draft open PR while keeping draft-update inspection restricted", async () => {
    const { runtime, inspectExistingDraft } = sourceRuntime();
    expect(await runtime.inspectOpenPullRequestSource(selection)).toEqual(openPullRequest);
    await expect(runtime.inspectExistingDraftSource(selection)).rejects.toThrow(
      "not an open draft",
    );
    expect(inspectExistingDraft).toHaveBeenCalledWith({
      name: selection.name,
      number: selection.pullRequestNumber,
      owner: selection.owner,
      repositoryId: selection.repositoryId,
    });
  });

  it.each([
    { state: "closed" as const },
    { headRepositoryId: "foreign-repository" },
    { baseRepositoryId: "foreign-repository" },
    { number: 1500 },
  ])("rejects unavailable or differently owned PR sources %j", async (changed) => {
    const { runtime } = sourceRuntime({ ...openPullRequest, ...changed });
    await expect(runtime.inspectOpenPullRequestSource(selection)).rejects.toThrow(
      "not open with a branch",
    );
  });

  it("reads the named branch through the provider without a publication operation", async () => {
    const { runtime, inspectRepository } = sourceRuntime();
    expect(
      await runtime.inspectSourceBranch({
        branch: openPullRequest.headBranch,
        name: selection.name,
        owner: selection.owner,
        repositoryId: selection.repositoryId,
      }),
    ).toEqual({
      branch: openPullRequest.headBranch,
      headSha: openPullRequest.headSha,
      headTree: openPullRequest.headTree,
    });
    expect(inspectRepository).toHaveBeenCalledWith({
      operation: "resolve-existing-source",
      ref: `refs/heads/${openPullRequest.headBranch}`,
      repositoryId: selection.repositoryId,
    });
  });
});
