import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { DestinationSnapshot } from "./local-publication";
import {
  assertExactReviewedChangeSet,
  pathsOverlap,
  stableDigest,
} from "./local-publication";
import type { SourceReceipt } from "./source-receipt";

export const BRANCH_WORKTREE_PUBLICATION_VERSION = 2 as const;

export type BranchWorktreePublicationProposal = {
  version: typeof BRANCH_WORKTREE_PUBLICATION_VERSION;
  sourcePath: string;
  sourceRootIdentity: { device: string; inode: string };
  sourceGitDirectoryPath: string;
  sourceGitDirectoryIdentity: { device: string; inode: string };
  publicationRootPath: string;
  publicationRootIdentity: { device: string; inode: string };
  sourceReceiptDigest: string;
  sourceTree: string;
  contractDigest: string;
  baseSha: string;
  sourceHeadReference: string;
  sourceIndexFileDigest: string;
  sourceRemoteDigest: string;
  sourceStatusDigest: string;
  reviewDigest: string;
  changeSetDigest: string;
  approvedPaths: readonly string[];
  changes: ReviewedChangeSetReceipt["changes"];
  branchName: string;
  worktreePath: string;
  publicationIdentityDigest: string;
  intendedOutcome: "create-reviewed-branch-worktree";
  digest: string;
};

type TerminalFields = Omit<BranchWorktreePublicationProposal, "digest"> & {
  proposalDigest: string;
  publishedByCallId: string;
  recoveryOfDigest?: string;
  branchCreated: boolean;
  worktreeCreated: boolean;
  appliedPaths: readonly string[];
};

export type BranchWorktreePublicationPendingReceipt = Omit<
  BranchWorktreePublicationProposal,
  "digest"
> & {
  proposalDigest: string;
  status: "pending";
  publishedByCallId: string;
  recoveryOfDigest?: string;
  digest: string;
};

export type BranchWorktreePublicationSuccessReceipt = TerminalFields & {
  status: "succeeded";
  worktreeRootIdentity: { device: string; inode: string };
  worktreeGitDirectoryPath: string;
  worktreeGitDirectoryIdentity: { device: string; inode: string };
  worktreeHeadReference: string;
  worktreeIndexFileDigest: string;
  worktreeRemoteDigest: string;
  worktreeStatusDigest: string;
  postconditionDigest: string;
  recoveryRequired: false;
  digest: string;
};

export type BranchWorktreePublicationFailureReceipt = TerminalFields & {
  status: "failed";
  reason:
    | "precondition-failed"
    | "collision"
    | "creation-partial"
    | "apply-partial"
    | "recovery-conflict";
  failureMessage: string;
  recoveryRequired: true;
  digest: string;
};

export type BranchWorktreePublicationJournal =
  | BranchWorktreePublicationPendingReceipt
  | BranchWorktreePublicationSuccessReceipt
  | BranchWorktreePublicationFailureReceipt;

function canonicalProposal(proposal: BranchWorktreePublicationProposal) {
  const unsigned = {
    ...proposal,
  } as Partial<BranchWorktreePublicationProposal>;
  delete unsigned.digest;
  return unsigned;
}

export function branchPublicationIdentity(input: {
  sourceReceiptDigest: string;
  reviewDigest: string;
}): string {
  return stableDigest(input);
}

export function branchNameForIdentity(identity: string): string {
  return `app-builder/review-${identity}`;
}

export function createBranchWorktreePublicationProposal(input: {
  sourceReceipt: SourceReceipt;
  source: DestinationSnapshot;
  review: ReviewedChangeSetReceipt;
  worktreePath: string;
  publicationRootPath: string;
  publicationRootIdentity: { device: string; inode: string };
}): BranchWorktreePublicationProposal {
  assertExactReviewedChangeSet(input.review);
  const { sourceReceipt, source, review } = input;
  if (sourceReceipt.sourceKind !== "existing-repository")
    throw new Error(
      "Branch-worktree publication accepts only an existing-repository source.",
    );
  if (
    source.canonicalPath !== sourceReceipt.sourcePath ||
    source.headSha !== sourceReceipt.sourceSha ||
    source.headTree !== sourceReceipt.sourceTree ||
    source.contractDigest !== sourceReceipt.contractDigest ||
    review.sourceSha !== sourceReceipt.sourceSha ||
    review.repositoryContractDigest !== sourceReceipt.contractDigest
  )
    throw new Error(
      "The source checkout is not the exact reviewed existing repository.",
    );
  const overlap = source.dirty.find((entry) =>
    review.approvedPaths.some(
      (path) =>
        pathsOverlap(path, entry.path) ||
        (entry.originalPath !== undefined &&
          pathsOverlap(path, entry.originalPath)),
    ),
  );
  if (overlap !== undefined)
    throw new Error(
      `The source has dirty overlap with approved path ${overlap.path}.`,
    );
  const publicationIdentityDigest = branchPublicationIdentity({
    sourceReceiptDigest: sourceReceipt.digest,
    reviewDigest: review.digest,
  });
  const unsigned = {
    version: BRANCH_WORKTREE_PUBLICATION_VERSION,
    sourcePath: source.canonicalPath,
    sourceRootIdentity: source.rootIdentity,
    sourceGitDirectoryPath: source.gitDirectoryPath,
    sourceGitDirectoryIdentity: source.gitDirectoryIdentity,
    publicationRootPath: input.publicationRootPath,
    publicationRootIdentity: input.publicationRootIdentity,
    sourceReceiptDigest: sourceReceipt.digest,
    sourceTree: sourceReceipt.sourceTree,
    contractDigest: sourceReceipt.contractDigest,
    baseSha: sourceReceipt.sourceSha,
    sourceHeadReference: source.headReference,
    sourceIndexFileDigest: source.indexFileDigest,
    sourceRemoteDigest: source.remoteDigest,
    sourceStatusDigest: source.statusDigest,
    reviewDigest: review.digest,
    changeSetDigest: review.changeSetDigest,
    approvedPaths: review.approvedPaths,
    changes: review.changes,
    branchName: branchNameForIdentity(publicationIdentityDigest),
    worktreePath: input.worktreePath,
    publicationIdentityDigest,
    intendedOutcome: "create-reviewed-branch-worktree" as const,
  };
  return { ...unsigned, digest: stableDigest(unsigned) };
}

export function assertExactBranchWorktreeProposal(
  proposal: BranchWorktreePublicationProposal,
): void {
  if (proposal.version !== BRANCH_WORKTREE_PUBLICATION_VERSION)
    throw new Error(
      "A canonical V2 branch-worktree publication proposal is required.",
    );
  if (proposal.digest !== stableDigest(canonicalProposal(proposal)))
    throw new Error("The branch-worktree publication digest is malformed.");
  const identity = branchPublicationIdentity({
    sourceReceiptDigest: proposal.sourceReceiptDigest,
    reviewDigest: proposal.reviewDigest,
  });
  if (
    proposal.publicationIdentityDigest !== identity ||
    proposal.branchName !== branchNameForIdentity(identity)
  )
    throw new Error("The branch-worktree publication identity is malformed.");
  if (
    JSON.stringify(proposal.approvedPaths) !==
    JSON.stringify(proposal.changes.map(({ path }) => path))
  )
    throw new Error("The branch-worktree publication paths are malformed.");
}

export function proposalFromBranchJournal(
  journal: BranchWorktreePublicationJournal,
): BranchWorktreePublicationProposal {
  const proposalOnly = { ...journal } as Record<string, unknown>;
  const proposalDigest = journal.proposalDigest;
  for (const key of [
    "proposalDigest",
    "status",
    "publishedByCallId",
    "recoveryOfDigest",
    "digest",
    "branchCreated",
    "worktreeCreated",
    "appliedPaths",
    "worktreeRootIdentity",
    "worktreeGitDirectoryPath",
    "worktreeGitDirectoryIdentity",
    "worktreeHeadReference",
    "worktreeIndexFileDigest",
    "worktreeRemoteDigest",
    "worktreeStatusDigest",
    "postconditionDigest",
    "recoveryRequired",
    "reason",
    "failureMessage",
  ])
    delete proposalOnly[key];
  return {
    ...(proposalOnly as Omit<BranchWorktreePublicationProposal, "digest">),
    digest: proposalDigest,
  };
}

export function branchJournalDigest(
  journal: Omit<BranchWorktreePublicationJournal, "digest">,
): string {
  return createHash("sha256").update(JSON.stringify(journal)).digest("hex");
}

export function assertCanonicalBranchWorktreeJournal(
  journal: BranchWorktreePublicationJournal,
): void {
  const { digest, ...unsigned } = journal;
  if (digest !== branchJournalDigest(unsigned))
    throw new Error("The branch-worktree publication journal is malformed.");
  assertExactBranchWorktreeProposal(proposalFromBranchJournal(journal));
}

export function exactBranchWorktreeProposalMatch(
  left: BranchWorktreePublicationProposal,
  right: BranchWorktreePublicationProposal,
): boolean {
  return (
    left.digest === right.digest &&
    JSON.stringify(canonicalProposal(left)) ===
      JSON.stringify(canonicalProposal(right))
  );
}
