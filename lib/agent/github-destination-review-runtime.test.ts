import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { composeGitHubPublicationRuntime } from "./github-publication-runtime";
import {
  createGitHubDestinationReviewBinding,
  deriveDestinationChanges,
} from "../repository/github-destination-review";
import {
  changedAppTextExport,
  reviewExportChanges,
  destinationReviewReadProgress,
} from "../../agent/tools/change_set_status";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  GITHUB_PUBLICATION_VERSION,
} from "../repository/github-publication";
import type {
  DraftPublicationReadBack,
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
  GitHubOperation,
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
  ImmutableGitHubSourceReceipt,
  GitHubMutationPendingReceipt,
} from "../repository/github-publication";
import type { GitHubPublicationProposal } from "../repository/postgres-github-publication-store";
import { createReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { NormalizedChangeSet } from "../repository/reviewed-change-set";
import type { SourceReceiptEvidence } from "../repository/source-receipt";
import { LEGACY_SOURCE_RECEIPT_VERSION } from "../repository/source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "../repository/supported-template";

const hash = (
  value:
    | NormalizedChangeSet["changes"]
    | Omit<NormalizedChangeSet, "digest">
    | Omit<GitHubMutationPendingReceipt, "digest">,
) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const installation = (operation: GitHubOperation, installationId = "10") =>
  createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId,
    operation,
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
const readInstallation = installation("resolve-existing-source");
const repository = createRepositoryObservation({
  defaultBranch: "main",
  headSha: "1".repeat(40),
  headTree: "2".repeat(40),
  installationIdentityDigest: readInstallation.digest,
  name: "example",
  owner: "withAutograph",
  releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
  repositoryId: "100",
  visibility: "private",
});
const source: ImmutableGitHubSourceReceipt = {
  digest: "a".repeat(64),
  installationIdentityDigest: readInstallation.digest,
  repository,
  resolvedByCallId: "original-source",
  resolvedRef: "refs/heads/main",
  resolvedSha: "79952fedea119831cc30beab504d3d7d6b271209",
  resolvedTree: "4".repeat(40),
  version: GITHUB_PUBLICATION_VERSION,
};
const path = "apps/example/schema/index.ts";
const before = "65ef3e0c6347d4b901399d48633fdc91af6eb909884227efddb7b61b971f1e01";
const after = "7d13baed047bafdce5448d1daef6222a2b197a8cfdb6de499633d32eb973d835";
const changes = [
  {
    after: { digest: after, mode: "644" },
    before: { digest: before, mode: "644" },
    kind: "modified" as const,
    path,
  },
];
const unsigned = {
  appSpecDigest: "a".repeat(64),
  appSpecPath: "prototype/example/app-spec.md",
  applyDigest: "b".repeat(64),
  approvedPaths: [path],
  artifactRevision: "c".repeat(64),
  changedContentDigest: hash(changes),
  changes,
  contractDigest: "d".repeat(64),
  dependencyCacheContentDigest: "e".repeat(64),
  dependencyCacheDigest: "f".repeat(64),
  dependencyReceiptDigest: "0".repeat(64),
  eligibilityDigest: "1".repeat(64),
  identityDigest: "2".repeat(64),
  imageDigest: `sha256:${"3".repeat(64)}`,
  postTreeDigest: "4".repeat(64),
  preTreeDigest: "5".repeat(64),
  proposalDigest: "6".repeat(64),
  repositoryContractDigest: "7".repeat(64),
  sourceReceiptDigest: "8".repeat(64),
  sourceSha: source.resolvedSha,
  sourceTree: source.resolvedTree,
  targetReceipt: {
    topology: { newDigest: "a".repeat(64), oldDigest: "9".repeat(64), path: "apps.json" },
    version: 1 as const,
  },
  validationDigest: "b".repeat(64),
  version: 2 as const,
  workspaceDigest: "c".repeat(64),
};
const normalized: NormalizedChangeSet = { ...unsigned, digest: hash(unsigned) };
const review = createReviewedChangeSetReceipt(normalized, "destination-review");
const sourceEvidence: SourceReceiptEvidence = {
  adapter: SUPPORTED_TEMPLATE_ADAPTER,
  contractDigest: review.contractDigest,
  digest: review.sourceReceiptDigest,
  eligibilityDigest: review.eligibilityDigest,
  releaseEnabled: false,
  sourceKind: "existing-repository",
  sourceSha: source.resolvedSha,
  sourceTree: source.resolvedTree,
  version: LEGACY_SOURCE_RECEIPT_VERSION,
};
const destination = createGitHubDestinationReviewBinding({
  applyDigest: review.applyDigest,
  candidatePaths: [path],
  installation: readInstallation,
  postTreeDigest: review.postTreeDigest,
  preTree: [{ digest: before, mode: "644", path }],
  repository,
  validationDigest: review.validationDigest,
});

const fixture = () => {
  const unexpected = vi.fn().mockRejectedValue(new Error("Unexpected mutation"));
  const inspectRepository = vi.fn().mockResolvedValue(repository);
  const inspectInstallation = vi
    .fn()
    .mockImplementation(
      async (operation: GitHubOperation) => await Promise.resolve(installation(operation)),
    );
  const inspectDestinationFiles = vi.fn().mockResolvedValue(destination.preTree);
  const inspectDraftPublication = vi.fn<GitHubPublicationAdapter["inspectDraftPublication"]>();
  const compareAndSet = vi
    .fn<GitHubPublicationReceiptStore["compareAndSet"]>()
    .mockResolvedValue(true);
  const adapter: GitHubPublicationAdapter = {
    createPrivateFreshHistoryRepository: unexpected,
    inspectDestination: unexpected,
    inspectDestinationFiles,
    inspectDraftPublication,
    inspectExistingDraft: unexpected,
    inspectFreshRepositoryOutcome: unexpected,
    inspectInstallation,
    inspectRepository,
    publishDraftPullRequest: unexpected,
    updateExistingDraft: unexpected,
  };
  const save = vi.fn(
    async (proposal: GitHubPublicationProposal) => await Promise.resolve(proposal),
  );
  const readReceipt = vi.fn();
  const runtime = composeGitHubPublicationRuntime({
    adapter,
    enabled: true,
    proposals: { read: vi.fn(), save },
    receipts: { compareAndSet, read: readReceipt },
  });
  return {
    compareAndSet,
    inspectDestinationFiles,
    inspectDraftPublication,
    inspectInstallation,
    inspectRepository,
    readReceipt,
    runtime,
    save,
    unexpected,
  };
};

const sealDraft = async (runtime: ReturnType<typeof fixture>["runtime"]) =>
  await runtime.sealDraftPullRequestProposal({
    destinationReview: destination,
    githubSource: source,
    review,
    source: sourceEvidence,
    title: "Update reviewed schema",
  });

const pendingReceipt = (proposal: DraftPullRequestProposal): GitHubMutationPendingReceipt => {
  const pending = {
    approvedByCallId: "prior-approval",
    idempotencyKey: proposal.idempotencyKey,
    kind: "draft-pull-request" as const,
    proposalDigest: proposal.digest,
    status: "pending" as const,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...pending, digest: hash(pending) };
};

const pendingReadBackCases = ["absent", "branch-only", "different-head"] as const;

const draftReadBack = (
  proposal: DraftPullRequestProposal,
  observation: (typeof pendingReadBackCases)[number] | "exact",
): DraftPublicationReadBack => {
  const branchSha = "5".repeat(40);
  const body: Omit<DraftPublicationReadBack, "digest"> = {
    version: GITHUB_PUBLICATION_VERSION,
    idempotencyKey: proposal.idempotencyKey,
    repository: createRepositoryObservation({
      defaultBranch: repository.defaultBranch,
      headSha: repository.headSha,
      headTree: repository.headTree,
      installationIdentityDigest: proposal.installationIdentityDigest,
      name: repository.name,
      owner: repository.owner,
      releaseGate: repository.releaseGate,
      repositoryId: repository.repositoryId,
      visibility: repository.visibility,
    }),
    changedPathsSinceBase: [],
    branch:
      observation === "absent"
        ? { status: "absent" }
        : {
            status: "present",
            branchName: proposal.branchName,
            branchSha,
            branchTree: "6".repeat(40),
            normalizedChangedPaths: proposal.approvedPaths,
            changedContentDigest: proposal.changedContentDigest,
            idempotencyKey: proposal.idempotencyKey,
          },
    pullRequest:
      observation === "exact" || observation === "different-head"
        ? {
            status: "present",
            pullRequestId: "1234",
            pullRequestNumber: 42,
            draft: true,
            headRepositoryId: proposal.repositoryId,
            headBranch: proposal.branchName,
            headSha: observation === "exact" ? branchSha : "7".repeat(40),
            baseRepositoryId: proposal.repositoryId,
            baseBranch: proposal.baseBranch,
            baseSha: repository.headSha,
            changeSetDigest: proposal.changeSetDigest,
            idempotencyKey: proposal.idempotencyKey,
          }
        : { status: "absent" },
  };
  return { ...body, digest: createHash("sha256").update(JSON.stringify(body)).digest("hex") };
};

describe("initial draft destination runtime", () => {
  it("reviews both current pointer sides before sealing the same snapshot while retaining original source provenance", async () => {
    const f = fixture();
    const oldBefore = "2e8b47059d77abc6d06d9260d630b0081cb5495e9fb550526b40a92fd717afd4";
    const currentText = 'export * from "./release/2026-10-07.http-expiry-v26/data-server";\n';
    const validatedText =
      'export * from "./release/2026-10-08.authenticated-review-v2/data-server";\n';
    expect(createHash("sha256").update(currentText).digest("hex")).toBe(before);
    expect(createHash("sha256").update(validatedText).digest("hex")).toBe(after);
    const derived = deriveDestinationChanges(destination, {
      files: [{ digest: after, mode: "644", path }],
      treeDigest: "full-checkout",
    });
    expect(derived[0]?.before?.digest).not.toBe(oldBefore);
    expect(derived[0]?.before?.digest).toBe(before);
    const refreshedBody = {
      ...unsigned,
      approvedPaths: derived.map((change) => change.path),
      changedContentDigest: hash(derived),
      changes: derived,
    };
    const refreshed = createReviewedChangeSetReceipt(
      { ...refreshedBody, digest: hash(refreshedBody) },
      "fresh-destination-review",
    );
    const beforeExport = await changedAppTextExport(
      reviewExportChanges(derived, "before"),
      "example",
      async () => await Promise.resolve(currentText),
    );
    const afterExport = await changedAppTextExport(
      reviewExportChanges(derived, "after"),
      "example",
      async () => await Promise.resolve(validatedText),
    );
    expect(beforeExport.exportFiles[0]?.content).toBe(currentText);
    expect(afterExport.exportFiles[0]?.content).toBe(validatedText);
    const beforeRead = destinationReviewReadProgress({
      changeSetDigest: refreshed.changeSetDigest,
      readable: true,
      side: "before",
    });
    const bothRead = destinationReviewReadProgress({
      changeSetDigest: refreshed.changeSetDigest,
      previous: beforeRead,
      readable: true,
      side: "after",
    });
    expect(bothRead).toMatchObject({ afterComplete: true, beforeComplete: true });
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review: refreshed,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    expect(proposal).toMatchObject({
      baseSha: destination.repository.headSha,
      baseTree: destination.repository.headTree,
      reviewDigest: refreshed.digest,
    });
    expect(refreshed.sourceSha).toBe("79952fedea119831cc30beab504d3d7d6b271209");
    expect(f.inspectRepository).not.toHaveBeenCalled();
  });
  it.each([...pendingReadBackCases, "unavailable"] as const)(
    "preserves pending publication when readback is %s",
    async (observation) => {
      const f = fixture();
      const proposal = await sealDraft(f.runtime);
      f.readReceipt.mockResolvedValue(pendingReceipt(proposal));
      if (observation === "unavailable") {
        f.inspectDraftPublication.mockRejectedValue(new Error("Provider unavailable"));
      } else {
        f.inspectDraftPublication.mockResolvedValue(draftReadBack(proposal, observation));
      }
      await expect(
        f.runtime.inspectDraftDestination?.({
          existingProposal: proposal,
          githubSource: source,
          paths: [path],
        }),
      ).rejects.toThrow("outcome is unknown");
      expect(f.inspectDraftPublication).toHaveBeenCalledExactlyOnceWith(proposal);
      expect(f.compareAndSet).not.toHaveBeenCalled();
      expect(f.inspectRepository).not.toHaveBeenCalled();
      expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
      expect(f.unexpected).not.toHaveBeenCalled();
    },
  );

  it("settles an exact pending branch and draft readback under the original approval", async () => {
    const f = fixture();
    const proposal = await sealDraft(f.runtime);
    const pending = pendingReceipt(proposal);
    f.readReceipt.mockResolvedValue(pending);
    const readBack = draftReadBack(proposal, "exact");
    f.inspectDraftPublication.mockResolvedValue(readBack);

    const request = { existingProposal: proposal, githubSource: source, paths: [path] };
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.compareAndSet).toHaveBeenCalledExactlyOnceWith(
      proposal.digest,
      pending.digest,
      expect.objectContaining({
        approvedByCallId: pending.approvedByCallId,
        providerReadBackDigest: readBack.digest,
        pullRequestNumber: 42,
        recoveredFromPending: true,
        status: "succeeded",
      }),
    );

    f.readReceipt.mockResolvedValue(f.compareAndSet.mock.calls[0]?.[2]);
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.inspectDraftPublication).toHaveBeenCalledExactlyOnceWith(proposal);
    expect(f.inspectRepository).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(f.unexpected).not.toHaveBeenCalled();
  });
  it("opens an ordinary review for a sealed-only draft and identifies the same PR after publication", async () => {
    const f = fixture();
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    const request = { existingProposal: proposal, githubSource: source, paths: [path] };
    await expect(f.runtime.inspectDraftDestination?.(request)).resolves.toMatchObject({
      repository,
    });

    const published: Omit<DraftPullRequestSuccessReceipt, "digest"> = {
      approvedByCallId: "prior-publication",
      baseBranch: repository.defaultBranch,
      baseSha: proposal.baseSha,
      branchName: proposal.branchName,
      branchSha: "5".repeat(40),
      branchTree: "6".repeat(40),
      changedContentDigest: review.changedContentDigest,
      changeSetDigest: review.changeSetDigest,
      draft: true,
      idempotencyKey: proposal.idempotencyKey,
      installationIdentityDigest: proposal.installationIdentityDigest,
      kind: "draft-pull-request",
      normalizedChangedPaths: [path],
      proposalDigest: proposal.digest,
      providerReadBackDigest: "7".repeat(64),
      pullRequestId: "1234",
      pullRequestNumber: 42,
      recoveredFromPending: false,
      releaseGateUnchanged: true,
      repositoryId: repository.repositoryId,
      status: "succeeded",
      version: GITHUB_PUBLICATION_VERSION,
    };
    f.readReceipt.mockResolvedValue({
      ...published,
      digest: createHash("sha256").update(JSON.stringify(published)).digest("hex"),
    });
    f.inspectRepository.mockClear();
    await expect(f.runtime.inspectDraftDestination?.(request)).rejects.toThrow("pull request #42");
    expect(f.inspectRepository).not.toHaveBeenCalled();
  });
  it("reads destination metadata with source-only authority", async () => {
    const f = fixture();
    await expect(
      f.runtime.inspectDraftDestination?.({ githubSource: source, paths: [path] }),
    ).resolves.toEqual({
      installation: readInstallation,
      preTree: destination.preTree,
      repository,
    });
    expect(f.inspectRepository).toHaveBeenCalledWith({
      operation: "resolve-existing-source",
      ref: "refs/heads/main",
      repositoryId: "100",
    });
    expect(f.inspectInstallation).toHaveBeenCalledWith("resolve-existing-source");
  });

  it("seals the reviewed snapshot with fresh write proof without refreshing its head or preimages", async () => {
    const f = fixture();
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    expect(proposal).toMatchObject({
      baseSha: repository.headSha,
      baseTree: repository.headTree,
      changeSetDigest: review.changeSetDigest,
      installationIdentityDigest: installation("publish-draft-pull-request").digest,
      reviewDigest: review.digest,
    });
    expect(f.inspectRepository).not.toHaveBeenCalled();
    expect(f.inspectInstallation).toHaveBeenCalledWith("publish-draft-pull-request");
    expect(review.changes[0]?.before?.digest).toBe(before);
  });

  it("rejects a changed tenant installation instead of rebinding the reviewed destination", async () => {
    const f = fixture();
    f.inspectInstallation.mockResolvedValueOnce(installation("publish-draft-pull-request", "11"));
    await expect(
      f.runtime.sealDraftPullRequestProposal({
        destinationReview: destination,
        githubSource: source,
        review,
        source: sourceEvidence,
        title: "Update reviewed schema",
      }),
    ).rejects.toThrow("selected repository and publication installation");
    expect(f.save).not.toHaveBeenCalled();
  });
});
