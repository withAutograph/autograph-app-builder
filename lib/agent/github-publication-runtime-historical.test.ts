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
  GitHubPublicationReceiptStore,
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

const missingPublicationReceipt = async (): Promise<undefined> => {
  await Promise.resolve();
};

const ownedDraftFixture = (
  receiptOverrides: Partial<Omit<DraftPullRequestSuccessReceipt, "digest">> = {},
  adapterOverrides: Partial<GitHubPublicationAdapter> = {},
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
  const read = vi.fn<GitHubPublicationReceiptStore["read"]>(() => Promise.resolve(receipt));
  const findDraftByPullRequest = vi.fn<
    NonNullable<GitHubPublicationReceiptStore["findDraftByPullRequest"]>
  >(() => Promise.resolve(receipt));
  const runtime = composeGitHubPublicationRuntime({
    adapter: {
      ...adapterWithoutHistoricalLookup(),
      inspectExistingDraft: () => Promise.resolve(draft),
      inspectRepository: () => Promise.resolve(repository),
      inspectInstallation: () => Promise.resolve(installation),
      ...adapterOverrides,
    },
    enabled: true,
    proposals: { read: vi.fn(), save: vi.fn() },
    receipts: { compareAndSet: vi.fn(), findDraftByPullRequest, read },
  });
  return { draft, findDraftByPullRequest, read, receipt, repository, runtime };
};

const recordedSource = (draft: ExistingDraftObservation) => ({
  repositoryId: draft.repositoryId,
  branch: draft.headBranch,
  gitSha: draft.headSha,
  gitTree: draft.headTree,
  changeSetDigest: "c".repeat(64),
  reviewDigest: "d".repeat(64),
});

describe("same-session owned draft repair", () => {
  it("recovers the exact owned historical published head without retained reconciliation slots", async () => {
    const { draft, runtime } = ownedDraftFixture();
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
      readPublishedSource,
    });
    expect(result.publishedHeadSha).toBe(draft.headSha);
    expect(result.draft).toEqual(draft);
    expect(result.publishedReconciliation).toBeUndefined();
    expect(readPublishedSource).toHaveBeenCalledWith(draft);
  });

  it("does not let baseline diagnostic delivery change source recovery", async () => {
    const { draft, runtime } = ownedDraftFixture();
    const log = vi.spyOn(console, "info").mockImplementation(() => {
      throw new Error("Diagnostic unavailable");
    });
    try {
      const result = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        readPublishedSource: () => Promise.resolve(recordedSource(draft)),
      });
      expect(result.publishedHeadSha).toBe(draft.headSha);
      expect(log).toHaveBeenCalledWith(
        JSON.stringify({
          event: "app_builder.draft_reconciliation_baseline",
          source: "published-source",
          previousReconciliationPresent: false,
          publishedReconciliationPresent: false,
          canonicalPublishedSourceMatched: true,
        }),
      );
    } finally {
      log.mockRestore();
    }
  });

  it.each(["repositoryId", "branch", "gitSha", "gitTree"] as const)(
    "does not adopt a historical marker with changed %s",
    async (field) => {
      const { draft, receipt, runtime } = ownedDraftFixture();
      const changed = { ...recordedSource(draft), [field]: "f".repeat(40) };
      const result = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        readPublishedSource: () => Promise.resolve(changed),
      });
      expect(result.publishedHeadSha).toBe(receipt.branchSha);
      expect(result.draft).toEqual(draft);
    },
  );

  it("never consults a marker without the tenant-owned original publication receipt", async () => {
    const { draft, findDraftByPullRequest, runtime } = ownedDraftFixture();
    findDraftByPullRequest.mockImplementationOnce(missingPublicationReceipt);
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
      readPublishedSource,
    });
    expect(result.publishedHeadSha).toBeUndefined();
    expect(readPublishedSource).not.toHaveBeenCalled();
  });

  it("keeps the existing original-head baseline without an additional marker read", async () => {
    const { draft, runtime } = ownedDraftFixture({ branchSha: "1".repeat(40) });
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
      readPublishedSource,
    });
    expect(result.publishedHeadSha).toBe(draft.headSha);
    expect(readPublishedSource).not.toHaveBeenCalled();
  });

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

  it.each([true, false])(
    "uses the last approved merge as the second revision baseline only with provider proof (%s)",
    async (applied) => {
      const inspectAppliedDraftReconciliation = vi.fn(() => Promise.resolve(applied));
      const { draft, receipt, repository, runtime } = ownedDraftFixture(
        {},
        {
          inspectAppliedDraftReconciliation,
        },
      );
      const review = createReconciliationReviewReceipt({
        appId: "demo",
        baseChanges: [],
        baseSha: repository.headSha,
        baseTree: repository.headTree,
        headChanges: [],
        headSha: draft.headSha,
        headTree: draft.headTree,
        resolvedTree: "5".repeat(40),
        version: 1,
      });
      const proposal = await runtime.sealExistingDraftReconciliation({
        githubSource: {
          version: GITHUB_PUBLICATION_VERSION,
          digest: "f".repeat(64),
          installationIdentityDigest: repository.installationIdentityDigest,
          repository,
          resolvedByCallId: "original-source",
          resolvedRef: "refs/heads/main",
          resolvedSha: repository.headSha,
          resolvedTree: repository.headTree,
        },
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        review,
        selectedCheckoutHeadSha: draft.headSha,
        selectedCheckoutHeadTree: draft.headTree,
      });
      // The private sealed candidate survives publication and the next app review.
      draft.headSha = "8".repeat(40);
      draft.headTree = review.resolvedTree;
      const result = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
        previousReconciliation: proposal,
      });
      expect(result.publishedHeadSha).toBe(applied ? draft.headSha : receipt.branchSha);
      expect(inspectAppliedDraftReconciliation).toHaveBeenCalledWith(proposal, draft);
      const unrelated = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
        previousReconciliation: { ...proposal, branchName: "another-draft" },
      });
      expect(unrelated.publishedHeadSha).toBe(receipt.branchSha);
      if (!applied || result.publishedReconciliation === undefined) {
        return;
      }
      const nextReview = createReconciliationReviewReceipt({
        appId: review.appId,
        baseChanges: review.baseChanges,
        baseSha: review.baseSha,
        baseTree: review.baseTree,
        headChanges: review.headChanges,
        headSha: draft.headSha,
        headTree: draft.headTree,
        resolvedTree: "9".repeat(40),
        version: 1,
      });
      const nextProposal = await runtime.sealExistingDraftReconciliation({
        githubSource: {
          version: GITHUB_PUBLICATION_VERSION,
          digest: "f".repeat(64),
          installationIdentityDigest: repository.installationIdentityDigest,
          repository,
          resolvedByCallId: "original-source",
          resolvedRef: "refs/heads/main",
          resolvedSha: repository.headSha,
          resolvedTree: repository.headTree,
        },
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        review: nextReview,
        selectedCheckoutHeadSha: draft.headSha,
        selectedCheckoutHeadTree: draft.headTree,
      });
      // A rebuilt candidate's new sealed review is still unpublished; retain the proven merge.
      const rebuilt = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
        previousReconciliation: nextProposal,
        publishedReconciliation: result.publishedReconciliation,
      });
      expect(rebuilt.publishedReconciliation).toEqual(proposal);
      expect(rebuilt.publishedHeadSha).toBe(draft.headSha);
      // Recover a succeeded write even if recording its new published marker was interrupted.
      draft.headSha = "a".repeat(40);
      draft.headTree = nextReview.resolvedTree;
      const recovered = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
        previousReconciliation: nextProposal,
        publishedReconciliation: result.publishedReconciliation,
      });
      expect(recovered.publishedReconciliation).toEqual(nextProposal);
      expect(recovered.publishedHeadSha).toBe(draft.headSha);
    },
  );
  it("recovers the owned publication baseline when the workflow marker is absent", async () => {
    const { draft, findDraftByPullRequest, receipt, runtime } = ownedDraftFixture();
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
    });
    expect(result.publishedHeadSha).toBe(receipt.branchSha);
    expect(result.draft.headSha).toBe(draft.headSha);
    expect(findDraftByPullRequest).toHaveBeenCalledWith(draft.repositoryId, draft.number);
  });

  it("does not claim a publication baseline when the tenant-scoped lookup has no receipt", async () => {
    const { draft, findDraftByPullRequest, runtime } = ownedDraftFixture();
    findDraftByPullRequest.mockImplementationOnce(missingPublicationReceipt);
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      repositoryId: draft.repositoryId,
      pullRequestNumber: draft.number,
    });
    expect(result).not.toHaveProperty("publishedHeadSha");
    expect(result.draft).toEqual(draft);
  });

  it("does not substitute a discovered receipt for an unavailable explicit marker", async () => {
    const { draft, findDraftByPullRequest, read, receipt, runtime } = ownedDraftFixture();
    read.mockImplementationOnce(missingPublicationReceipt);
    await expect(
      runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
        priorPublishedProposalDigest: receipt.proposalDigest,
      }),
    ).rejects.toThrow("receipt is unavailable in this tenant");
    expect(findDraftByPullRequest).not.toHaveBeenCalled();
  });

  it("rejects a discovered receipt with a noncanonical digest", async () => {
    const { draft, receipt, runtime } = ownedDraftFixture();
    receipt.digest = "f".repeat(64);
    await expect(
      runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
      }),
    ).rejects.toThrow("digest");
  });

  it.each([
    { branchName: "different-draft" },
    { pullRequestId: "150001" },
    { pullRequestNumber: 1501 },
    { repositoryId: "101" },
  ])("rejects a discovered receipt for a different published target: %j", async (overrides) => {
    const { draft, runtime } = ownedDraftFixture(overrides);
    await expect(
      runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        repositoryId: draft.repositoryId,
        pullRequestNumber: draft.number,
      }),
    ).rejects.toThrow("does not match this workflow's tenant-owned published pull request");
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

  it.each(["retained", "missing", "unavailable"] as const)(
    "uses proven publication ownership while the original source stays main (%s marker)",
    async (marker) => {
      const { draft, findDraftByPullRequest, receipt, repository, runtime } = ownedDraftFixture();
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
      const request = {
        githubSource,
        ...(marker === "retained" ? { priorPublishedProposalDigest: receipt.proposalDigest } : {}),
        pullRequestNumber: draft.number,
        review,
        selectedCheckoutHeadSha: draft.headSha,
        selectedCheckoutHeadTree: draft.headTree,
      };
      if (marker === "unavailable") {
        findDraftByPullRequest.mockImplementationOnce(missingPublicationReceipt);
        await expect(runtime.sealExistingDraftReconciliation(request)).rejects.toThrow();
        expect(findDraftByPullRequest).toHaveBeenCalledWith(draft.repositoryId, draft.number);
        expect(githubSource.resolvedRef).toBe("refs/heads/main");
        return;
      }
      const proposal = await runtime.sealExistingDraftReconciliation(request);
      expect(proposal.branchName).toBe(draft.headBranch);
      expect(proposal.expectedHeadSha).toBe(draft.headSha);
      expect(proposal.priorPublicationDigest).toBe(receipt.digest);
      expect(githubSource.resolvedRef).toBe("refs/heads/main");
    },
  );
});
