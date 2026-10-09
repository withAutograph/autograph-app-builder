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
import { assertCompleteGitHubDestinationReview } from "./workflow-state";
import {
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  GITHUB_PUBLICATION_VERSION,
} from "../repository/github-publication";
import type {
  GitHubOperation,
  GitHubPublicationAdapter,
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
  const adapter: GitHubPublicationAdapter = {
    createPrivateFreshHistoryRepository: unexpected,
    inspectDestination: unexpected,
    inspectDestinationFiles,
    inspectDraftPublication: unexpected,
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
    receipts: { compareAndSet: vi.fn(), read: readReceipt },
  });
  return {
    inspectDestinationFiles,
    inspectInstallation,
    inspectRepository,
    readReceipt,
    runtime,
    save,
  };
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
    assertCompleteGitHubDestinationReview(bothRead, refreshed.changeSetDigest);
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
  it("retains a pending mutation journal and blocks replacing its unknown proposal", async () => {
    const f = fixture();
    const proposal = await f.runtime.sealDraftPullRequestProposal({
      destinationReview: destination,
      githubSource: source,
      review,
      source: sourceEvidence,
      title: "Update reviewed schema",
    });
    const pending = {
      approvedByCallId: "prior-approval",
      idempotencyKey: proposal.idempotencyKey,
      kind: "draft-pull-request" as const,
      proposalDigest: proposal.digest,
      status: "pending" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    const receipt = { ...pending, digest: hash(pending) };
    f.readReceipt.mockResolvedValue(receipt);
    f.inspectRepository.mockClear();
    await expect(
      f.runtime.inspectDraftDestination?.({
        existingProposal: proposal,
        githubSource: source,
        paths: [path],
      }),
    ).rejects.toThrow("unknown outcome");
    expect(f.inspectRepository).not.toHaveBeenCalled();
    expect(f.inspectDestinationFiles).not.toHaveBeenCalled();
    expect(receipt.status).toBe("pending");
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
