import { createHash } from "node:crypto";

import { describe, expect, it, vi } from "vitest";

import {
  createDraftPullRequestProposal,
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
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import { createReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
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
  const read = vi.fn<GitHubPublicationReceiptStore["read"]>().mockResolvedValue(receipt);
  const findDraftByPullRequest = vi
    .fn<NonNullable<GitHubPublicationReceiptStore["findDraftByPullRequest"]>>()
    .mockResolvedValue(receipt);
  const readProposal = vi.fn<GitHubPublicationProposalStore["read"]>();
  const runtime = composeGitHubPublicationRuntime({
    adapter: {
      ...adapterWithoutHistoricalLookup(),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      inspectExistingDraft: () => Promise.resolve(draft),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      inspectRepository: () => Promise.resolve(repository),
      // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
      inspectInstallation: () => Promise.resolve(installation),
      ...adapterOverrides,
    },
    enabled: true,
    proposals: { read: readProposal, save: vi.fn() },
    receipts: { compareAndSet: vi.fn(), findDraftByPullRequest, read },
  });
  return {
    draft,
    findDraftByPullRequest,
    installation,
    read,
    readProposal,
    receipt,
    repository,
    runtime,
  };
};

const firstAppManifest = "apps/demo/package.json";
const hash = (serialized: string) => createHash("sha256").update(serialized).digest("hex");

const firstAppPublicationFixture = (extraPaths: readonly string[] = []) => {
  const inspectDestinationFiles = vi
    .fn<NonNullable<GitHubPublicationAdapter["inspectDestinationFiles"]>>()
    .mockResolvedValue([]);
  const f = ownedDraftFixture({}, { inspectDestinationFiles });
  const { digest: _liveDigest, version: _liveVersion, ...liveBase } = f.repository;
  void _liveDigest;
  void _liveVersion;
  const originalBase = createRepositoryObservation({
    ...liveBase,
    headSha: "8".repeat(40),
    headTree: "9".repeat(40),
  });
  const approvedPaths = [
    firstAppManifest,
    "bun.lock",
    "microfrontends.json",
    ...extraPaths,
  ].toSorted();
  const changes = approvedPaths.map((path) => {
    const after = { mode: "644", digest: hash(path) };
    return path.startsWith("apps/")
      ? { path, kind: "added" as const, after }
      : {
          path,
          kind: "modified" as const,
          before: { mode: "644", digest: hash(`base-${path}`) },
          after,
        };
  });
  const bindingDigest = hash("controlled-proof");
  const unsigned = {
    version: 2 as const,
    validationDigest: bindingDigest,
    applyDigest: bindingDigest,
    proposalDigest: bindingDigest,
    contractDigest: bindingDigest,
    repositoryContractDigest: bindingDigest,
    sourceSha: originalBase.headSha,
    sourceTree: originalBase.headTree,
    sourceReceiptDigest: bindingDigest,
    eligibilityDigest: bindingDigest,
    workspaceDigest: bindingDigest,
    appSpecDigest: bindingDigest,
    appSpecPath: "apps/demo/.config/app-spec.md",
    artifactRevision: bindingDigest,
    dependencyReceiptDigest: bindingDigest,
    identityDigest: bindingDigest,
    imageDigest: `sha256:${bindingDigest}`,
    dependencyCacheDigest: bindingDigest,
    dependencyCacheContentDigest: bindingDigest,
    targetReceipt: {
      version: 1 as const,
      topology: { path: "microfrontends.json", oldDigest: bindingDigest, newDigest: bindingDigest },
    },
    preTreeDigest: bindingDigest,
    postTreeDigest: bindingDigest,
    changedContentDigest: bindingDigest,
    changes,
    approvedPaths,
  };
  const review = createReviewedChangeSetReceipt(
    { ...unsigned, digest: hash(JSON.stringify(unsigned)) },
    "original-draft-review",
  );
  const proposal = createDraftPullRequestProposal({
    installation: f.installation,
    repository: originalBase,
    review,
    changedPathsSinceBase: [],
    title: "Publish new app",
  });
  f.draft.headBranch = proposal.branchName;
  f.draft.verifiedBuilderOrigin = {
    appId: "123",
    authorId: "900",
    marker: proposal.idempotencyKey,
  };
  const { digest: _receiptDigest, ...receipt } = f.receipt;
  void _receiptDigest;
  const unsignedPublication = {
    ...receipt,
    proposalDigest: proposal.digest,
    idempotencyKey: proposal.idempotencyKey,
    branchName: proposal.branchName,
    branchSha: f.draft.headSha,
    branchTree: f.draft.headTree,
    changeSetDigest: proposal.changeSetDigest,
    changedContentDigest: proposal.changedContentDigest,
    normalizedChangedPaths: proposal.approvedPaths,
  };
  const publication = { ...unsignedPublication, digest: hash(JSON.stringify(unsignedPublication)) };
  f.read.mockResolvedValue(publication);
  f.findDraftByPullRequest.mockResolvedValue(publication);
  f.readProposal.mockResolvedValue(proposal);
  return {
    ...f,
    originalBase,
    inspectDestinationFiles,
    proposal,
    publication,
    request: {
      firstPublicationAppId: "demo",
      priorPublishedProposalDigest: proposal.digest,
      name: f.draft.name,
      owner: f.draft.owner,
      pullRequestNumber: f.draft.number,
      repositoryId: f.draft.repositoryId,
    },
  };
};

describe("owned first app registration on an acquired repository", () => {
  it("binds the exact original draft and original base absence before carrying its root lock", async () => {
    const f = firstAppPublicationFixture();
    const result = await f.runtime.inspectExistingDraftReconciliationSource(f.request);
    expect(result.ownedPublication).toEqual({ proposal: f.proposal, publication: f.publication });
    expect(f.readProposal).toHaveBeenCalledExactlyOnceWith(f.proposal.digest);
    expect(f.inspectDestinationFiles).toHaveBeenCalledExactlyOnceWith({
      paths: [firstAppManifest],
      repository: f.originalBase,
    });
    expect(result.base.headSha).toBe(f.repository.headSha);
  });

  it.each(["headSha", "headTree", "origin"] as const)(
    "keeps ordinary source inspection without authorizing inherited root content after %s moves",
    async (field) => {
      const f = firstAppPublicationFixture();
      if (field === "origin") {
        f.draft.verifiedBuilderOrigin = { appId: "123", authorId: "900", marker: "f".repeat(64) };
      } else {
        f.draft[field] = "f".repeat(40);
      }
      const result = await f.runtime.inspectExistingDraftReconciliationSource(f.request);
      expect(result.ownedPublication).toBeUndefined();
      expect(f.readProposal).not.toHaveBeenCalled();
      expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    },
  );

  it("requires explicit same-app saved publication context and refuses other root paths", async () => {
    const f = firstAppPublicationFixture(["docs/unrelated.md"]);
    const unrelated = await f.runtime.inspectExistingDraftReconciliationSource(f.request);
    expect(unrelated.ownedPublication).toBeUndefined();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();

    const owned = firstAppPublicationFixture();
    const { priorPublishedProposalDigest: _saved, ...withoutSaved } = owned.request;
    void _saved;
    const missingSaved = await owned.runtime.inspectExistingDraftReconciliationSource(withoutSaved);
    expect(missingSaved.ownedPublication).toBeUndefined();
    expect(owned.readProposal).not.toHaveBeenCalled();
    const sibling = await owned.runtime.inspectExistingDraftReconciliationSource({
      ...owned.request,
      firstPublicationAppId: "sibling",
    });
    expect(sibling.ownedPublication).toBeUndefined();
    expect(owned.inspectDestinationFiles).not.toHaveBeenCalled();
  });

  it("rejects a canonical receipt whose paths differ from the approved proposal", async () => {
    const f = firstAppPublicationFixture();
    const { digest: _digest, ...receipt } = f.publication;
    void _digest;
    const changed = {
      ...receipt,
      normalizedChangedPaths: [firstAppManifest, "microfrontends.json"],
    };
    f.read.mockResolvedValue({ ...changed, digest: hash(JSON.stringify(changed)) });
    await expect(f.runtime.inspectExistingDraftReconciliationSource(f.request)).rejects.toThrow();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
  });

  it("does not expand an existing app whose manifest was already present in the sealed base", async () => {
    const f = firstAppPublicationFixture();
    f.inspectDestinationFiles.mockResolvedValue([
      { path: firstAppManifest, mode: "644", digest: hash(firstAppManifest) },
    ]);
    const result = await f.runtime.inspectExistingDraftReconciliationSource(f.request);
    expect(result.ownedPublication).toBeUndefined();
  });
});

const recordedSource = (draft: ExistingDraftObservation) => ({
  repositoryId: draft.repositoryId,
  branch: draft.headBranch,
  gitSha: draft.headSha,
  gitTree: draft.headTree,
  changeSetDigest: "c".repeat(64),
  reviewDigest: "d".repeat(64),
});

describe("same-session owned draft repair", () => {
  it("prepares and seals a Ready PR only from its canonical owned publication", async () => {
    const { draft, runtime, receipt, repository } = ownedDraftFixture({
      idempotencyKey: "d".repeat(64),
    });
    draft.draft = false;
    const source = await runtime.inspectExistingDraftReconciliationSource({
      repositoryId: draft.repositoryId,
      owner: draft.owner,
      name: draft.name,
      pullRequestNumber: draft.number,
      // oxlint-disable-next-line eslint/require-await -- Controlled asynchronous repository read port.
      readPublishedSource: async () => recordedSource(draft),
    });
    expect(source.draft.draft).toBe(false);
    const change = {
      after: { digest: "a".repeat(64), mode: "644" },
      kind: "added" as const,
      path: "apps/demo/page.tsx",
    };
    const review = createReconciliationReviewReceipt({
      version: 1,
      appId: "demo",
      baseChanges: [change],
      headChanges: [change],
      baseSha: repository.headSha,
      baseTree: repository.headTree,
      headSha: draft.headSha,
      headTree: draft.headTree,
      resolvedTree: "5".repeat(40),
    });
    const proposal = await runtime.sealExistingDraftReconciliation({
      githubSource: {
        version: GITHUB_PUBLICATION_VERSION,
        digest: "f".repeat(64),
        installationIdentityDigest: repository.installationIdentityDigest,
        repository,
        resolvedByCallId: "source",
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
    expect(proposal.returnToDraft).toBe(true);
    expect(proposal.expectedHeadSha).toBe(draft.headSha);
    expect(proposal.pullRequestId).toBe(draft.pullRequestId);
  });

  it.each(["missing", "foreign-repository", "foreign-pr", "foreign-marker", "closed"])(
    "refuses privately adopting an unowned Ready PR (%s)",
    async (reason) => {
      const f = ownedDraftFixture({ idempotencyKey: "d".repeat(64) });
      f.draft.draft = false;
      if (reason === "missing") {
        f.findDraftByPullRequest.mockImplementation(missingPublicationReceipt);
      }
      if (reason === "foreign-repository") {
        f.draft.repositoryId = "999";
      }
      if (reason === "foreign-pr") {
        f.draft.pullRequestId = "999";
      }
      if (reason === "foreign-marker") {
        delete f.draft.verifiedBuilderOrigin;
      }
      if (reason === "closed") {
        f.draft.state = "closed";
      }
      await expect(
        f.runtime.inspectExistingDraftSource({
          repositoryId: "100",
          owner: f.draft.owner,
          name: f.draft.name,
          pullRequestNumber: f.draft.number,
        }),
      ).rejects.toThrow();
    },
  );

  it("recovers the exact owned historical published head without retained reconciliation slots", async () => {
    const { draft, runtime } = ownedDraftFixture();
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      pullRequestNumber: draft.number,
      readPublishedSource,
      repositoryId: draft.repositoryId,
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
        pullRequestNumber: draft.number,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        readPublishedSource: () => Promise.resolve(recordedSource(draft)),
        repositoryId: draft.repositoryId,
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
        pullRequestNumber: draft.number,
        // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
        readPublishedSource: () => Promise.resolve(changed),
        repositoryId: draft.repositoryId,
      });
      expect(result.publishedHeadSha).toBe(receipt.branchSha);
      expect(result.draft).toEqual(draft);
    },
  );

  it("never consults a marker without the tenant-owned original publication receipt", async () => {
    const { draft, findDraftByPullRequest, runtime } = ownedDraftFixture();
    findDraftByPullRequest.mockImplementationOnce(missingPublicationReceipt);
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      pullRequestNumber: draft.number,
      readPublishedSource,
      repositoryId: draft.repositoryId,
    });
    expect(result.publishedHeadSha).toBeUndefined();
    expect(readPublishedSource).not.toHaveBeenCalled();
  });

  it("keeps the existing original-head baseline without an additional marker read", async () => {
    const { draft, runtime } = ownedDraftFixture({ branchSha: "1".repeat(40) });
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve this test double's existing promise and synchronous behavior.
    const readPublishedSource = vi.fn(() => Promise.resolve(recordedSource(draft)));
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      pullRequestNumber: draft.number,
      readPublishedSource,
      repositoryId: draft.repositoryId,
    });
    expect(result.publishedHeadSha).toBe(draft.headSha);
    expect(readPublishedSource).not.toHaveBeenCalled();
  });

  it("resolves the canonical publication baseline while preserving the observed live draft head", async () => {
    const { draft, receipt, runtime, read } = ownedDraftFixture();
    const result = await runtime.inspectExistingDraftReconciliationSource({
      name: draft.name,
      owner: draft.owner,
      priorPublishedProposalDigest: receipt.proposalDigest,
      pullRequestNumber: draft.number,
      repositoryId: draft.repositoryId,
    });
    expect(result.draft.headSha).toBe(draft.headSha);
    expect(result.publishedHeadSha).toBe(receipt.branchSha);
    expect(read).toHaveBeenCalledWith(receipt.proposalDigest);
  });

  it.each([true, false])(
    "uses the last approved merge as the second revision baseline only with provider proof (%s)",
    async (applied) => {
      const inspectAppliedDraftReconciliation = vi
        .fn<NonNullable<GitHubPublicationAdapter["inspectAppliedDraftReconciliation"]>>()
        .mockResolvedValue(applied);
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
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
        previousReconciliation: proposal,
      });
      expect(result.publishedHeadSha).toBe(applied ? draft.headSha : receipt.branchSha);
      const verifyOwnedHeadMatcher: unknown = expect.any(Function);
      expect(inspectAppliedDraftReconciliation).toHaveBeenCalledWith(proposal, draft, {
        reconciliations: [],
        verifyOwnedHead: verifyOwnedHeadMatcher,
      });
      const unrelated = await runtime.inspectExistingDraftReconciliationSource({
        name: draft.name,
        owner: draft.owner,
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
      pullRequestNumber: draft.number,
      repositoryId: draft.repositoryId,
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
      pullRequestNumber: draft.number,
      repositoryId: draft.repositoryId,
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
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
        priorPublishedProposalDigest: receipt.proposalDigest,
        pullRequestNumber: draft.number,
        repositoryId: draft.repositoryId,
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
      const sourceBinding: Pick<
        Parameters<typeof runtime.sealExistingDraftReconciliation>[0],
        "githubSource" | "priorPublishedProposalDigest"
      > = {
        githubSource,
      };
      if (marker === "retained") {
        sourceBinding.priorPublishedProposalDigest = receipt.proposalDigest;
      }
      const request = {
        ...sourceBinding,
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
