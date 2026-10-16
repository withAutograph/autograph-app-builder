import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  GITHUB_PUBLICATION_VERSION,
} from "../repository/github-publication";
import type {
  DraftPullRequestSuccessReceipt,
  GitHubPublicationAdapter,
  ImmutableGitHubSourceReceipt,
} from "../repository/github-publication";
import type { ExistingDraftObservation } from "../repository/github-draft-update";
import { createReconciliationReviewReceipt } from "../repository/github-draft-reconciliation";
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

const ownedDraftFixture = (
  receiptOverrides: Partial<Omit<DraftPullRequestSuccessReceipt, "digest">> = {},
) => {
  const installation = createGitHubInstallationIdentity({
    accountId: "200",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "300",
    operation: "publish-draft-pull-request",
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
  const repository = createRepositoryObservation({
    defaultBranch: "main",
    headSha: "3".repeat(40),
    headTree: "4".repeat(40),
    installationIdentityDigest: installation.digest,
    name: "example-app",
    owner: "withAutograph",
    releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
    repositoryId: "100",
    visibility: "private",
  });
  const draft: ExistingDraftObservation = {
    baseBranch: "main",
    baseRepositoryId: "100",
    draft: true,
    headBranch: "app-builder/review-original",
    headRepositoryId: "100",
    headSha: "1".repeat(40),
    headTree: "2".repeat(40),
    name: "example-app",
    number: 1500,
    owner: "withAutograph",
    pullRequestId: "150000",
    repositoryId: "100",
    state: "open",
    verifiedBuilderOrigin: { appId: "123", authorId: "900", marker: "d".repeat(64) },
  };
  const unsigned: Omit<DraftPullRequestSuccessReceipt, "digest"> = {
    version: GITHUB_PUBLICATION_VERSION,
    kind: "draft-pull-request",
    status: "succeeded",
    proposalDigest: "a".repeat(64),
    idempotencyKey: "b".repeat(64),
    approvedByCallId: "original-publication",
    installationIdentityDigest: installation.digest,
    repositoryId: "100",
    branchName: draft.headBranch,
    branchSha: "6".repeat(40),
    branchTree: "7".repeat(40),
    pullRequestId: draft.pullRequestId,
    pullRequestNumber: draft.number,
    draft: true,
    baseBranch: "main",
    baseSha: repository.headSha,
    changeSetDigest: "c".repeat(64),
    changedContentDigest: "d".repeat(64),
    normalizedChangedPaths: ["apps/demo/page.tsx"],
    releaseGateUnchanged: true,
    recoveredFromPending: false,
    providerReadBackDigest: "e".repeat(64),
    ...receiptOverrides,
  };
  const receipt = {
    ...unsigned,
    digest: createHash("sha256").update(JSON.stringify(unsigned)).digest("hex"),
  };
  const read = vi.fn(() => Promise.resolve(receipt));
  const runtime = composeGitHubPublicationRuntime({
    adapter: {
      ...adapterWithoutHistoricalLookup(),
      inspectExistingDraft: () => Promise.resolve(draft),
      inspectRepository: () => Promise.resolve(repository),
      inspectInstallation: () => Promise.resolve(installation),
    },
    enabled: true,
    proposals: { read: vi.fn(), save: vi.fn() },
    receipts: { compareAndSet: vi.fn(), read },
  });
  return { draft, read, receipt, repository, runtime };
};

describe("same-session owned draft repair", () => {
  it("resolves the canonical publication baseline while preserving the observed live draft head", async () => {
    const { draft, receipt, runtime, read } = ownedDraftFixture();
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
      priorPublishedProposalDigest: receipt.proposalDigest,
    });
    expect(result.draft.headSha).toBe(draft.headSha);
    expect(result.publishedHeadSha).toBe(receipt.branchSha);
    expect(read).toHaveBeenCalledWith(receipt.proposalDigest);
  });

  it.each([
    { branchName: "different-draft" },
    { pullRequestId: "150001" },
    { repositoryId: "101" },
  ])("rejects a receipt for a different published target: %j", async (overrides) => {
    const { draft, receipt, runtime } = ownedDraftFixture(overrides);
    await expect(
      runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
      }),
    ).rejects.toThrow("does not match this workflow's tenant-owned published pull request");
  });

  it("seals the exact live owned draft branch when the original selected source remains main", async () => {
    const { draft, receipt, repository, runtime } = ownedDraftFixture();
    const githubSource: ImmutableGitHubSourceReceipt = {
      version: GITHUB_PUBLICATION_VERSION,
      digest: "f".repeat(64),
      installationIdentityDigest: repository.installationIdentityDigest,
      repository,
      resolvedByCallId: "original-source",
      resolvedRef: "refs/heads/main",
      resolvedSha: repository.headSha,
      resolvedTree: repository.headTree,
    };
    const change = {
      after: { digest: "a".repeat(64), mode: "644" },
      kind: "added" as const,
      path: "apps/demo/page.tsx",
    };
    const review = createReconciliationReviewReceipt({
      appId: "demo",
      baseChanges: [change],
      baseSha: repository.headSha,
      baseTree: repository.headTree,
      headChanges: [change],
      headSha: draft.headSha,
      headTree: draft.headTree,
      resolvedTree: "5".repeat(40),
      version: 1,
    });
    const proposal = await runtime.sealExistingDraftReconciliation({
      githubSource,
      priorPublishedProposalDigest: receipt.proposalDigest,
      pullRequestNumber: draft.number,
      review,
      selectedCheckoutHeadSha: draft.headSha,
      selectedCheckoutHeadTree: draft.headTree,
    });
    expect(proposal.branchName).toBe(draft.headBranch);
    expect(proposal.expectedHeadSha).toBe(draft.headSha);
    expect(proposal.priorPublicationDigest).toBe(receipt.digest);
    expect(githubSource.resolvedRef).toBe("refs/heads/main");
  });
});
