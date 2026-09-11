import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import { safeSourcePath } from "./source-path";
import type { SourceReceipt } from "./source-receipt";
import { assertRepositoryReleasePolicyAtGitSnapshot } from "./supported-template";
import { compareOverlayPaths } from "./target-apply";
import type { OverlayChange } from "./target-apply";

export const LOCAL_PUBLICATION_VERSION = 2 as const;
export const LOCAL_PUBLICATION_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const LOCAL_PUBLICATION_MAX_CHANGE_BYTES = 16 * 1024 * 1024;
export const LOCAL_PUBLICATION_MAX_DIRTY_BYTES = 8 * 1024 * 1024;
export const LOCAL_PUBLICATION_ALLOWED_MODES = ["644", "755"] as const;

export const stableDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const contentDigest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export interface DirtyPathSnapshot {
  path: string;
  originalPath?: string;
  indexStatus: string;
  worktreeStatus: string;
  indexMode?: string;
  indexObjectId?: string;
  kind: "absent" | "regular" | "directory" | "symlink" | "special";
  mode?: string;
  size?: number;
  contentDigest?: string;
  contentBase64?: string;
}

export interface DestinationSnapshot {
  canonicalPath: string;
  rootIdentity: { device: string; inode: string };
  gitDirectoryPath: string;
  gitDirectoryIdentity: { device: string; inode: string };
  headSha: string;
  headTree: string;
  headReference: string;
  indexFileDigest: string;
  remoteDigest: string;
  contractDigest: string;
  dirty: readonly DirtyPathSnapshot[];
  index: readonly { path: string; entriesBase64: string; digest: string }[];
  dirtyDigest: string;
  statusDigest: string;
}

export interface LocalPublicationProposal {
  version: typeof LOCAL_PUBLICATION_VERSION;
  destinationPath: string;
  rootIdentity: { device: string; inode: string };
  gitDirectoryPath: string;
  gitDirectoryIdentity: { device: string; inode: string };
  sourceReceiptDigest: string;
  sourceTree: string;
  contractDigest: string;
  baseSha: string;
  headReference: string;
  indexFileDigest: string;
  remoteDigest: string;
  reviewDigest: string;
  changeSetDigest: string;
  approvedPaths: readonly string[];
  executionPaths: readonly string[];
  changes: readonly OverlayChange[];
  intendedOutcome: "apply-reviewed-change-set-locally";
  preconditionStatusDigest: string;
  unrelatedProjectionDigest: string;
  digest: string;
}

export interface PublicationPathEvidence {
  path: string;
  operation: OverlayChange["kind"];
  before?: { mode: string; digest: string };
  after?: { mode: string; digest: string };
}

type LocalPublicationTerminal = Omit<LocalPublicationProposal, "digest"> & {
  proposalDigest: string;
  publishedByCallId: string;
  beforeStatusDigest: string;
  afterStatusDigest: string;
  appliedPaths: readonly string[];
  intentPaths: readonly string[];
  rolledBackPaths: readonly string[];
  conflictedPaths: readonly string[];
  uncertainPaths: readonly string[];
  pathEvidence: readonly PublicationPathEvidence[];
  recoveryRequired: boolean;
};

export type LocalPublicationSuccessReceipt = LocalPublicationTerminal & {
  status: "succeeded";
  postconditionDigest: string;
  digest: string;
};

export type LocalPublicationFailureReceipt = LocalPublicationTerminal & {
  status: "failed";
  reason: "precondition-failed" | "mutation-failed" | "rollback-conflict";
  failureMessage: string;
  digest: string;
};

export type LocalPublicationPendingReceipt = Omit<
  LocalPublicationProposal,
  "digest"
> & {
  proposalDigest: string;
  status: "pending";
  publishedByCallId: string;
  beforeStatusDigest: string;
  appliedPaths: readonly string[];
  intentPaths: readonly string[];
  pathEvidence: readonly PublicationPathEvidence[];
  digest: string;
};

export type LocalPublicationJournal =
  | LocalPublicationPendingReceipt
  | LocalPublicationSuccessReceipt
  | LocalPublicationFailureReceipt;
export type LocalPublicationResult =
  | { ok: true; receipt: LocalPublicationSuccessReceipt }
  | { ok: false; receipt: LocalPublicationFailureReceipt };

export function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

export function unrelatedProjectionDigest(
  destination: DestinationSnapshot,
  approvedPaths: readonly string[]
): string {
  const unrelated = (path: string) =>
    !approvedPaths.some((approved) => pathsOverlap(path, approved));
  return stableDigest({
    dirty: destination.dirty.filter(
      (entry) =>
        unrelated(entry.path) &&
        (entry.originalPath === undefined || unrelated(entry.originalPath))
    ),
    index: destination.index.filter((entry) => unrelated(entry.path)),
  });
}

function validMode(mode: string): boolean {
  return (LOCAL_PUBLICATION_ALLOWED_MODES as readonly string[]).includes(mode);
}

function canonicalChanges(
  review: ReviewedChangeSetReceipt
): readonly OverlayChange[] {
  const paths = new Set<string>();
  for (const change of review.changes) {
    if (!safeSourcePath(change.path) || paths.has(change.path)) {
      throw new Error(
        "The reviewed change set contains an unsafe or duplicate path."
      );
    }
    paths.add(change.path);
    for (const file of [change.before, change.after]) {
      if (
        file !== undefined &&
        (!validMode(file.mode) || !/^[0-9a-f]{64}$/u.test(file.digest))
      ) {
        throw new Error(
          "The reviewed change set contains an unsupported file mode or digest."
        );
      }
    }
    if (
      (change.kind === "added" &&
        (change.before !== undefined || change.after === undefined)) ||
      (change.kind === "modified" &&
        (change.before === undefined || change.after === undefined)) ||
      (change.kind === "deleted" &&
        (change.before === undefined || change.after !== undefined))
    ) {
      throw new Error("The reviewed change set contains a malformed change.");
    }
  }
  if (review.changes.length === 0) {
    throw new Error("The reviewed change set is empty.");
  }
  const sorted = [...review.changes].toSorted((left, right) =>
    compareOverlayPaths(left.path, right.path)
  );
  if (
    JSON.stringify(sorted.map(({ path }) => path)) !==
    JSON.stringify(review.approvedPaths)
  ) {
    throw new Error("The reviewed approved paths are not canonical.");
  }
  return sorted;
}

/** Recomputes the normalized change-set digest and the outer review digest. */
export function assertExactReviewedChangeSet(
  review: ReviewedChangeSetReceipt
): void {
  if (
    review.version !== 2 ||
    !safeSourcePath(review.appSpecPath) ||
    !/^[0-9a-f]{64}$/u.test(review.appSpecDigest)
  ) {
    throw new Error("A canonical V2 reviewed change set is required.");
  }
  const changes = canonicalChanges(review);
  const changeSetUnsigned = {
    appSpecDigest: review.appSpecDigest,
    appSpecPath: review.appSpecPath,
    applyDigest: review.applyDigest,
    approvedPaths: review.approvedPaths,
    artifactRevision: review.artifactRevision,
    changedContentDigest: review.changedContentDigest,
    changes,
    contractDigest: review.contractDigest,
    dependencyCacheContentDigest: review.dependencyCacheContentDigest,
    dependencyCacheDigest: review.dependencyCacheDigest,
    dependencyReceiptDigest: review.dependencyReceiptDigest,
    eligibilityDigest: review.eligibilityDigest,
    identityDigest: review.identityDigest,
    imageDigest: review.imageDigest,
    postTreeDigest: review.postTreeDigest,
    preTreeDigest: review.preTreeDigest,
    proposalDigest: review.proposalDigest,
    repositoryContractDigest: review.repositoryContractDigest,
    sourceReceiptDigest: review.sourceReceiptDigest,
    sourceSha: review.sourceSha,
    sourceTree: review.sourceTree,
    targetReceipt: review.targetReceipt,
    validationDigest: review.validationDigest,
    version: review.version,
    workspaceDigest: review.workspaceDigest,
  };
  const changeSetDigest = stableDigest(changeSetUnsigned);
  if (review.changeSetDigest !== changeSetDigest) {
    throw new Error("The reviewed change-set digest is malformed.");
  }
  const outerUnsigned = {
    ...changeSetUnsigned,
    changeSetDigest,
    digest: changeSetDigest,
    reviewedByCallId: review.reviewedByCallId,
  };
  if (review.digest !== stableDigest(outerUnsigned)) {
    throw new Error(
      "The outer reviewed change-set receipt digest is malformed."
    );
  }
}

export function createLocalPublicationProposal(input: {
  sourceReceipt: SourceReceipt;
  destination: DestinationSnapshot;
  review: ReviewedChangeSetReceipt;
}): LocalPublicationProposal {
  assertExactReviewedChangeSet(input.review);
  const { sourceReceipt: source, destination, review } = input;
  if (source.sourceKind !== "existing-repository") {
    throw new Error(
      "Local publication accepts only the original existing-repository source."
    );
  }
  assertRepositoryReleasePolicyAtGitSnapshot({
    sourcePath: source.sourcePath,
    sourceSha: source.sourceSha,
    sourceTree: source.sourceTree,
  });
  if (
    destination.canonicalPath !== source.sourcePath ||
    destination.headSha !== source.sourceSha ||
    destination.headTree !== source.sourceTree ||
    destination.contractDigest !== source.contractDigest ||
    review.sourceSha !== source.sourceSha ||
    review.sourceTree !== source.sourceTree ||
    review.repositoryContractDigest !== source.contractDigest
  ) {
    throw new Error(
      "The destination is not the exact original reviewed source checkout."
    );
  }
  const overlap = destination.dirty.find((entry) =>
    review.approvedPaths.some(
      (path) =>
        pathsOverlap(path, entry.path) ||
        (entry.originalPath !== undefined &&
          pathsOverlap(path, entry.originalPath))
    )
  );
  if (overlap !== undefined) {
    throw new Error(
      `The destination has dirty overlap with approved path ${overlap.path}.`
    );
  }
  const unsigned = {
    approvedPaths: review.approvedPaths,
    baseSha: source.sourceSha,
    changeSetDigest: review.changeSetDigest,
    changes: review.changes,
    contractDigest: source.contractDigest,
    destinationPath: destination.canonicalPath,
    executionPaths: executionOrder(review.approvedPaths),
    gitDirectoryIdentity: destination.gitDirectoryIdentity,
    gitDirectoryPath: destination.gitDirectoryPath,
    headReference: destination.headReference,
    indexFileDigest: destination.indexFileDigest,
    intendedOutcome: "apply-reviewed-change-set-locally" as const,
    preconditionStatusDigest: destination.statusDigest,
    remoteDigest: destination.remoteDigest,
    reviewDigest: review.digest,
    rootIdentity: destination.rootIdentity,
    sourceReceiptDigest: source.digest,
    sourceTree: source.sourceTree,
    unrelatedProjectionDigest: unrelatedProjectionDigest(
      destination,
      review.approvedPaths
    ),
    version: LOCAL_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: stableDigest(unsigned) };
}

export function assertExactProposal(proposal: LocalPublicationProposal): void {
  if (proposal.version !== LOCAL_PUBLICATION_VERSION) {
    throw new Error("A canonical V2 local-publication proposal is required.");
  }
  if (proposal.digest !== stableDigest(canonicalProposal(proposal))) {
    throw new Error("The local-publication proposal digest is malformed.");
  }
  if (
    JSON.stringify(proposal.approvedPaths) !==
    JSON.stringify(proposal.changes.map(({ path }) => path))
  ) {
    throw new Error("The local-publication proposal paths are malformed.");
  }
  if (
    JSON.stringify(proposal.executionPaths) !==
    JSON.stringify(executionOrder(proposal.approvedPaths))
  ) {
    throw new Error("The local-publication execution order is malformed.");
  }
}

const topologyPath = "microfrontends.json";

export function executionOrder(paths: readonly string[]): readonly string[] {
  return [
    ...paths.filter((path) => path !== topologyPath),
    ...paths.filter((path) => path === topologyPath),
  ];
}

export function exactProposalMatch(
  left: LocalPublicationProposal,
  right: LocalPublicationProposal
): boolean {
  return (
    left.digest === right.digest &&
    JSON.stringify(canonicalProposal(left)) ===
      JSON.stringify(canonicalProposal(right))
  );
}

function canonicalProposal(proposal: LocalPublicationProposal) {
  return {
    approvedPaths: proposal.approvedPaths,
    baseSha: proposal.baseSha,
    changeSetDigest: proposal.changeSetDigest,
    changes: proposal.changes,
    contractDigest: proposal.contractDigest,
    destinationPath: proposal.destinationPath,
    executionPaths: proposal.executionPaths,
    gitDirectoryIdentity: proposal.gitDirectoryIdentity,
    gitDirectoryPath: proposal.gitDirectoryPath,
    headReference: proposal.headReference,
    indexFileDigest: proposal.indexFileDigest,
    intendedOutcome: proposal.intendedOutcome,
    preconditionStatusDigest: proposal.preconditionStatusDigest,
    remoteDigest: proposal.remoteDigest,
    reviewDigest: proposal.reviewDigest,
    rootIdentity: proposal.rootIdentity,
    sourceReceiptDigest: proposal.sourceReceiptDigest,
    sourceTree: proposal.sourceTree,
    unrelatedProjectionDigest: proposal.unrelatedProjectionDigest,
    version: proposal.version,
  };
}

export function proposalFromJournal(
  receipt: LocalPublicationJournal
): LocalPublicationProposal {
  return {
    approvedPaths: receipt.approvedPaths,
    baseSha: receipt.baseSha,
    changeSetDigest: receipt.changeSetDigest,
    changes: receipt.changes,
    contractDigest: receipt.contractDigest,
    destinationPath: receipt.destinationPath,
    digest: receipt.proposalDigest,
    executionPaths: receipt.executionPaths,
    gitDirectoryIdentity: receipt.gitDirectoryIdentity,
    gitDirectoryPath: receipt.gitDirectoryPath,
    headReference: receipt.headReference,
    indexFileDigest: receipt.indexFileDigest,
    intendedOutcome: receipt.intendedOutcome,
    preconditionStatusDigest: receipt.preconditionStatusDigest,
    remoteDigest: receipt.remoteDigest,
    reviewDigest: receipt.reviewDigest,
    rootIdentity: receipt.rootIdentity,
    sourceReceiptDigest: receipt.sourceReceiptDigest,
    sourceTree: receipt.sourceTree,
    unrelatedProjectionDigest: receipt.unrelatedProjectionDigest,
    version: receipt.version,
  };
}

export function receiptDigest<T extends { digest?: string }>(
  receipt: T
): string {
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "digest")
  );
  return stableDigest(unsigned);
}

function exactPathEvidence(
  journal: LocalPublicationJournal
): readonly PublicationPathEvidence[] {
  return journal.changes.map((change) => ({
    operation: change.kind,
    path: change.path,
    ...(change.before === undefined ? {} : { before: change.before }),
    ...(change.after === undefined ? {} : { after: change.after }),
  }));
}

const samePaths = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify(left) === JSON.stringify(right);

function isOrderedUniqueSubset(
  paths: readonly string[],
  executionPaths: readonly string[]
): boolean {
  const positions = paths.map((path) => executionPaths.indexOf(path));
  return (
    positions.every((position) => position >= 0) &&
    new Set(paths).size === paths.length &&
    positions.every(
      (position, index) => index === 0 || position > positions[index - 1]!
    )
  );
}

/** Rejects digest-valid but semantically forged journal/terminal receipts. */
export function assertCanonicalLocalPublicationJournal(
  journal: LocalPublicationJournal
): void {
  assertExactProposal(proposalFromJournal(journal));
  if (receiptDigest(journal) !== journal.digest) {
    throw new Error(
      "The durable local-publication journal digest is malformed."
    );
  }
  if (
    !isOrderedUniqueSubset(journal.appliedPaths, journal.executionPaths) ||
    JSON.stringify(journal.pathEvidence) !==
      JSON.stringify(exactPathEvidence(journal))
  ) {
    throw new Error("The durable local-publication intent is not canonical.");
  }

  if (journal.status === "pending") {
    if (
      !samePaths(journal.intentPaths, journal.executionPaths) ||
      !(
        journal.appliedPaths.length === 0 ||
        samePaths(journal.appliedPaths, journal.executionPaths)
      )
    ) {
      throw new Error(
        "The pending local-publication evidence is not canonical."
      );
    }
    return;
  }

  if (journal.status === "succeeded") {
    if (
      !samePaths(journal.intentPaths, journal.executionPaths) ||
      !samePaths(journal.appliedPaths, journal.executionPaths) ||
      journal.rolledBackPaths.length !== 0 ||
      journal.conflictedPaths.length !== 0 ||
      journal.uncertainPaths.length !== 0 ||
      journal.recoveryRequired ||
      journal.postconditionDigest !==
        stableDigest(
          journal.pathEvidence.map(({ path, after: postimage }) => ({
            path,
            postimage,
          }))
        )
    ) {
      throw new Error(
        "The successful local-publication receipt is not canonical."
      );
    }
    return;
  }

  if (
    !isOrderedUniqueSubset(journal.rolledBackPaths, journal.executionPaths) ||
    !isOrderedUniqueSubset(journal.conflictedPaths, journal.executionPaths) ||
    !isOrderedUniqueSubset(journal.uncertainPaths, journal.executionPaths)
  ) {
    throw new Error("The failed local-publication receipt is not canonical.");
  }
  if (
    journal.reason !== "precondition-failed" &&
    journal.reason !== "mutation-failed" &&
    journal.reason !== "rollback-conflict"
  ) {
    throw new Error("The failed local-publication receipt is not canonical.");
  }
  const applied = new Set(journal.appliedPaths);
  const accounted = [...journal.rolledBackPaths, ...journal.conflictedPaths];
  const canonicalPartition =
    new Set(accounted).size === accounted.length &&
    samePaths(
      accounted.filter((path) => applied.has(path)).sort(compareOverlayPaths),
      [...journal.appliedPaths].sort(compareOverlayPaths)
    );
  if (journal.reason === "precondition-failed") {
    if (
      journal.intentPaths.length !== 0 ||
      journal.appliedPaths.length !== 0 ||
      journal.rolledBackPaths.length !== 0 ||
      journal.conflictedPaths.length !== 0 ||
      journal.uncertainPaths.length !== 0 ||
      journal.recoveryRequired
    ) {
      throw new Error("The failed local-publication receipt is not canonical.");
    }
    return;
  }
  if (!samePaths(journal.intentPaths, journal.executionPaths)) {
    throw new Error("The failed local-publication receipt is not canonical.");
  }
  const uncertain = new Set(journal.uncertainPaths);
  const expectedRecovery =
    journal.conflictedPaths.length > 0 || journal.uncertainPaths.length > 0;
  if (
    journal.rolledBackPaths.some((path) => !applied.has(path)) ||
    journal.conflictedPaths.some((path) => !applied.has(path)) ||
    journal.uncertainPaths.some((path) => applied.has(path)) ||
    [...uncertain].some(
      (path) =>
        journal.rolledBackPaths.includes(path) ||
        journal.conflictedPaths.includes(path)
    ) ||
    !canonicalPartition ||
    journal.recoveryRequired !== expectedRecovery ||
    journal.reason !==
      (expectedRecovery ? "rollback-conflict" : "mutation-failed")
  ) {
    throw new Error("The failed local-publication receipt is not canonical.");
  }
}

/** Requires published workflow authority to have the exact durable success. */
export function assertExactDurablePublicationSuccess(
  workflowReceipt: LocalPublicationSuccessReceipt,
  durable: LocalPublicationJournal | undefined
): asserts durable is LocalPublicationSuccessReceipt {
  assertCanonicalLocalPublicationJournal(workflowReceipt);
  if (durable?.status !== "succeeded") {
    throw new Error(
      "The published local workflow does not have its durable success journal."
    );
  }
  assertCanonicalLocalPublicationJournal(durable);
  if (
    durable.digest !== workflowReceipt.digest ||
    durable.proposalDigest !== workflowReceipt.proposalDigest ||
    durable.publishedByCallId !== workflowReceipt.publishedByCallId ||
    durable.sourceReceiptDigest !== workflowReceipt.sourceReceiptDigest ||
    durable.reviewDigest !== workflowReceipt.reviewDigest ||
    durable.destinationPath !== workflowReceipt.destinationPath ||
    durable.postconditionDigest !== workflowReceipt.postconditionDigest ||
    !exactProposalMatch(
      proposalFromJournal(durable),
      proposalFromJournal(workflowReceipt)
    )
  ) {
    throw new Error(
      "The published local workflow does not exactly match its durable success journal."
    );
  }
}
