import { describe, expect, it, vi } from "vitest";

import type { GitHubPublicationAdapter } from "../repository/github-publication";
import { composeGitHubPublicationRuntime } from "./github-publication-runtime";

const sourceRequest = {
  name: "example-app",
  owner: "withAutograph",
  repositoryId: "100",
  source: { kind: "merged-pr" as const, pullRequestNumber: 42 },
};
const observation = {
  commitSha: "a".repeat(40),
  name: "example-app",
  owner: "withAutograph",
  pullRequestNumber: 42,
  repositoryId: "100",
  treeSha: "b".repeat(40),
};

// oxlint-disable-next-line eslint/require-await -- Satisfy the async adapter test surface.
const unexpected = async (): Promise<never> => {
  throw new Error("Unexpected publication operation");
};

const adapterWithoutHistoricalLookup = (): GitHubPublicationAdapter => ({
  createPrivateFreshHistoryRepository: unexpected,
  inspectDestination: unexpected,
  inspectDraftPublication: unexpected,
  inspectExistingDraft: unexpected,
  inspectFreshRepositoryOutcome: unexpected,
  inspectInstallation: unexpected,
  inspectRepository: unexpected,
  publishDraftPullRequest: unexpected,
  updateExistingDraft: unexpected,
});

describe("historical App source runtime", () => {
  it("routes the selected repository and immutable selector to the adapter", async () => {
    // oxlint-disable-next-line eslint/require-await -- Keep the provider test double promise-based.
    const inspectHistoricalAppSource = vi.fn(async () => observation);
    const runtime = composeGitHubPublicationRuntime({
      adapter: { ...adapterWithoutHistoricalLookup(), inspectHistoricalAppSource },
      enabled: true,
      proposals: { read: vi.fn(), save: vi.fn() },
      receipts: { compareAndSet: vi.fn(), read: vi.fn() },
    });

    await expect(runtime.inspectHistoricalAppSource(sourceRequest)).resolves.toEqual(observation);
    expect(inspectHistoricalAppSource).toHaveBeenCalledWith(sourceRequest);
  });

  it("gives an actionable error when the provider has no historical lookup", async () => {
    const runtime = composeGitHubPublicationRuntime({
      adapter: adapterWithoutHistoricalLookup(),
      enabled: true,
      proposals: { read: vi.fn(), save: vi.fn() },
      receipts: { compareAndSet: vi.fn(), read: vi.fn() },
    });
    await expect(runtime.inspectHistoricalAppSource(sourceRequest)).rejects.toThrow(
      "Upgrade the GitHub provider, reconnect GitHub with repository read access, then retry.",
    );
  });

  it("explains how to enable historical lookup when the runtime is disabled", async () => {
    const runtime = composeGitHubPublicationRuntime({ enabled: false });
    await expect(runtime.inspectHistoricalAppSource(sourceRequest)).rejects.toThrow(
      "Connect GitHub with repository read access, then retry.",
    );
  });
});
