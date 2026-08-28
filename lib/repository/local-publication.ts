import { createHash } from "node:crypto";

import type { OverlayChange } from "./target-apply";
import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { SourceReceipt } from "./source-receipt";
import { safeSourcePath } from "./source-path";

export const LOCAL_PUBLICATION_VERSION = 2 as const;
export const LOCAL_PUBLICATION_MAX_FILE_BYTES = 4 * 1024 * 1024;
export const LOCAL_PUBLICATION_MAX_CHANGE_BYTES = 16 * 1024 * 1024;
export const LOCAL_PUBLICATION_MAX_DIRTY_BYTES = 8 * 1024 * 1024;
export const LOCAL_PUBLICATION_ALLOWED_MODES = ["644", "755"] as const;

export const stableDigest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

export const contentDigest = (value: Uint8Array): string =>
  createHash("sha256").update(value).digest("hex");

export type DirtyPathSnapshot = {
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
};

export type DestinationSnapshot = {
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
};

export type LocalPublicationProposal = {
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
};

export type PublicationPathEvidence = {
  path: string;
  operation: OverlayChange["kind"];
  before?: { mode: string; digest: string };
  after?: { mode: string; digest: string };
};

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
  approvedPaths: readonly string[],
): string {
  const unrelated = (path: string) =>
    !approvedPaths.some((approved) => pathsOverlap(path, approved));
  return stableDigest({
    dirty: destination.dirty.filter(
      (entry) =>
        unrelated(entry.path) &&
        (entry.originalPath === undefined || unrelated(entry.originalPath)),
    ),
    index: destination.index.filter((entry) => unrelated(entry.path)),
  });
}

function validMode(mode: string): boolean {
  return (LOCAL_PUBLICATION_ALLOWED_MODES as readonly string[]).includes(mode);
}

function canonicalChanges(
  review: ReviewedChangeSetReceipt,
): readonly OverlayChange[] {
  const paths = new Set<string>();
  for (const change of review.changes) {
    if (!safeSourcePath(change.path) || paths.has(change.path))
      throw new Error(
        "The reviewed change set contains an unsafe or duplicate path.",
      );
    paths.add(change.path);
    for (const file of [change.before, change.after]) {
      if (
        file !== undefined &&
        (!validMode(file.mode) || !/^[0-9a-f]{64}$/u.test(file.digest))
      )
        throw new Error(
          "The reviewed change set contains an unsupported file mode or digest.",
        );
    }
    if (
      (change.kind === "added" &&
        (change.before !== undefined || change.after === undefined)) ||
      (change.kind === "modified" &&
        (change.before === undefined || change.after === undefined)) ||
      (change.kind === "deleted" &&
        (change.before === undefined || change.after !== undefined))
    )
      throw new Error("The reviewed change set contains a malformed change.");
  }
  if (review.changes.length === 0)
    throw new Error("The reviewed change set is empty.");
  const sorted = [...review.changes].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (
    JSON.stringify(sorted.map(({ path }) => path)) !==
    JSON.stringify(review.approvedPaths)
  )
    throw new Error("The reviewed approved paths are not canonical.");
  return sorted;
}

/** Recomputes the normalized change-set digest and the outer review digest. */
export function assertExactReviewedChangeSet(
  review: ReviewedChangeSetReceipt,
): void {
  if (
    review.version !== 2 ||
    !safeSourcePath(review.appSpecPath) ||
    !/^[0-9a-f]{64}$/u.test(review.appSpecDigest)
  )
    throw new Error("A canonical V2 reviewed change set is required.");
  const changes = canonicalChanges(review);
  const changeSetUnsigned = {
    version: review.version,
    validationDigest: review.validationDigest,
    applyDigest: review.applyDigest,
    proposalDigest: review.proposalDigest,
    contractDigest: review.contractDigest,
    repositoryContractDigest: review.repositoryContractDigest,
    sourceSha: review.sourceSha,
    sourceTree: review.sourceTree,
    eligibilityDigest: review.eligibilityDigest,
    workspaceDigest: review.workspaceDigest,
    appSpecDigest: review.appSpecDigest,
    appSpecPath: review.appSpecPath,
    artifactRevision: review.artifactRevision,
    dependencyReceiptDigest: review.dependencyReceiptDigest,
    identityDigest: review.identityDigest,
    imageDigest: review.imageDigest,
    dependencyCacheDigest: review.dependencyCacheDigest,
    targetReceipt: review.targetReceipt,
    preTreeDigest: review.preTreeDigest,
    postTreeDigest: review.postTreeDigest,
    changedContentDigest: review.changedContentDigest,
    changes,
    approvedPaths: review.approvedPaths,
  };
  const changeSetDigest = stableDigest(changeSetUnsigned);
  if (review.changeSetDigest !== changeSetDigest)
    throw new Error("The reviewed change-set digest is malformed.");
  const outerUnsigned = {
    ...changeSetUnsigned,
    digest: changeSetDigest,
    changeSetDigest,
    reviewedByCallId: review.reviewedByCallId,
  };
  if (review.digest !== stableDigest(outerUnsigned))
    throw new Error(
      "The outer reviewed change-set receipt digest is malformed.",
    );
}

export function createLocalPublicationProposal(input: {
  sourceReceipt: SourceReceipt;
  destination: DestinationSnapshot;
  review: ReviewedChangeSetReceipt;
}): LocalPublicationProposal {
  assertExactReviewedChangeSet(input.review);
  const { sourceReceipt: source, destination, review } = input;
  if (source.sourceKind !== "existing-repository")
    throw new Error(
      "Local publication accepts only the original existing-repository source.",
    );
  if (
    destination.canonicalPath !== source.sourcePath ||
    destination.headSha !== source.sourceSha ||
    destination.headTree !== source.sourceTree ||
    destination.contractDigest !== source.contractDigest ||
    review.sourceSha !== source.sourceSha ||
    review.sourceTree !== source.sourceTree ||
    review.repositoryContractDigest !== source.contractDigest
  )
    throw new Error(
      "The destination is not the exact original reviewed source checkout.",
    );
  const overlap = destination.dirty.find((entry) =>
    review.approvedPaths.some(
      (path) =>
        pathsOverlap(path, entry.path) ||
        (entry.originalPath !== undefined &&
          pathsOverlap(path, entry.originalPath)),
    ),
  );
  if (overlap !== undefined)
    throw new Error(
      `The destination has dirty overlap with approved path ${overlap.path}.`,
    );
  const unsigned = {
    version: LOCAL_PUBLICATION_VERSION,
    destinationPath: destination.canonicalPath,
    rootIdentity: destination.rootIdentity,
    gitDirectoryPath: destination.gitDirectoryPath,
    gitDirectoryIdentity: destination.gitDirectoryIdentity,
    sourceReceiptDigest: source.digest,
    sourceTree: source.sourceTree,
    contractDigest: source.contractDigest,
    baseSha: source.sourceSha,
    headReference: destination.headReference,
    indexFileDigest: destination.indexFileDigest,
    remoteDigest: destination.remoteDigest,
    reviewDigest: review.digest,
    changeSetDigest: review.changeSetDigest,
    approvedPaths: review.approvedPaths,
    executionPaths: executionOrder(review.approvedPaths),
    changes: review.changes,
    intendedOutcome: "apply-reviewed-change-set-locally" as const,
    preconditionStatusDigest: destination.statusDigest,
    unrelatedProjectionDigest: unrelatedProjectionDigest(
      destination,
      review.approvedPaths,
    ),
  };
  return { ...unsigned, digest: stableDigest(unsigned) };
}

export function assertExactProposal(proposal: LocalPublicationProposal): void {
  if (proposal.version !== LOCAL_PUBLICATION_VERSION)
    throw new Error("A canonical V2 local-publication proposal is required.");
  if (proposal.digest !== stableDigest(canonicalProposal(proposal)))
    throw new Error("The local-publication proposal digest is malformed.");
  if (
    JSON.stringify(proposal.approvedPaths) !==
    JSON.stringify(proposal.changes.map(({ path }) => path))
  )
    throw new Error("The local-publication proposal paths are malformed.");
  if (
    JSON.stringify(proposal.executionPaths) !==
    JSON.stringify(executionOrder(proposal.approvedPaths))
  )
    throw new Error("The local-publication execution order is malformed.");
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
  right: LocalPublicationProposal,
): boolean {
  return (
    left.digest === right.digest &&
    JSON.stringify(canonicalProposal(left)) ===
      JSON.stringify(canonicalProposal(right))
  );
}

function canonicalProposal(proposal: LocalPublicationProposal) {
  return {
    version: proposal.version,
    destinationPath: proposal.destinationPath,
    rootIdentity: proposal.rootIdentity,
    gitDirectoryPath: proposal.gitDirectoryPath,
    gitDirectoryIdentity: proposal.gitDirectoryIdentity,
    sourceReceiptDigest: proposal.sourceReceiptDigest,
    sourceTree: proposal.sourceTree,
    contractDigest: proposal.contractDigest,
    baseSha: proposal.baseSha,
    headReference: proposal.headReference,
    indexFileDigest: proposal.indexFileDigest,
    remoteDigest: proposal.remoteDigest,
    reviewDigest: proposal.reviewDigest,
    changeSetDigest: proposal.changeSetDigest,
    approvedPaths: proposal.approvedPaths,
    executionPaths: proposal.executionPaths,
    changes: proposal.changes,
    intendedOutcome: proposal.intendedOutcome,
    preconditionStatusDigest: proposal.preconditionStatusDigest,
    unrelatedProjectionDigest: proposal.unrelatedProjectionDigest,
  };
}

export function proposalFromJournal(
  receipt: LocalPublicationJournal,
): LocalPublicationProposal {
  return {
    version: receipt.version,
    destinationPath: receipt.destinationPath,
    rootIdentity: receipt.rootIdentity,
    gitDirectoryPath: receipt.gitDirectoryPath,
    gitDirectoryIdentity: receipt.gitDirectoryIdentity,
    sourceReceiptDigest: receipt.sourceReceiptDigest,
    sourceTree: receipt.sourceTree,
    contractDigest: receipt.contractDigest,
    baseSha: receipt.baseSha,
    headReference: receipt.headReference,
    indexFileDigest: receipt.indexFileDigest,
    remoteDigest: receipt.remoteDigest,
    reviewDigest: receipt.reviewDigest,
    changeSetDigest: receipt.changeSetDigest,
    approvedPaths: receipt.approvedPaths,
    executionPaths: receipt.executionPaths,
    changes: receipt.changes,
    intendedOutcome: receipt.intendedOutcome,
    preconditionStatusDigest: receipt.preconditionStatusDigest,
    unrelatedProjectionDigest: receipt.unrelatedProjectionDigest,
    digest: receipt.proposalDigest,
  };
}

export function receiptDigest<T extends { digest?: string }>(
  receipt: T,
): string {
  const unsigned = Object.fromEntries(
    Object.entries(receipt).filter(([key]) => key !== "digest"),
  );
  return stableDigest(unsigned);
}

function exactPathEvidence(
  journal: LocalPublicationJournal,
): readonly PublicationPathEvidence[] {
  return journal.changes.map((change) => ({
    path: change.path,
    operation: change.kind,
    ...(change.before === undefined ? {} : { before: change.before }),
    ...(change.after === undefined ? {} : { after: change.after }),
  }));
}

const samePaths = (left: readonly string[], right: readonly string[]) =>
  JSON.stringify(left) === JSON.stringify(right);

function isOrderedUniqueSubset(
  paths: readonly string[],
  executionPaths: readonly string[],
): boolean {
  const positions = paths.map((path) => executionPaths.indexOf(path));
  return (
    positions.every((position) => position >= 0) &&
    new Set(paths).size === paths.length &&
    positions.every(
      (position, index) => index === 0 || position > positions[index - 1]!,
    )
  );
}

/** Rejects digest-valid but semantically forged journal/terminal receipts. */
export function assertCanonicalLocalPublicationJournal(
  journal: LocalPublicationJournal,
): void {
  assertExactProposal(proposalFromJournal(journal));
  if (receiptDigest(journal) !== journal.digest)
    throw new Error(
      "The durable local-publication journal digest is malformed.",
    );
  if (
    !isOrderedUniqueSubset(journal.appliedPaths, journal.executionPaths) ||
    JSON.stringify(journal.pathEvidence) !==
      JSON.stringify(exactPathEvidence(journal))
  )
    throw new Error("The durable local-publication intent is not canonical.");

  if (journal.status === "pending") {
    if (
      !samePaths(journal.intentPaths, journal.executionPaths) ||
      !(
        journal.appliedPaths.length === 0 ||
        samePaths(journal.appliedPaths, journal.executionPaths)
      )
    )
      throw new Error(
        "The pending local-publication evidence is not canonical.",
      );
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
          })),
        )
    )
      throw new Error(
        "The successful local-publication receipt is not canonical.",
      );
    return;
  }

  if (
    !isOrderedUniqueSubset(journal.rolledBackPaths, journal.executionPaths) ||
    !isOrderedUniqueSubset(journal.conflictedPaths, journal.executionPaths) ||
    !isOrderedUniqueSubset(journal.uncertainPaths, journal.executionPaths)
  )
    throw new Error("The failed local-publication receipt is not canonical.");
  if (
    journal.reason !== "precondition-failed" &&
    journal.reason !== "mutation-failed" &&
    journal.reason !== "rollback-conflict"
  )
    throw new Error("The failed local-publication receipt is not canonical.");
  const applied = new Set(journal.appliedPaths);
  const accounted = [...journal.rolledBackPaths, ...journal.conflictedPaths];
  const canonicalPartition =
    new Set(accounted).size === accounted.length &&
    samePaths(
      accounted.filter((path) => applied.has(path)).sort(),
      [...journal.appliedPaths].sort(),
    );
  if (journal.reason === "precondition-failed") {
    if (
      journal.intentPaths.length !== 0 ||
      journal.appliedPaths.length !== 0 ||
      journal.rolledBackPaths.length !== 0 ||
      journal.conflictedPaths.length !== 0 ||
      journal.uncertainPaths.length !== 0 ||
      journal.recoveryRequired
    )
      throw new Error("The failed local-publication receipt is not canonical.");
    return;
  }
  if (!samePaths(journal.intentPaths, journal.executionPaths))
    throw new Error("The failed local-publication receipt is not canonical.");
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
        journal.conflictedPaths.includes(path),
    ) ||
    !canonicalPartition ||
    journal.recoveryRequired !== expectedRecovery ||
    journal.reason !==
      (expectedRecovery ? "rollback-conflict" : "mutation-failed")
  )
    throw new Error("The failed local-publication receipt is not canonical.");
}

/** Requires published workflow authority to have the exact durable success. */
export function assertExactDurablePublicationSuccess(
  workflowReceipt: LocalPublicationSuccessReceipt,
  durable: LocalPublicationJournal | undefined,
): asserts durable is LocalPublicationSuccessReceipt {
  assertCanonicalLocalPublicationJournal(workflowReceipt);
  if (durable?.status !== "succeeded")
    throw new Error(
      "The published local workflow does not have its durable success journal.",
    );
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
      proposalFromJournal(workflowReceipt),
    )
  )
    throw new Error(
      "The published local workflow does not exactly match its durable success journal.",
    );
}
