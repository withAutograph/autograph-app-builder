import type { GitHubPrDeliveryProvider } from "./github-pr-delivery";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import {
  assertPublishedDraftRepairReview,
  isPublishedDraftRepairReview,
} from "./published-draft-repair-review";
import type { DraftUpdateReview } from "./published-draft-repair-review";
import { parseSourceReceiptEvidence } from "./source-receipt";
import type { SourceReceiptEvidence } from "./source-receipt";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";
import type { OverlayFile } from "./target-apply";
import { githubPermissionsFor } from "./github-permissions";
import type { GitHubOperation, GitHubPermissions } from "./github-permissions";
import { parseGitHubTargetAccessProof } from "./github-target-access-proof";
import type { GitHubTargetAccessProof } from "./github-target-access-proof";
import type { z } from "zod";
import type { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { ExistingDraftObservation, ExistingDraftUpdateProposal } from "./github-draft-update";
import type {
  ExistingDraftInspectionRequest,
  OwnedDraftInspectionRecovery,
  ExistingDraftReconciliationProposal,
  ReconciliationContent,
} from "./github-draft-reconciliation";
import type {
  HistoricalAppSourceObservation,
  HistoricalAppSourceSelector,
} from "./historical-app-source";

export const GITHUB_PUBLICATION_VERSION = 2 as const;
export const REPOSITORY_RELEASE_GATE = "REPOSITORY_RELEASE_ENABLED" as const;

export type GitHubRepositorySelection = "all" | "selected";
export { githubPermissionsFor } from "./github-permissions";
export type { GitHubOperation } from "./github-permissions";

export interface GitHubInstallationIdentity {
  version: typeof GITHUB_PUBLICATION_VERSION;
  operation: GitHubOperation;
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: GitHubRepositorySelection;
  selectedRepositoryIds: readonly string[];
  permissions: GitHubPermissions;
  digest: string;
}

export interface GitHubRepositoryObservation {
  version: typeof GITHUB_PUBLICATION_VERSION;
  repositoryId: string;
  owner: string;
  name: string;
  visibility: "private";
  defaultBranch: string;
  headSha: string;
  headTree: string;
  installationIdentityDigest: string;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: boolean;
  };
  digest: string;
}

export interface ImmutableGitHubSourceReceipt {
  version: typeof GITHUB_PUBLICATION_VERSION;
  repository: GitHubRepositoryObservation;
  resolvedRef: string;
  resolvedSha: string;
  resolvedTree: string;
  installationIdentityDigest: string;
  resolvedByCallId: string;
  digest: string;
}

export interface FreshRepositoryProposal {
  version: typeof GITHUB_PUBLICATION_VERSION;
  installationIdentityDigest: string;
  destinationOwner: string;
  destinationName: string;
  visibility: "private";
  defaultBranch: "main";
  sourceReceiptDigest: string;
  sourceSha: string;
  sourceTree: string;
  contractDigest: string;
  eligibilityDigest: string;
  reviewDigest: string;
  changeSetDigest: string;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: false;
  };
  initialCommitMessage: "Initialize repository from supported template";
  idempotencyKey: string;
  intendedOutcome: "create-private-fresh-history-repository";
  digest: string;
}

export interface DraftPullRequestProposal {
  version: typeof GITHUB_PUBLICATION_VERSION;
  installationIdentityDigest: string;
  repositoryId: string;
  owner: string;
  name: string;
  visibility: "private";
  baseBranch: string;
  baseSha: string;
  baseTree: string;
  repositoryObservationDigest: string;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: boolean;
  };
  reviewDigest: string;
  changeSetDigest: string;
  changedContentDigest: string;
  approvedPaths: readonly string[];
  branchName: string;
  draft: true;
  title: string;
  idempotencyKey: string;
  intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request";
  digest: string;
}

type MutationKind = "fresh-repository" | "draft-pull-request";

export interface GitHubMutationPendingReceipt {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: MutationKind;
  status: "pending";
  proposalDigest: string;
  idempotencyKey: string;
  approvedByCallId: string;
  digest: string;
}

export interface GitHubMutationFailureReceipt {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: MutationKind;
  status: "failed";
  proposalDigest: string;
  idempotencyKey: string;
  approvedByCallId: string;
  failureCode: "provider-rejected" | "postcondition-failed";
  providerCode: string;
  recoveryRequired: true;
  digest: string;
}

export interface FreshRepositorySuccessReceipt {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: "fresh-repository";
  status: "succeeded";
  proposalDigest: string;
  idempotencyKey: string;
  approvedByCallId: string;
  installationIdentityDigest: string;
  repository: GitHubRepositoryObservation;
  initialCommitSha: string;
  initialCommitTree: string;
  parentCount: 0;
  freshHistory: true;
  releaseGateAbsent: true;
  recoveredFromPending: boolean;
  providerReadBackDigest: string;
  digest: string;
}

export interface DraftPullRequestSuccessReceipt {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: "draft-pull-request";
  status: "succeeded";
  proposalDigest: string;
  idempotencyKey: string;
  approvedByCallId: string;
  installationIdentityDigest: string;
  repositoryId: string;
  branchName: string;
  branchSha: string;
  branchTree: string;
  pullRequestId: string;
  pullRequestNumber: number;
  draft: true;
  baseBranch: string;
  baseSha: string;
  changeSetDigest: string;
  changedContentDigest: string;
  normalizedChangedPaths: readonly string[];
  releaseGateUnchanged: true;
  recoveredFromPending: boolean;
  providerReadBackDigest: string;
  digest: string;
}

export type GitHubMutationReceipt =
  | GitHubMutationPendingReceipt
  | GitHubMutationFailureReceipt
  | FreshRepositorySuccessReceipt
  | DraftPullRequestSuccessReceipt;

export interface FreshRepositoryReadBack {
  version: typeof GITHUB_PUBLICATION_VERSION;
  idempotencyKey: string;
  repository: GitHubRepositoryObservation;
  initialCommit: { sha: string; tree: string; parents: readonly [] };
  digest: string;
}

interface AbsentBranch {
  status: "absent";
}
interface PresentBranch {
  status: "present";
  branchName: string;
  branchSha: string;
  branchTree: string;
  normalizedChangedPaths: readonly string[];
  changedContentDigest: string;
  idempotencyKey: string;
}
interface AbsentPullRequest {
  status: "absent";
}
interface PresentPullRequest {
  status: "present";
  pullRequestId: string;
  pullRequestNumber: number;
  draft: boolean;
  headRepositoryId: string;
  headBranch: string;
  headSha: string;
  baseRepositoryId: string;
  baseBranch: string;
  baseSha: string;
  changeSetDigest: string;
  idempotencyKey: string;
}

export interface DraftPublicationReadBack {
  version: typeof GITHUB_PUBLICATION_VERSION;
  idempotencyKey: string;
  repository: GitHubRepositoryObservation;
  changedPathsSinceBase: readonly string[];
  branch: AbsentBranch | PresentBranch;
  pullRequest: AbsentPullRequest | PresentPullRequest;
  digest: string;
}

export type GitHubMutationAcknowledgement =
  | { status: "accepted"; requestId: string }
  | { status: "rejected"; code: string; path?: string }
  | {
      status: "rejected";
      code: "github-file-write-failed";
      operation: "create-blob";
      path: string;
      bytes: number;
      providerStatus?: number;
    };

interface GitHubPublicationFileState {
  mode: string;
  digest: string;
}

export interface GitHubFreshRepositoryContentFile {
  path: string;
  mode: "100644" | "100755";
  objectId: string;
  digest: string;
  bytes: Uint8Array;
}

export type GitHubPublicationContentChange =
  | {
      path: string;
      kind: "added";
      after: GitHubPublicationFileState & { bytes: Uint8Array };
    }
  | {
      path: string;
      kind: "modified";
      before: GitHubPublicationFileState;
      after: GitHubPublicationFileState & { bytes: Uint8Array };
    }
  | {
      path: string;
      kind: "deleted";
      before: GitHubPublicationFileState;
    };

/**
 * Exact, ephemeral publication bytes. This value is passed directly to the
 * provider mutation port and is deliberately absent from proposals, workflow
 * state, and durable receipt storage.
 */
export interface GitHubFreshRepositoryContent {
  version: 1;
  kind: "fresh-repository-source-tree";
  sourceSha: string;
  sourceTree: string;
  files: readonly GitHubFreshRepositoryContentFile[];
}

export interface GitHubDraftPullRequestContent {
  version: 1;
  kind: "draft-reviewed-change-set";
  reviewDigest: string;
  changeSetDigest: string;
  changedContentDigest: string;
  approvedPaths: readonly string[];
  changes: readonly GitHubPublicationContentChange[];
}

export type GitHubPublicationContent = GitHubFreshRepositoryContent | GitHubDraftPullRequestContent;

/** Read-only access to the already-approved apply overlay. */
export interface GitHubFreshRepositoryContentSource {
  readFreshTree: () => Promise<GitHubFreshRepositoryContent>;
}

export interface GitHubDraftPullRequestContentSource {
  readFile: (path: string) => Promise<{
    mode: string;
    digest: string;
    bytes: Uint8Array;
  } | null>;
}

/** The fields shared by new-PR and existing-draft publication reviews. */
export type ReviewedPublicationBinding = Pick<
  DraftPullRequestProposal,
  "reviewDigest" | "changeSetDigest" | "changedContentDigest" | "approvedPaths"
>;

export type GitHubPublicationContentSource = GitHubFreshRepositoryContentSource &
  GitHubDraftPullRequestContentSource;

export interface GitHubSourceResolutionAdapter {
  inspectInstallation: (operation: GitHubOperation) => Promise<GitHubInstallationIdentity>;
  inspectRepository: (input: {
    operation: "resolve-existing-source" | "publish-draft-pull-request";
    repositoryId: string;
    ref: string;
  }) => Promise<GitHubRepositoryObservation>;
}

export interface GitHubTargetSourceResolutionAdapter {
  inspectTargetAccess: (repositoryId: string) => Promise<GitHubTargetAccessProof>;
  inspectRepository: (input: {
    proof: GitHubTargetAccessProof;
    repositoryId: string;
    ref: string;
  }) => Promise<GitHubRepositoryObservation>;
}

export interface GitHubPublicationAdapter extends GitHubSourceResolutionAdapter {
  prDelivery?: GitHubPrDeliveryProvider;
  inspectDestinationFiles?: (input: {
    repository: GitHubRepositoryObservation;
    paths: readonly string[];
  }) => Promise<readonly OverlayFile[]>;
  readDestinationFile?: (input: {
    repository: GitHubRepositoryObservation;
    path: string;
  }) => Promise<{ bytes: Uint8Array; mode: "644" | "755"; digest: string } | null>;
  inspectHistoricalAppSource?: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    source: HistoricalAppSourceSelector;
  }) => Promise<HistoricalAppSourceObservation>;
  /** Available when the provider can prove access to one repository without listing the installation. */
  targetSourceAdapter?: GitHubTargetSourceResolutionAdapter;
  inspectExistingDraft: (
    input: ExistingDraftInspectionRequest,
  ) => Promise<ExistingDraftObservation>;
  updateExistingDraft: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedDraftUpdate?: (
    proposal: ExistingDraftUpdateProposal,
    content: GitHubDraftPullRequestContent,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
  inspectAppliedDraftRepair?: (
    proposal: ExistingDraftUpdateProposal,
    resolvedTree: string,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
  reconcileExistingDraft?: (
    proposal: ExistingDraftReconciliationProposal,
    content: ReconciliationContent,
    recovery?: OwnedDraftInspectionRecovery,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedDraftReconciliation?: (
    proposal: ExistingDraftReconciliationProposal,
    observed: ExistingDraftObservation,
    recovery?: OwnedDraftInspectionRecovery,
  ) => Promise<boolean>;
  inspectDestination: (input: {
    owner: string;
    name: string;
  }) => Promise<"absent" | GitHubRepositoryObservation>;
  inspectFreshRepositoryOutcome: (
    proposal: FreshRepositoryProposal,
  ) => Promise<FreshRepositoryReadBack | undefined>;
  createPrivateFreshHistoryRepository: (
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectDraftPublication: (
    proposal: DraftPullRequestProposal,
  ) => Promise<DraftPublicationReadBack>;
  publishDraftPullRequest: (
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ) => Promise<GitHubMutationAcknowledgement>;
}

export interface GitHubPublicationReceiptStore {
  read: (proposalDigest: string) => Promise<GitHubMutationReceipt | undefined>;
  findDraftByPullRequest?: (
    repositoryId: string,
    pullRequestNumber: number,
  ) => Promise<DraftPullRequestSuccessReceipt | undefined>;
  compareAndSet: (
    proposalDigest: string,
    expectedDigest: string | undefined,
    receipt: GitHubMutationReceipt,
  ) => Promise<boolean>;
}

export class GitHubOutcomeUnknownError extends Error {
  constructor() {
    super("GitHub mutation outcome is unknown; durable intent remains pending.");
    this.name = "GitHubOutcomeUnknownError";
  }
}

type CanonicalJsonPrimitive = string | number | boolean | null;
type CanonicalJsonContainer =
  | readonly CanonicalJsonValue[]
  | Readonly<Record<string, CanonicalJsonValue>>;
type CanonicalJsonValue = CanonicalJsonPrimitive | CanonicalJsonContainer;
const digest = (value: CanonicalJsonValue) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const bytesDigest = (value: Uint8Array) => createHash("sha256").update(value).digest("hex");

// Boundary equality should ignore object property insertion order. Digest
// construction remains schema-ordered through the existing digest().
type JsonRecord = Readonly<Record<string, CanonicalJsonValue>>;
const record = (value: CanonicalJsonValue): value is JsonRecord =>
  value !== null && typeof value === "object" && !Array.isArray(value);

const sameSortedKeys = (actual: readonly string[], expected: readonly string[]): boolean =>
  actual.toSorted().join("\0") === expected.toSorted().join("\0");

const containsAsciiControl = (value: string): boolean =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });

const safeSourcePathValue = (value: CanonicalJsonValue | undefined): value is string =>
  typeof value === "string" && safeSourcePath(value);

const canonicalJson = (value: CanonicalJsonValue): string => {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`;
  }
  if (record(value)) {
    return `{${Object.keys(value)
      .toSorted()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

const canonicalReviewedChanges = (changes: ReviewedChangeSetReceipt["changes"]) =>
  changes.map((change) => {
    if (change.kind === "added") {
      if (change.after === undefined) {
        throw new Error("An added change requires after content.");
      }
      return {
        after: { digest: change.after.digest, mode: change.after.mode },
        kind: change.kind,
        path: change.path,
      };
    }
    if (change.kind === "modified") {
      if (change.after === undefined || change.before === undefined) {
        throw new Error("A modified change requires before and after content.");
      }
      return {
        after: { digest: change.after.digest, mode: change.after.mode },
        before: { digest: change.before.digest, mode: change.before.mode },
        kind: change.kind,
        path: change.path,
      };
    }
    if (change.kind !== "deleted" || change.before === undefined) {
      throw new Error("A deleted change requires before content.");
    }
    return {
      before: { digest: change.before.digest, mode: change.before.mode },
      kind: change.kind,
      path: change.path,
    };
  });

function exactKeys(value: CanonicalJsonValue, keys: readonly string[]): boolean {
  return record(value) && sameSortedKeys(Object.keys(value), keys);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isObjectId(value: unknown): value is string {
  return (
    typeof value === "string" && (/^[0-9a-f]{40}$/u.test(value) || /^[0-9a-f]{64}$/u.test(value))
  );
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value);
}

function safeName(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  return (
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".git")
  );
}

function safeBranch(value: unknown): value is string {
  if (typeof value !== "string") {
    return false;
  }
  const hasValidBranchLength = value.length > 0 && value.length <= 200;
  const hasValidBoundaries = !value.startsWith("/") && !value.endsWith("/") && !value.endsWith(".");
  const hasNoForbiddenSuffix = !value.endsWith(".lock");
  const hasNoForbiddenSequence = !value.includes("..") && !value.includes("@{");
  const hasNoForbiddenCharacter = !/[~^:?*[\\\s]/u.test(value) && !containsAsciiControl(value);
  const hasValidSegments = value
    .split("/")
    .every((part) => part.length > 0 && !part.startsWith("."));
  return (
    hasValidBranchLength &&
    hasValidBoundaries &&
    hasNoForbiddenSuffix &&
    hasNoForbiddenSequence &&
    hasNoForbiddenCharacter &&
    hasValidSegments
  );
}

function safeHeadRef(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.startsWith("refs/heads/") &&
    safeBranch(value.slice("refs/heads/".length))
  );
}

function canonicalWithoutDigest<T extends { digest: string }>(value: T) {
  const { digest: _digest, ...unsigned } = value;
  void _digest;
  return unsigned;
}

function exactDigest(value: { digest: string }, label: string): void {
  if (!isDigest(value.digest) || digest(canonicalWithoutDigest(value)) !== value.digest) {
    throw new Error(`${label} digest is malformed.`);
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return left === right || left.startsWith(`${right}/`) || right.startsWith(`${left}/`);
}

function canonicalPaths(paths: readonly string[]): readonly string[] {
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !safeSourcePath(path))
  ) {
    throw new Error("GitHub publication paths are unsafe or duplicated.");
  }
  return [...paths].toSorted(compareOverlayPaths);
}

function canonicalPathsOrEmpty(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) {
    return [];
  }
  return canonicalPaths(paths);
}

function releaseGateAbsent(repository: GitHubRepositoryObservation): boolean {
  return (
    repository.releaseGate.name === REPOSITORY_RELEASE_GATE && !repository.releaseGate.configured
  );
}

function assertCanonicalReview(review: ReviewedChangeSetReceipt): void {
  const changeSet = { ...review };
  delete changeSet.changeSetDigest;
  delete changeSet.reviewedByCallId;
  changeSet.digest = review.changeSetDigest;
  const sortedChanges = [...review.changes].toSorted((left, right) =>
    compareOverlayPaths(left.path, right.path),
  );
  const verifiedChangeSet = [review.changes, canonicalReviewedChanges(review.changes)].some(
    (changes) => {
      const candidate = { ...changeSet, changes, digest: review.changeSetDigest };
      return (
        digest(canonicalWithoutDigest(candidate)) === review.changeSetDigest &&
        digest({
          ...candidate,
          changeSetDigest: review.changeSetDigest,
          reviewedByCallId: review.reviewedByCallId,
        }) === review.digest
      );
    },
  );
  const pathsAreCanonical =
    JSON.stringify(canonicalPaths(review.approvedPaths)) === JSON.stringify(review.approvedPaths);
  const pathsMatchChanges =
    JSON.stringify(review.approvedPaths) === JSON.stringify(review.changes.map(({ path }) => path));
  const changesAreCanonical = canonicalJson(review.changes) === canonicalJson(sortedChanges);
  if (
    !isDigest(review.changeSetDigest) ||
    !verifiedChangeSet ||
    !changesAreCanonical ||
    !pathsAreCanonical ||
    !pathsMatchChanges
  ) {
    throw new Error("The reviewed change-set receipt is non-canonical.");
  }
}

/** Strict canonical evidence shared by initial and repair update validation. */
export const assertCanonicalGitHubUpdateReview = (review: DraftUpdateReview): void => {
  if (isPublishedDraftRepairReview(review)) {
    assertPublishedDraftRepairReview(review);
    return;
  }
  assertCanonicalReview(review);
};

function reviewForProposal(
  proposal: FreshRepositoryProposal | ReviewedPublicationBinding,
  review: DraftUpdateReview,
): void {
  assertCanonicalGitHubUpdateReview(review);
  const baseReviewMismatch =
    proposal.reviewDigest !== review.digest || proposal.changeSetDigest !== review.changeSetDigest;
  const contentReviewMismatch =
    "changedContentDigest" in proposal &&
    (proposal.changedContentDigest !== review.changedContentDigest ||
      JSON.stringify(proposal.approvedPaths) !== JSON.stringify(review.approvedPaths));
  if (baseReviewMismatch || contentReviewMismatch) {
    throw new Error("The publication content review does not match the sealed proposal.");
  }
}

function contentManifest(
  changes: readonly GitHubPublicationContentChange[],
): ReviewedChangeSetReceipt["changes"] {
  return changes.map((change) => {
    if (change.kind === "added") {
      return {
        after: { digest: change.after.digest, mode: change.after.mode },
        kind: change.kind,
        path: change.path,
      };
    }
    if (change.kind === "modified") {
      return {
        after: { digest: change.after.digest, mode: change.after.mode },
        before: change.before,
        kind: change.kind,
        path: change.path,
      };
    }
    return { before: change.before, kind: change.kind, path: change.path };
  });
}

function exactContentFileState(value: CanonicalJsonValue, includeBytes: boolean): boolean {
  const keys = includeBytes
    ? (["mode", "digest", "bytes"] as const)
    : (["mode", "digest"] as const);
  if (!record(value) || !exactKeys(value, keys)) {
    return false;
  }
  if (value.mode !== "644" && value.mode !== "755") {
    return false;
  }
  if (!isDigest(value.digest)) {
    return false;
  }
  return !includeBytes || value.bytes instanceof Uint8Array;
}

function exactContentChange(change: CanonicalJsonValue): boolean {
  if (!record(change) || !safeSourcePathValue(change.path)) {
    return false;
  }
  if (change.kind === "added") {
    return (
      exactKeys(change, ["path", "kind", "after"]) && exactContentFileState(change.after, true)
    );
  }
  if (change.kind === "modified") {
    return (
      exactKeys(change, ["path", "kind", "before", "after"]) &&
      exactContentFileState(change.before, false) &&
      exactContentFileState(change.after, true)
    );
  }
  return (
    change.kind === "deleted" &&
    exactKeys(change, ["path", "kind", "before"]) &&
    exactContentFileState(change.before, false)
  );
}

function gitObjectDigest(
  type: "blob" | "tree",
  content: Uint8Array,
  algorithm: "sha1" | "sha256",
): Buffer {
  const header = Buffer.from(`${type} ${content.byteLength}\0`);
  return createHash(algorithm).update(header).update(content).digest();
}

function freshContentTree(
  files: readonly GitHubFreshRepositoryContentFile[],
  algorithm: "sha1" | "sha256",
): string {
  type Node =
    | { kind: "directory"; children: Map<string, Node> }
    | { kind: "file"; file: GitHubFreshRepositoryContentFile };
  const root: Extract<Node, { kind: "directory" }> = {
    children: new Map(),
    kind: "directory",
  };
  for (const file of files) {
    let directory = root;
    const segments = file.path.split("/");
    for (const segment of segments.slice(0, -1)) {
      const existing = directory.children.get(segment);
      if (existing?.kind === "file") {
        throw new Error("The fresh repository source manifest overlaps paths.");
      }
      const child: Extract<Node, { kind: "directory" }> =
        existing?.kind === "directory" ? existing : { children: new Map(), kind: "directory" };
      directory.children.set(segment, child);
      directory = child;
    }
    const name = segments.at(-1);
    if (name === undefined) {
      throw new Error("The fresh repository source manifest is missing a path segment.");
    }
    if (directory.children.has(name)) {
      throw new Error("The fresh repository source manifest duplicates paths.");
    }
    directory.children.set(name, { file, kind: "file" });
  }
  const encodeTree = (directory: Extract<Node, { kind: "directory" }>): Buffer => {
    const entries = [...directory.children.entries()].toSorted(
      ([leftName, left], [rightName, right]) =>
        Buffer.compare(
          Buffer.from(`${leftName}${left.kind === "directory" ? "/" : ""}`),
          Buffer.from(`${rightName}${right.kind === "directory" ? "/" : ""}`),
        ),
    );
    return Buffer.concat(
      entries.map(([name, entry]) => {
        const mode = entry.kind === "file" ? entry.file.mode : "40000";
        const oid =
          entry.kind === "file"
            ? gitObjectDigest("blob", entry.file.bytes, algorithm)
            : gitObjectDigest("tree", encodeTree(entry), algorithm);
        return Buffer.concat([Buffer.from(`${mode} ${name}\0`), oid]);
      }),
    );
  };
  return gitObjectDigest("tree", encodeTree(root), algorithm).toString("hex");
}

const validFreshContentBinding = (
  content: GitHubFreshRepositoryContent,
  proposal: FreshRepositoryProposal,
): boolean =>
  content.version === 1 &&
  content.kind === "fresh-repository-source-tree" &&
  content.sourceSha === proposal.sourceSha &&
  content.sourceTree === proposal.sourceTree &&
  content.files.length > 0;

const isExactFreshContentFile = (
  file: GitHubFreshRepositoryContentFile,
  algorithm: "sha1" | "sha256",
): boolean =>
  exactKeys(file, ["path", "mode", "objectId", "digest", "bytes"]) &&
  safeSourcePath(file.path) &&
  (file.mode === "100644" || file.mode === "100755") &&
  isObjectId(file.objectId) &&
  isDigest(file.digest) &&
  file.bytes instanceof Uint8Array &&
  bytesDigest(file.bytes) === file.digest &&
  gitObjectDigest("blob", file.bytes, algorithm).toString("hex") === file.objectId;

export const assertExactGitHubFreshRepositoryContent = (input: {
  proposal: FreshRepositoryProposal;
  content: GitHubFreshRepositoryContent;
}): void => {
  const { content, proposal } = input;
  if (
    !exactKeys(content, ["version", "kind", "sourceSha", "sourceTree", "files"]) ||
    !validFreshContentBinding(content, proposal)
  ) {
    throw new Error("The fresh repository content schema is invalid.");
  }
  const algorithm = proposal.sourceTree.length === 64 ? "sha256" : "sha1";
  const paths = content.files.map((file) => file.path);
  const hasDuplicatePaths = new Set(paths).size !== paths.length;
  const containsInvalidFile = content.files.some(
    (file) => !isExactFreshContentFile(file, algorithm),
  );
  if (
    hasDuplicatePaths ||
    containsInvalidFile ||
    freshContentTree(content.files, algorithm) !== proposal.sourceTree
  ) {
    throw new Error("The fresh repository content does not match the immutable source tree.");
  }
};

export function assertExactGitHubDraftPullRequestContent(input: {
  proposal: ReviewedPublicationBinding;
  content: GitHubDraftPullRequestContent;
}): void {
  const { content, proposal } = input;
  if (
    !exactKeys(content, [
      "version",
      "kind",
      "reviewDigest",
      "changeSetDigest",
      "changedContentDigest",
      "approvedPaths",
      "changes",
    ]) ||
    !Array.isArray(content.approvedPaths) ||
    !Array.isArray(content.changes) ||
    content.changes.some((change) => !exactContentChange(change))
  ) {
    throw new Error("The publication content schema is not closed.");
  }
  const refreshInstructions =
    "Refresh the change-set review, seal a new proposal, and request approval for that exact proposal.";
  let mismatchedField: string | undefined;
  if (content.version !== 1) {
    mismatchedField = "version";
  } else if (content.kind !== "draft-reviewed-change-set") {
    mismatchedField = "kind";
  } else if (content.reviewDigest !== proposal.reviewDigest) {
    mismatchedField = "reviewDigest";
  } else if (content.changeSetDigest !== proposal.changeSetDigest) {
    mismatchedField = "changeSetDigest";
  } else if (content.changedContentDigest !== proposal.changedContentDigest) {
    mismatchedField = "changedContentDigest";
  } else if (JSON.stringify(content.approvedPaths) !== JSON.stringify(proposal.approvedPaths)) {
    mismatchedField = "approvedPaths";
  }
  if (mismatchedField !== undefined) {
    throw new Error(
      `The publication content field ${mismatchedField} does not match the sealed reviewed proposal. ${refreshInstructions}`,
    );
  }
  const mismatchedBytes = content.changes.find(
    (change) =>
      change.kind !== "deleted" && bytesDigest(change.after.bytes) !== change.after.digest,
  );
  if (mismatchedBytes !== undefined && mismatchedBytes.kind !== "deleted") {
    throw new Error(
      `The reviewed after-bytes digest does not match the approved content for ${mismatchedBytes.path}. ${refreshInstructions}`,
    );
  }
}

export function assertExactGitHubPublicationContent(input: {
  proposal: ReviewedPublicationBinding;
  review: DraftUpdateReview;
  content: GitHubDraftPullRequestContent;
}): void {
  reviewForProposal(input.proposal, input.review);
  assertExactGitHubDraftPullRequestContent(input);
  if (
    digest(input.review.changes) !== input.proposal.changedContentDigest &&
    digest(canonicalReviewedChanges(input.review.changes)) !== input.proposal.changedContentDigest
  ) {
    throw new Error(
      "The reviewed change-content digest does not match its sealed proposal. Refresh the change-set review and seal a new proposal before publication.",
    );
  }
  const manifest = contentManifest(input.content.changes);
  const mismatch = manifest.findIndex(
    (change, index) => !isDeepStrictEqual(change, input.review.changes[index]),
  );
  if (mismatch !== -1 || manifest.length !== input.review.changes.length) {
    const path = manifest[mismatch]?.path ?? input.review.changes[mismatch]?.path ?? "unknown path";
    throw new Error(
      `The publication content for ${path} does not match the approved reviewed overlay. Re-observe that file, refresh the change-set review, and seal a new proposal before publication.`,
    );
  }
}

export async function readExactGitHubFreshRepositoryContent(input: {
  proposal: FreshRepositoryProposal;
  source: GitHubFreshRepositoryContentSource;
}): Promise<GitHubFreshRepositoryContent> {
  let observed: GitHubFreshRepositoryContent;
  try {
    observed = await input.source.readFreshTree();
  } catch {
    throw new Error("The approved publication content source failed.");
  }
  const content: GitHubFreshRepositoryContent = {
    ...observed,
    files: observed.files.map((file) => ({
      ...file,
      bytes: new Uint8Array(file.bytes),
    })),
  };
  assertExactGitHubFreshRepositoryContent({
    content,
    proposal: input.proposal,
  });
  return content;
}

export async function readExactGitHubPublicationContent(input: {
  proposal: ReviewedPublicationBinding;
  review: DraftUpdateReview;
  source: GitHubDraftPullRequestContentSource;
}): Promise<GitHubDraftPullRequestContent> {
  reviewForProposal(input.proposal, input.review);
  const changes: GitHubPublicationContentChange[] = [];
  const changeResults = await Promise.all(
    input.review.changes.map(async (change) => {
      if (change.kind === "deleted") {
        if (change.before === undefined) {
          throw new Error("The reviewed deletion preimage is missing.");
        }
        return {
          before: change.before,
          kind: change.kind,
          path: change.path,
        } satisfies GitHubPublicationContentChange;
      }
      if (change.after === undefined) {
        throw new Error("The reviewed publication postimage is missing.");
      }
      let observed: Awaited<ReturnType<typeof input.source.readFile>>;
      try {
        observed = await input.source.readFile(change.path);
      } catch {
        throw new Error("The approved publication content source failed.");
      }
      if (observed === null) {
        throw new Error(
          `The approved publication postimage is missing for ${change.path}. Refresh the repository observation and reviewed diff, reseal the proposal, and request publication approval again.`,
        );
      }
      const bytes = new Uint8Array(observed.bytes);
      if (
        observed.mode !== change.after.mode ||
        observed.digest !== change.after.digest ||
        bytesDigest(bytes) !== change.after.digest
      ) {
        throw new Error(
          `The approved publication postimage changed for ${change.path}. Refresh the repository observation and reviewed diff, reseal the proposal, and request publication approval again.`,
        );
      }
      if (change.kind === "added") {
        return {
          after: { ...change.after, bytes },
          kind: change.kind,
          path: change.path,
        } satisfies GitHubPublicationContentChange;
      }
      if (change.before === undefined) {
        throw new Error("The reviewed modification preimage is missing.");
      }
      return {
        after: { ...change.after, bytes },
        before: change.before,
        kind: change.kind,
        path: change.path,
      } satisfies GitHubPublicationContentChange;
    }),
  );
  changes.push(...changeResults);
  const content: GitHubDraftPullRequestContent = {
    approvedPaths: input.review.approvedPaths,
    changeSetDigest: input.review.changeSetDigest,
    changedContentDigest: input.review.changedContentDigest,
    changes,
    kind: "draft-reviewed-change-set",
    reviewDigest: input.review.digest,
    version: 1,
  };
  assertExactGitHubPublicationContent({
    content,
    proposal: input.proposal,
    review: input.review,
  });
  return content;
}

function assertReviewedBinding(
  source: SourceReceiptEvidence,
  review: ReviewedChangeSetReceipt,
): void {
  parseSourceReceiptEvidence(source);
  assertCanonicalReview(review);
  const sourceBindingMismatch =
    source.digest !== review.sourceReceiptDigest ||
    source.sourceSha !== review.sourceSha ||
    source.sourceTree !== review.sourceTree;
  const reviewBindingMismatch =
    source.contractDigest !== review.repositoryContractDigest ||
    source.eligibilityDigest !== review.eligibilityDigest;
  if (source.releaseEnabled || sourceBindingMismatch || reviewBindingMismatch) {
    throw new Error("The reviewed change set is not bound to the exact source receipt.");
  }
}

const installationKeys = [
  "version",
  "operation",
  "installationId",
  "accountId",
  "accountLogin",
  "accountType",
  "repositorySelection",
  "selectedRepositoryIds",
  "permissions",
  "digest",
] as const;
const permissionKeys = [
  "metadata",
  "contents",
  "workflows",
  "pullRequests",
  "administration",
  "variables",
] as const;

export function createGitHubInstallationIdentity(
  input: Omit<GitHubInstallationIdentity, "version" | "permissions" | "digest">,
): GitHubInstallationIdentity {
  if (
    !isGitHubOperation(input.operation) ||
    !isDecimal(input.installationId) ||
    !isDecimal(input.accountId) ||
    !safeName(input.accountLogin) ||
    (input.accountType !== "Organization" && input.accountType !== "User") ||
    (input.repositorySelection !== "all" && input.repositorySelection !== "selected") ||
    !Array.isArray(input.selectedRepositoryIds) ||
    new Set(input.selectedRepositoryIds).size !== input.selectedRepositoryIds.length ||
    input.selectedRepositoryIds.some((id) => !isDecimal(id))
  ) {
    throw new Error("The GitHub installation identity is invalid.");
  }
  const unsigned = {
    accountId: input.accountId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    installationId: input.installationId,
    operation: input.operation,
    permissions: githubPermissionsFor(input.operation),
    repositorySelection: input.repositorySelection,
    selectedRepositoryIds: input.selectedRepositoryIds.toSorted(compareDecimalIds),
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

function isGitHubOperation(value: GitHubOperation): boolean {
  return (
    value === "resolve-existing-source" ||
    value === "create-fresh-repository" ||
    value === "publish-draft-pull-request"
  );
}

function compareDecimalIds(left: string, right: string): number {
  if (BigInt(left) < BigInt(right)) {
    return -1;
  }
  if (BigInt(left) > BigInt(right)) {
    return 1;
  }
  return 0;
}

export function assertExactInstallationIdentity(identity: GitHubInstallationIdentity): void {
  if (!exactKeys(identity, installationKeys) || !exactKeys(identity.permissions, permissionKeys)) {
    throw new Error("The GitHub installation identity schema is not closed.");
  }
  const rebuilt = createGitHubInstallationIdentity({
    accountId: identity.accountId,
    accountLogin: identity.accountLogin,
    accountType: identity.accountType,
    installationId: identity.installationId,
    operation: identity.operation,
    repositorySelection: identity.repositorySelection,
    selectedRepositoryIds: identity.selectedRepositoryIds,
  });
  if (canonicalJson(identity) !== canonicalJson(rebuilt)) {
    throw new Error("The GitHub installation identity is non-canonical or over-privileged.");
  }
}

export const repositoryKeys = [
  "version",
  "repositoryId",
  "owner",
  "name",
  "visibility",
  "defaultBranch",
  "headSha",
  "headTree",
  "installationIdentityDigest",
  "releaseGate",
  "digest",
] as const;

export function createRepositoryObservation(
  input: Omit<GitHubRepositoryObservation, "version" | "digest">,
): GitHubRepositoryObservation {
  if (!validRepositoryObservationInput(input)) {
    throw new Error("The repository observation is invalid.");
  }
  const unsigned = { version: GITHUB_PUBLICATION_VERSION, ...input };
  return { ...unsigned, digest: digest(unsigned) };
}

function validRepositoryObservationInput(
  input: Omit<GitHubRepositoryObservation, "version" | "digest">,
): boolean {
  const releaseGateValid =
    (exactKeys(input.releaseGate, ["name", "configured"]) &&
      input.releaseGate.name === REPOSITORY_RELEASE_GATE &&
      input.releaseGate.configured) ||
    !input.releaseGate.configured;
  const repositoryIdentityValid =
    isDecimal(input.repositoryId) &&
    safeName(input.owner) &&
    safeName(input.name) &&
    input.visibility === "private";
  const headValid =
    safeBranch(input.defaultBranch) &&
    isObjectId(input.headSha) &&
    isObjectId(input.headTree) &&
    isDigest(input.installationIdentityDigest);
  return repositoryIdentityValid && headValid && releaseGateValid;
}

export function assertExactRepositoryObservation(repository: GitHubRepositoryObservation): void {
  if (!exactKeys(repository, repositoryKeys)) {
    throw new Error("The repository observation schema is not closed.");
  }
  const rebuilt = createRepositoryObservation({
    defaultBranch: repository.defaultBranch,
    headSha: repository.headSha,
    headTree: repository.headTree,
    installationIdentityDigest: repository.installationIdentityDigest,
    name: repository.name,
    owner: repository.owner,
    releaseGate: {
      configured: repository.releaseGate.configured,
      name: repository.releaseGate.name,
    },
    repositoryId: repository.repositoryId,
    visibility: repository.visibility,
  });
  if (canonicalJson(repository) !== canonicalJson(rebuilt)) {
    throw new Error("The repository observation is non-canonical.");
  }
}

export async function resolveImmutableExistingSource(input: {
  adapter: GitHubSourceResolutionAdapter;
  expectedInstallationId: string;
  repositoryId: string;
  ref: string;
  expectedSha: string;
  expectedTree: string;
  resolvedByCallId: string;
}): Promise<ImmutableGitHubSourceReceipt> {
  if (!validImmutableSourceRequest(input)) {
    throw new Error("The immutable source request is invalid.");
  }
  const installation = await input.adapter.inspectInstallation("resolve-existing-source");
  assertExactInstallationIdentity(installation);
  if (
    installation.operation !== "resolve-existing-source" ||
    installation.installationId !== input.expectedInstallationId ||
    !installation.selectedRepositoryIds.includes(input.repositoryId)
  ) {
    throw new Error("The installation is not selected for source resolution.");
  }
  const repository = await input.adapter.inspectRepository({
    operation: "resolve-existing-source",
    ref: input.ref,
    repositoryId: input.repositoryId,
  });
  assertExactRepositoryObservation(repository);
  if (
    repository.installationIdentityDigest !== installation.digest ||
    repository.repositoryId !== input.repositoryId ||
    repository.headSha !== input.expectedSha ||
    repository.headTree !== input.expectedTree
  ) {
    throw new Error("The GitHub source changed or is outside the approved installation.");
  }
  const unsigned = {
    installationIdentityDigest: installation.digest,
    repository,
    resolvedByCallId: input.resolvedByCallId,
    resolvedRef: input.ref,
    resolvedSha: repository.headSha,
    resolvedTree: repository.headTree,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

function validImmutableSourceRequest(input: {
  expectedInstallationId: string;
  repositoryId: string;
  ref: string;
  expectedSha: string;
  expectedTree: string;
}): boolean {
  return (
    isDecimal(input.expectedInstallationId) &&
    isDecimal(input.repositoryId) &&
    safeHeadRef(input.ref) &&
    isObjectId(input.expectedSha) &&
    isObjectId(input.expectedTree)
  );
}

/** Issues the same immutable source receipt from a tenant-bound, target-scoped proof. */
export async function resolveImmutableExistingSourceWithTargetProof(input: {
  adapter: GitHubTargetSourceResolutionAdapter;
  authority: z.input<typeof hostedTenantAuthoritySchema>;
  expectedInstallationId: string;
  repositoryId: string;
  ref: string;
  expectedSha: string;
  expectedTree: string;
  resolvedByCallId: string;
}): Promise<ImmutableGitHubSourceReceipt> {
  if (!validImmutableSourceRequest(input)) {
    throw new Error("The immutable source request is invalid.");
  }
  const proof = parseGitHubTargetAccessProof(
    await input.adapter.inspectTargetAccess(input.repositoryId),
    input.authority,
  );
  if (
    proof.operation !== "resolve-existing-source" ||
    proof.installationId !== input.expectedInstallationId ||
    proof.repositoryId !== input.repositoryId
  ) {
    throw new Error("The installation is not selected for source resolution.");
  }
  const repository = await input.adapter.inspectRepository({
    proof,
    ref: input.ref,
    repositoryId: input.repositoryId,
  });
  assertExactRepositoryObservation(repository);
  if (
    repository.installationIdentityDigest !== proof.digest ||
    repository.repositoryId !== input.repositoryId ||
    repository.headSha !== input.expectedSha ||
    repository.headTree !== input.expectedTree
  ) {
    throw new Error("The GitHub source changed or is outside the approved installation.");
  }
  const unsigned = {
    installationIdentityDigest: proof.digest,
    repository,
    resolvedByCallId: input.resolvedByCallId,
    resolvedRef: input.ref,
    resolvedSha: repository.headSha,
    resolvedTree: repository.headTree,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

const immutableSourceReceiptKeys = [
  "version",
  "repository",
  "resolvedRef",
  "resolvedSha",
  "resolvedTree",
  "installationIdentityDigest",
  "resolvedByCallId",
  "digest",
] as const;

export function assertExactImmutableGitHubSourceReceipt(
  sourceReceipt: ImmutableGitHubSourceReceipt,
): void {
  if (!exactKeys(sourceReceipt, immutableSourceReceiptKeys)) {
    throw new Error("The immutable GitHub source receipt schema is not closed.");
  }
  assertExactRepositoryObservation(sourceReceipt.repository);
  exactDigest(sourceReceipt, "Immutable GitHub source receipt");
  if (
    sourceReceipt.version !== GITHUB_PUBLICATION_VERSION ||
    !safeHeadRef(sourceReceipt.resolvedRef) ||
    !isObjectId(sourceReceipt.resolvedSha) ||
    !isObjectId(sourceReceipt.resolvedTree) ||
    !isDigest(sourceReceipt.installationIdentityDigest) ||
    sourceReceipt.resolvedByCallId.trim().length === 0 ||
    sourceReceipt.repository.headSha !== sourceReceipt.resolvedSha ||
    sourceReceipt.repository.headTree !== sourceReceipt.resolvedTree ||
    sourceReceipt.repository.installationIdentityDigest !== sourceReceipt.installationIdentityDigest
  ) {
    throw new Error("The immutable GitHub source receipt is malformed.");
  }
}

export const freshProposalKeys = [
  "version",
  "installationIdentityDigest",
  "destinationOwner",
  "destinationName",
  "visibility",
  "defaultBranch",
  "sourceReceiptDigest",
  "sourceSha",
  "sourceTree",
  "contractDigest",
  "eligibilityDigest",
  "reviewDigest",
  "changeSetDigest",
  "releaseGate",
  "initialCommitMessage",
  "idempotencyKey",
  "intendedOutcome",
  "digest",
] as const;

export function createFreshRepositoryProposal(input: {
  installation: GitHubInstallationIdentity;
  source: SourceReceiptEvidence;
  review: ReviewedChangeSetReceipt;
  destinationOwner: string;
  destinationName: string;
}): FreshRepositoryProposal {
  assertExactInstallationIdentity(input.installation);
  assertReviewedBinding(input.source, input.review);
  if (
    input.installation.operation !== "create-fresh-repository" ||
    input.source.sourceKind !== "fresh-template" ||
    input.destinationOwner !== input.installation.accountLogin ||
    !safeName(input.destinationName)
  ) {
    throw new Error("Fresh repository creation is outside the approved destination.");
  }
  const idempotencyKey = digest({
    destinationName: input.destinationName,
    destinationOwner: input.destinationOwner,
    installationIdentityDigest: input.installation.digest,
    reviewDigest: input.review.digest,
    sourceReceiptDigest: input.source.digest,
  });
  const unsigned = {
    changeSetDigest: input.review.changeSetDigest,
    contractDigest: input.source.contractDigest,
    defaultBranch: "main" as const,
    destinationName: input.destinationName,
    destinationOwner: input.destinationOwner,
    eligibilityDigest: input.source.eligibilityDigest,
    idempotencyKey,
    initialCommitMessage: "Initialize repository from supported template" as const,
    installationIdentityDigest: input.installation.digest,
    intendedOutcome: "create-private-fresh-history-repository" as const,
    releaseGate: { configured: false as const, name: REPOSITORY_RELEASE_GATE },
    reviewDigest: input.review.digest,
    sourceReceiptDigest: input.source.digest,
    sourceSha: input.source.sourceSha,
    sourceTree: input.source.sourceTree,
    version: GITHUB_PUBLICATION_VERSION,
    visibility: "private" as const,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactFreshRepositoryProposal(proposal: FreshRepositoryProposal): void {
  if (
    !exactKeys(proposal, freshProposalKeys) ||
    !exactKeys(proposal.releaseGate, ["name", "configured"])
  ) {
    throw new Error("The fresh repository proposal schema is not closed.");
  }
  exactDigest(proposal, "Fresh repository proposal");
  const expectedKey = digest({
    destinationName: proposal.destinationName,
    destinationOwner: proposal.destinationOwner,
    installationIdentityDigest: proposal.installationIdentityDigest,
    reviewDigest: proposal.reviewDigest,
    sourceReceiptDigest: proposal.sourceReceiptDigest,
  });
  if (
    proposal.version !== GITHUB_PUBLICATION_VERSION ||
    !safeName(proposal.destinationOwner) ||
    !safeName(proposal.destinationName) ||
    proposal.visibility !== "private" ||
    proposal.defaultBranch !== "main" ||
    !isObjectId(proposal.sourceSha) ||
    !isObjectId(proposal.sourceTree) ||
    !isDigest(proposal.sourceReceiptDigest) ||
    !isDigest(proposal.contractDigest) ||
    !isDigest(proposal.eligibilityDigest) ||
    !isDigest(proposal.reviewDigest) ||
    !isDigest(proposal.changeSetDigest) ||
    proposal.releaseGate.name !== REPOSITORY_RELEASE_GATE ||
    proposal.releaseGate.configured ||
    proposal.initialCommitMessage !== "Initialize repository from supported template" ||
    proposal.intendedOutcome !== "create-private-fresh-history-repository" ||
    proposal.idempotencyKey !== expectedKey
  ) {
    throw new Error("The fresh repository proposal is malformed.");
  }
}

export const draftProposalKeys = [
  "version",
  "installationIdentityDigest",
  "repositoryId",
  "owner",
  "name",
  "visibility",
  "baseBranch",
  "baseSha",
  "baseTree",
  "repositoryObservationDigest",
  "releaseGate",
  "reviewDigest",
  "changeSetDigest",
  "changedContentDigest",
  "approvedPaths",
  "branchName",
  "draft",
  "title",
  "idempotencyKey",
  "intendedOutcome",
  "digest",
] as const;

function safeTitle(value: string): boolean {
  return (
    value === value.trim() &&
    value.length > 0 &&
    value.length <= 120 &&
    ![...value].some((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code < 32 || code === 127;
    })
  );
}

export function createDraftPullRequestProposal(input: {
  installation: GitHubInstallationIdentity;
  repository: GitHubRepositoryObservation;
  review: ReviewedChangeSetReceipt;
  changedPathsSinceBase: readonly string[];
  title: string;
}): DraftPullRequestProposal {
  assertExactInstallationIdentity(input.installation);
  assertExactRepositoryObservation(input.repository);
  assertCanonicalReview(input.review);
  const approvedPaths = canonicalPaths(input.review.approvedPaths);
  if (
    input.installation.operation !== "publish-draft-pull-request" ||
    !input.installation.selectedRepositoryIds.includes(input.repository.repositoryId) ||
    input.repository.installationIdentityDigest !== input.installation.digest ||
    !safeTitle(input.title)
  ) {
    throw new Error("The draft pull-request proposal is stale, overlapping, or unauthorized.");
  }
  const idempotencyKey = digest({
    installationIdentityDigest: input.installation.digest,
    repositoryObservationDigest: input.repository.digest,
    reviewDigest: input.review.digest,
  });
  const unsigned = {
    approvedPaths,
    baseBranch: input.repository.defaultBranch,
    baseSha: input.repository.headSha,
    baseTree: input.repository.headTree,
    branchName: `app-builder/review-${idempotencyKey.slice(0, 20)}`,
    changeSetDigest: input.review.changeSetDigest,
    changedContentDigest: input.review.changedContentDigest,
    draft: true as const,
    idempotencyKey,
    installationIdentityDigest: input.installation.digest,
    intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request" as const,
    name: input.repository.name,
    owner: input.repository.owner,
    releaseGate: input.repository.releaseGate,
    repositoryId: input.repository.repositoryId,
    repositoryObservationDigest: input.repository.digest,
    reviewDigest: input.review.digest,
    title: input.title,
    version: GITHUB_PUBLICATION_VERSION,
    visibility: "private" as const,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactDraftPullRequestProposal(proposal: DraftPullRequestProposal): void {
  if (
    !exactKeys(proposal, draftProposalKeys) ||
    !exactKeys(proposal.releaseGate, ["name", "configured"])
  ) {
    throw new Error("The draft pull-request proposal schema is not closed.");
  }
  exactDigest(proposal, "Draft pull-request proposal");
  const idempotencyKey = digest({
    installationIdentityDigest: proposal.installationIdentityDigest,
    repositoryObservationDigest: proposal.repositoryObservationDigest,
    reviewDigest: proposal.reviewDigest,
  });
  if (!validDraftProposalBindings(proposal, idempotencyKey)) {
    throw new Error("The draft pull-request proposal is malformed.");
  }
}

function validDraftProposalBindings(
  proposal: DraftPullRequestProposal,
  idempotencyKey: string,
): boolean {
  const repositoryValid =
    isDecimal(proposal.repositoryId) &&
    safeName(proposal.owner) &&
    safeName(proposal.name) &&
    proposal.visibility === "private";
  const baseValid =
    safeBranch(proposal.baseBranch) &&
    isObjectId(proposal.baseSha) &&
    isObjectId(proposal.baseTree) &&
    isDigest(proposal.repositoryObservationDigest);
  const reviewValid =
    isDigest(proposal.reviewDigest) &&
    isDigest(proposal.changeSetDigest) &&
    isDigest(proposal.changedContentDigest);
  const pathsValid =
    JSON.stringify(canonicalPaths(proposal.approvedPaths)) ===
    JSON.stringify(proposal.approvedPaths);
  const branchValid =
    safeBranch(proposal.branchName) &&
    proposal.branchName === `app-builder/review-${idempotencyKey.slice(0, 20)}`;
  return (
    proposal.version === GITHUB_PUBLICATION_VERSION &&
    repositoryValid &&
    baseValid &&
    proposal.releaseGate.name === REPOSITORY_RELEASE_GATE &&
    (proposal.releaseGate.configured || !proposal.releaseGate.configured) &&
    reviewValid &&
    pathsValid &&
    branchValid &&
    proposal.draft &&
    safeTitle(proposal.title) &&
    proposal.idempotencyKey === idempotencyKey &&
    proposal.intendedOutcome === "publish-reviewed-change-set-as-draft-pull-request"
  );
}

function assertFreshReadBack(
  readBack: FreshRepositoryReadBack,
  proposal: FreshRepositoryProposal,
): void {
  if (
    !exactKeys(readBack, ["version", "idempotencyKey", "repository", "initialCommit", "digest"]) ||
    !exactKeys(readBack.initialCommit, ["sha", "tree", "parents"]) ||
    !Array.isArray(readBack.initialCommit.parents) ||
    readBack.initialCommit.parents.length !== 0
  ) {
    throw new Error("Fresh repository provider read-back schema is not closed.");
  }
  exactDigest(readBack, "Fresh repository provider read-back");
  assertExactRepositoryObservation(readBack.repository);
  if (
    readBack.version !== GITHUB_PUBLICATION_VERSION ||
    readBack.idempotencyKey !== proposal.idempotencyKey ||
    readBack.repository.installationIdentityDigest !== proposal.installationIdentityDigest ||
    readBack.repository.owner !== proposal.destinationOwner ||
    readBack.repository.name !== proposal.destinationName ||
    readBack.repository.visibility !== "private" ||
    readBack.repository.defaultBranch !== proposal.defaultBranch ||
    readBack.repository.headSha !== readBack.initialCommit.sha ||
    readBack.repository.headTree !== readBack.initialCommit.tree ||
    readBack.initialCommit.tree !== proposal.sourceTree ||
    !releaseGateAbsent(readBack.repository)
  ) {
    throw new Error("Fresh repository provider read-back does not match the proposal.");
  }
}

function assertDraftReadBack(
  readBack: DraftPublicationReadBack,
  proposal: DraftPullRequestProposal,
): void {
  if (
    !exactKeys(readBack, [
      "version",
      "idempotencyKey",
      "repository",
      "changedPathsSinceBase",
      "branch",
      "pullRequest",
      "digest",
    ]) ||
    !Array.isArray(readBack.changedPathsSinceBase)
  ) {
    throw new Error("Draft publication provider read-back schema is not closed.");
  }
  exactDigest(readBack, "Draft publication provider read-back");
  assertExactRepositoryObservation(readBack.repository);
  if (
    readBack.version !== GITHUB_PUBLICATION_VERSION ||
    readBack.idempotencyKey !== proposal.idempotencyKey ||
    readBack.repository.repositoryId !== proposal.repositoryId ||
    readBack.repository.owner !== proposal.owner ||
    readBack.repository.name !== proposal.name ||
    readBack.repository.visibility !== proposal.visibility ||
    readBack.repository.defaultBranch !== proposal.baseBranch ||
    readBack.repository.installationIdentityDigest !== proposal.installationIdentityDigest ||
    readBack.repository.releaseGate.name !== proposal.releaseGate.name ||
    readBack.repository.releaseGate.configured !== proposal.releaseGate.configured ||
    JSON.stringify(canonicalPathsOrEmpty(readBack.changedPathsSinceBase)) !==
      JSON.stringify(readBack.changedPathsSinceBase)
  ) {
    throw new Error(
      "Draft publication repository identity or release-gate state changed. Refresh the repository observation and reviewed diff, reseal the proposal, and request publication approval again.",
    );
  }
  const conflictingPath = canonicalPathsOrEmpty(readBack.changedPathsSinceBase).find((path) =>
    proposal.approvedPaths.some((approved) => pathsOverlap(path, approved)),
  );
  if (conflictingPath !== undefined) {
    throw new Error(
      `Draft publication conflicts with upstream path ${conflictingPath}. Refresh the repository observation and reviewed diff, reseal the proposal, and request publication approval again.`,
    );
  }
  if (readBack.branch.status === "absent") {
    if (!exactKeys(readBack.branch, ["status"])) {
      throw new Error("Absent branch read-back schema is not closed.");
    }
  } else if (
    !exactKeys(readBack.branch, [
      "status",
      "branchName",
      "branchSha",
      "branchTree",
      "normalizedChangedPaths",
      "changedContentDigest",
      "idempotencyKey",
    ]) ||
    readBack.branch.branchName !== proposal.branchName ||
    !isObjectId(readBack.branch.branchSha) ||
    !isObjectId(readBack.branch.branchTree) ||
    JSON.stringify(canonicalPaths(readBack.branch.normalizedChangedPaths)) !==
      JSON.stringify(proposal.approvedPaths) ||
    readBack.branch.changedContentDigest !== proposal.changedContentDigest ||
    readBack.branch.idempotencyKey !== proposal.idempotencyKey
  ) {
    throw new Error("Branch provider read-back does not match the approved change set.");
  }
  if (readBack.pullRequest.status === "absent") {
    if (!exactKeys(readBack.pullRequest, ["status"])) {
      throw new Error("Absent pull-request read-back schema is not closed.");
    }
  } else if (
    !exactKeys(readBack.pullRequest, [
      "status",
      "pullRequestId",
      "pullRequestNumber",
      "draft",
      "headRepositoryId",
      "headBranch",
      "headSha",
      "baseRepositoryId",
      "baseBranch",
      "baseSha",
      "changeSetDigest",
      "idempotencyKey",
    ]) ||
    !isDecimal(readBack.pullRequest.pullRequestId) ||
    !Number.isSafeInteger(readBack.pullRequest.pullRequestNumber) ||
    readBack.pullRequest.pullRequestNumber < 1 ||
    !readBack.pullRequest.draft ||
    readBack.pullRequest.headRepositoryId !== proposal.repositoryId ||
    readBack.pullRequest.headBranch !== proposal.branchName ||
    readBack.pullRequest.baseRepositoryId !== proposal.repositoryId ||
    readBack.pullRequest.baseBranch !== proposal.baseBranch ||
    readBack.pullRequest.baseSha !== readBack.repository.headSha ||
    readBack.pullRequest.changeSetDigest !== proposal.changeSetDigest ||
    readBack.pullRequest.idempotencyKey !== proposal.idempotencyKey ||
    (readBack.branch.status === "present" &&
      readBack.pullRequest.headSha !== readBack.branch.branchSha)
  ) {
    throw new Error("Pull-request provider read-back does not match the proposal.");
  }
}

function receipt<T extends Omit<GitHubMutationReceipt, "digest">>(
  value: T,
): T & { digest: string } {
  return { ...value, digest: digest(value) };
}

const mutationReceiptKeys = {
  common: ["version", "kind", "status", "proposalDigest", "idempotencyKey", "approvedByCallId"],
  draft: [
    "installationIdentityDigest",
    "repositoryId",
    "branchName",
    "branchSha",
    "branchTree",
    "pullRequestId",
    "pullRequestNumber",
    "draft",
    "baseBranch",
    "baseSha",
    "changeSetDigest",
    "changedContentDigest",
    "normalizedChangedPaths",
    "releaseGateUnchanged",
    "recoveredFromPending",
    "providerReadBackDigest",
  ],
  fresh: [
    "installationIdentityDigest",
    "repository",
    "initialCommitSha",
    "initialCommitTree",
    "parentCount",
    "freshHistory",
    "releaseGateAbsent",
    "recoveredFromPending",
    "providerReadBackDigest",
  ],
} as const;

const expectedMutationReceiptKeys = (value: GitHubMutationReceipt): readonly string[] => {
  if (value.status === "pending") {
    return [...mutationReceiptKeys.common, "digest"];
  }
  if (value.status === "failed") {
    return [
      ...mutationReceiptKeys.common,
      "failureCode",
      "providerCode",
      "recoveryRequired",
      "digest",
    ];
  }
  const variant =
    value.kind === "fresh-repository" ? mutationReceiptKeys.fresh : mutationReceiptKeys.draft;
  return [...mutationReceiptKeys.common, ...variant, "digest"];
};

export const assertCanonicalGitHubMutationReceipt = (value: GitHubMutationReceipt): void => {
  if (!exactKeys(value, expectedMutationReceiptKeys(value))) {
    throw new Error("GitHub mutation receipt schema is not closed.");
  }
  exactDigest(value, "GitHub mutation receipt");
  if (!validMutationReceiptHeader(value)) {
    throw new Error("GitHub mutation receipt bindings are invalid.");
  }
  if (value.status === "failed") {
    if (
      !isMutationFailureCode(value.failureCode) ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.providerCode) ||
      !value.recoveryRequired
    ) {
      throw new Error("GitHub failure receipt is invalid.");
    }
  } else if (value.status === "succeeded") {
    if (!validMutationReadBack(value)) {
      throw new Error("GitHub success receipt read-back binding is invalid.");
    }
    if (value.kind === "fresh-repository") {
      assertExactRepositoryObservation(value.repository);
      if (!validFreshSuccessReceipt(value)) {
        throw new Error("Fresh repository success receipt is invalid.");
      }
    } else if (!validDraftSuccessReceipt(value)) {
      throw new Error("Draft pull-request success receipt is invalid.");
    }
  } else if (value.status !== "pending") {
    throw new Error("GitHub mutation receipt status is invalid.");
  }
};

function validMutationReceiptHeader(value: GitHubMutationReceipt): boolean {
  return (
    value.version === GITHUB_PUBLICATION_VERSION &&
    isDigest(value.proposalDigest) &&
    isDigest(value.idempotencyKey) &&
    value.approvedByCallId.length > 0
  );
}
function isMutationFailureCode(value: string): boolean {
  return value === "provider-rejected" || value === "postcondition-failed";
}
function validMutationReadBack(value: GitHubMutationReceipt): boolean {
  if (value.status !== "succeeded") {
    return false;
  }
  if (!isDigest(value.providerReadBackDigest) || !isDigest(value.installationIdentityDigest)) {
    return false;
  }
  return value.kind === "fresh-repository" ? value.releaseGateAbsent : value.releaseGateUnchanged;
}
function validFreshSuccessReceipt(value: FreshRepositorySuccessReceipt): boolean {
  return (
    value.installationIdentityDigest === value.repository.installationIdentityDigest &&
    value.parentCount === 0 &&
    value.freshHistory &&
    value.initialCommitSha === value.repository.headSha &&
    value.initialCommitTree === value.repository.headTree
  );
}
const validDraftSuccessReceipt = (value: DraftPullRequestSuccessReceipt): boolean => {
  const identityValid =
    isDecimal(value.repositoryId) &&
    isDecimal(value.pullRequestId) &&
    Number.isSafeInteger(value.pullRequestNumber) &&
    value.pullRequestNumber >= 1;
  const refsValid =
    safeBranch(value.branchName) &&
    safeBranch(value.baseBranch) &&
    isObjectId(value.branchSha) &&
    isObjectId(value.branchTree) &&
    isObjectId(value.baseSha);
  const reviewValid =
    isDigest(value.changeSetDigest) &&
    isDigest(value.changedContentDigest) &&
    JSON.stringify(canonicalPaths(value.normalizedChangedPaths)) ===
      JSON.stringify(value.normalizedChangedPaths);
  return identityValid && refsValid && value.draft && reviewValid;
};

async function readJournal(
  store: GitHubPublicationReceiptStore,
  proposal: { digest: string; idempotencyKey: string },
  kind: MutationKind,
): Promise<GitHubMutationReceipt | undefined> {
  const value = await store.read(proposal.digest);
  if (value === undefined) {
    return undefined;
  }
  assertCanonicalGitHubMutationReceipt(value);
  if (
    value.kind !== kind ||
    value.proposalDigest !== proposal.digest ||
    value.idempotencyKey !== proposal.idempotencyKey
  ) {
    throw new Error("The GitHub journal belongs to a different proposal.");
  }
  return value;
}

async function claimPending(input: {
  store: GitHubPublicationReceiptStore;
  kind: MutationKind;
  proposalDigest: string;
  idempotencyKey: string;
  approvedByCallId: string;
}): Promise<GitHubMutationPendingReceipt> {
  const pending = receipt({
    approvedByCallId: input.approvedByCallId,
    idempotencyKey: input.idempotencyKey,
    kind: input.kind,
    proposalDigest: input.proposalDigest,
    status: "pending" as const,
    version: GITHUB_PUBLICATION_VERSION,
  });
  if (!(await input.store.compareAndSet(input.proposalDigest, undefined, pending))) {
    throw new Error("The GitHub journal changed concurrently.");
  }
  return pending;
}

async function storeTerminal(
  store: GitHubPublicationReceiptStore,
  pending: GitHubMutationPendingReceipt,
  terminal: GitHubMutationReceipt,
): Promise<void> {
  assertCanonicalGitHubMutationReceipt(terminal);
  if (!(await store.compareAndSet(pending.proposalDigest, pending.digest, terminal))) {
    throw new GitHubOutcomeUnknownError();
  }
}

function freshSuccess(input: {
  proposal: FreshRepositoryProposal;
  pending: GitHubMutationPendingReceipt;
  readBack: FreshRepositoryReadBack;
  recovered: boolean;
}): FreshRepositorySuccessReceipt {
  assertFreshReadBack(input.readBack, input.proposal);
  return receipt({
    approvedByCallId: input.pending.approvedByCallId,
    freshHistory: true as const,
    idempotencyKey: input.proposal.idempotencyKey,
    initialCommitSha: input.readBack.initialCommit.sha,
    initialCommitTree: input.readBack.initialCommit.tree,
    installationIdentityDigest: input.proposal.installationIdentityDigest,
    kind: "fresh-repository" as const,
    parentCount: 0 as const,
    proposalDigest: input.proposal.digest,
    providerReadBackDigest: input.readBack.digest,
    recoveredFromPending: input.recovered,
    releaseGateAbsent: true as const,
    repository: input.readBack.repository,
    status: "succeeded" as const,
    version: GITHUB_PUBLICATION_VERSION,
  });
}

function draftSuccess(input: {
  proposal: DraftPullRequestProposal;
  pending: GitHubMutationPendingReceipt;
  readBack: DraftPublicationReadBack;
  recovered: boolean;
}): DraftPullRequestSuccessReceipt {
  assertDraftReadBack(input.readBack, input.proposal);
  if (
    input.readBack.branch.status !== "present" ||
    input.readBack.pullRequest.status !== "present"
  ) {
    throw new Error("The approved branch and draft pull request are not both present.");
  }
  return receipt({
    approvedByCallId: input.pending.approvedByCallId,
    baseBranch: input.readBack.pullRequest.baseBranch,
    baseSha: input.readBack.pullRequest.baseSha,
    branchName: input.readBack.branch.branchName,
    branchSha: input.readBack.branch.branchSha,
    branchTree: input.readBack.branch.branchTree,
    changeSetDigest: input.readBack.pullRequest.changeSetDigest,
    changedContentDigest: input.readBack.branch.changedContentDigest,
    draft: true as const,
    idempotencyKey: input.proposal.idempotencyKey,
    installationIdentityDigest: input.proposal.installationIdentityDigest,
    kind: "draft-pull-request" as const,
    normalizedChangedPaths: input.readBack.branch.normalizedChangedPaths,
    proposalDigest: input.proposal.digest,
    providerReadBackDigest: input.readBack.digest,
    pullRequestId: input.readBack.pullRequest.pullRequestId,
    pullRequestNumber: input.readBack.pullRequest.pullRequestNumber,
    recoveredFromPending: input.recovered,
    releaseGateUnchanged: true as const,
    repositoryId: input.proposal.repositoryId,
    status: "succeeded" as const,
    version: GITHUB_PUBLICATION_VERSION,
  });
}

/** Settle a retained pending publication only from its exact existing branch and draft PR. */
export async function reconcilePendingDraftPullRequest(input: {
  adapter: Pick<GitHubPublicationAdapter, "inspectDraftPublication">;
  pending: GitHubMutationPendingReceipt;
  proposal: DraftPullRequestProposal;
  store: GitHubPublicationReceiptStore;
}): Promise<DraftPullRequestSuccessReceipt> {
  assertExactDraftPullRequestProposal(input.proposal);
  assertCanonicalGitHubMutationReceipt(input.pending);
  if (
    input.pending.kind !== "draft-pull-request" ||
    input.pending.proposalDigest !== input.proposal.digest ||
    input.pending.idempotencyKey !== input.proposal.idempotencyKey
  ) {
    throw new Error("The GitHub journal belongs to a different proposal.");
  }
  let success: DraftPullRequestSuccessReceipt;
  try {
    success = draftSuccess({
      pending: input.pending,
      proposal: input.proposal,
      readBack: await input.adapter.inspectDraftPublication(input.proposal),
      recovered: true,
    });
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  await storeTerminal(input.store, input.pending, success);
  return success;
}

function rejectionReceipt(
  kind: MutationKind,
  pending: GitHubMutationPendingReceipt,
  code: string,
): GitHubMutationFailureReceipt {
  const safeCode = /^[a-z][a-z0-9-]{0,63}$/u.test(code) ? code : "provider-rejected";
  return receipt({
    approvedByCallId: pending.approvedByCallId,
    failureCode: "provider-rejected" as const,
    idempotencyKey: pending.idempotencyKey,
    kind,
    proposalDigest: pending.proposalDigest,
    providerCode: safeCode,
    recoveryRequired: true as const,
    status: "failed" as const,
    version: GITHUB_PUBLICATION_VERSION,
  });
}

const reclaimRejectedDraftPending = async (
  store: GitHubPublicationReceiptStore,
  failed: GitHubMutationFailureReceipt,
  approvedByCallId: string,
): Promise<GitHubMutationPendingReceipt> => {
  if (!canReclaimRejectedDraft(failed, approvedByCallId)) {
    throw new Error("The rejected draft publication requires a new approved recovery call.");
  }
  const pending = receipt({
    approvedByCallId,
    idempotencyKey: failed.idempotencyKey,
    kind: "draft-pull-request" as const,
    proposalDigest: failed.proposalDigest,
    status: "pending" as const,
    version: GITHUB_PUBLICATION_VERSION,
  });
  if (!(await store.compareAndSet(failed.proposalDigest, failed.digest, pending))) {
    throw new Error("The GitHub journal changed during approved recovery.");
  }
  return pending;
};

function canReclaimRejectedDraft(failed: GitHubMutationFailureReceipt, callId: string): boolean {
  return (
    failed.kind === "draft-pull-request" &&
    failed.failureCode === "provider-rejected" &&
    (failed.providerCode === "invalid-publication-material" ||
      failed.providerCode === "reviewed-path-changed") &&
    callId !== failed.approvedByCallId
  );
}

const publicationRejectionMessage = (
  acknowledgement: Extract<GitHubMutationAcknowledgement, { status: "rejected" }>,
): string => {
  if (acknowledgement.code === "github-file-write-failed" && "bytes" in acknowledgement) {
    const providerStatus =
      acknowledgement.providerStatus === undefined
        ? ""
        : ` (GitHub HTTP ${acknowledgement.providerStatus})`;
    if (acknowledgement.providerStatus === 413) {
      return `GitHub rejected ${acknowledgement.operation} for ${acknowledgement.path} (${acknowledgement.bytes} bytes)${providerStatus}. Check whether the file exceeds GitHub's 100 MiB per-file limit. Reduce the file and review the updated content, or request approval for Git LFS or another storage provider; then rerun validation and approve the updated publication.`;
    }
    return `GitHub could not complete ${acknowledgement.operation} for ${acknowledgement.path} (${acknowledgement.bytes} bytes)${providerStatus}. Check the repository's current GitHub limits and retry after correcting the file or provider issue; then validate and approve the updated publication.`;
  }
  if (acknowledgement.code === "reviewed-path-changed" && "path" in acknowledgement) {
    return `Reviewed content changed at ${acknowledgement.path}. Refresh the repository observation and reviewed diff, reseal the proposal, and request publication approval again.`;
  }
  return `GitHub rejected draft pull-request publication with ${acknowledgement.code}; sanitized receipt recorded.`;
};

export async function createApprovedFreshRepository(input: {
  adapter: GitHubPublicationAdapter;
  store: GitHubPublicationReceiptStore;
  proposal: FreshRepositoryProposal;
  review: ReviewedChangeSetReceipt;
  contentSource: GitHubFreshRepositoryContentSource;
  approvedByCallId: string;
}): Promise<FreshRepositorySuccessReceipt> {
  assertExactFreshRepositoryProposal(input.proposal);
  reviewForProposal(input.proposal, input.review);
  const prior = await readJournal(input.store, input.proposal, "fresh-repository");
  if (prior?.status === "succeeded") {
    if (prior.kind !== "fresh-repository") {
      throw new Error("Unreachable receipt kind.");
    }
    return prior;
  }
  if (prior?.status === "failed") {
    throw new Error("The failed GitHub mutation requires explicit recovery.");
  }
  const pending =
    prior ??
    (await claimPending({
      approvedByCallId: input.approvedByCallId,
      idempotencyKey: input.proposal.idempotencyKey,
      kind: "fresh-repository",
      proposalDigest: input.proposal.digest,
      store: input.store,
    }));
  if (pending.status !== "pending") {
    throw new Error("Unreachable journal status.");
  }
  let existing: FreshRepositoryReadBack | undefined;
  try {
    existing = await input.adapter.inspectFreshRepositoryOutcome(input.proposal);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (existing !== undefined) {
    const success = freshSuccess({
      pending,
      proposal: input.proposal,
      readBack: existing,
      recovered: true,
    });
    await storeTerminal(input.store, pending, success);
    return success;
  }
  const installation = await input.adapter.inspectInstallation("create-fresh-repository");
  assertExactInstallationIdentity(installation);
  const destination = await input.adapter.inspectDestination({
    name: input.proposal.destinationName,
    owner: input.proposal.destinationOwner,
  });
  if (
    installation.operation !== "create-fresh-repository" ||
    installation.digest !== input.proposal.installationIdentityDigest ||
    destination !== "absent"
  ) {
    throw new Error("Fresh repository preconditions changed after approval.");
  }
  const content = await readExactGitHubFreshRepositoryContent({
    proposal: input.proposal,
    source: input.contentSource,
  });
  let acknowledgement: GitHubMutationAcknowledgement;
  try {
    acknowledgement = await input.adapter.createPrivateFreshHistoryRepository(
      input.proposal,
      content,
    );
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (acknowledgement.status === "rejected") {
    const failure = rejectionReceipt("fresh-repository", pending, acknowledgement.code);
    await storeTerminal(input.store, pending, failure);
    throw new Error("GitHub rejected repository creation; sanitized receipt recorded.");
  }
  if (!/^[-A-Za-z0-9_]{1,128}$/u.test(acknowledgement.requestId)) {
    throw new GitHubOutcomeUnknownError();
  }
  let readBack: FreshRepositoryReadBack | undefined;
  try {
    readBack = await input.adapter.inspectFreshRepositoryOutcome(input.proposal);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (readBack === undefined) {
    throw new GitHubOutcomeUnknownError();
  }
  let success: FreshRepositorySuccessReceipt;
  try {
    success = freshSuccess({
      pending,
      proposal: input.proposal,
      readBack,
      recovered: false,
    });
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  await storeTerminal(input.store, pending, success);
  return success;
}

export const publishApprovedDraftPullRequest = async (input: {
  adapter: GitHubPublicationAdapter;
  store: GitHubPublicationReceiptStore;
  proposal: DraftPullRequestProposal;
  review: ReviewedChangeSetReceipt;
  contentSource: GitHubDraftPullRequestContentSource;
  approvedByCallId: string;
}): Promise<DraftPullRequestSuccessReceipt> => {
  assertExactDraftPullRequestProposal(input.proposal);
  reviewForProposal(input.proposal, input.review);
  const prior = await readJournal(input.store, input.proposal, "draft-pull-request");
  if (prior?.status === "succeeded") {
    if (prior.kind !== "draft-pull-request") {
      throw new Error("Unreachable receipt kind.");
    }
    return prior;
  }
  if (prior?.status === "failed" && !canReclaimRejectedDraft(prior, input.approvedByCallId)) {
    throw new Error(
      `The failed GitHub mutation (${prior.providerCode}) requires explicit recovery. Inspect its provider result before another publication attempt.`,
    );
  }
  let observed: DraftPublicationReadBack | undefined;
  if (prior?.status === "failed") {
    if (input.approvedByCallId === prior.approvedByCallId) {
      throw new Error("The rejected draft publication requires a new approved recovery call.");
    }
    // These draft-publication rejections occur before provider writes. Verify
    // absence independently before reclaiming the failed journal receipt.
    try {
      observed = await input.adapter.inspectDraftPublication(input.proposal);
    } catch {
      throw new GitHubOutcomeUnknownError();
    }
    assertDraftReadBack(observed, input.proposal);
    if (observed.branch.status !== "absent" || observed.pullRequest.status !== "absent") {
      throw new Error(
        "Rejected draft publication recovery requires verified absence of its branch and pull request. Inspect the existing GitHub outcome before another publication attempt.",
      );
    }
  }
  const pending =
    prior?.status === "failed"
      ? await reclaimRejectedDraftPending(input.store, prior, input.approvedByCallId)
      : (prior ??
        (await claimPending({
          approvedByCallId: input.approvedByCallId,
          idempotencyKey: input.proposal.idempotencyKey,
          kind: "draft-pull-request",
          proposalDigest: input.proposal.digest,
          store: input.store,
        })));
  if (pending.status !== "pending") {
    throw new Error("Unreachable journal status.");
  }
  if (observed === undefined) {
    try {
      observed = await input.adapter.inspectDraftPublication(input.proposal);
    } catch {
      throw new GitHubOutcomeUnknownError();
    }
  }
  assertDraftReadBack(observed, input.proposal);
  if (observed.pullRequest.status === "present") {
    const success = draftSuccess({
      pending,
      proposal: input.proposal,
      readBack: observed,
      recovered: true,
    });
    await storeTerminal(input.store, pending, success);
    return success;
  }
  if (observed.branch.status === "present") {
    throw new Error("A branch collision exists without the approved draft pull request.");
  }
  const installation = await input.adapter.inspectInstallation("publish-draft-pull-request");
  assertExactInstallationIdentity(installation);
  if (
    installation.operation !== "publish-draft-pull-request" ||
    installation.digest !== input.proposal.installationIdentityDigest ||
    !installation.selectedRepositoryIds.includes(input.proposal.repositoryId)
  ) {
    throw new Error("Draft pull-request installation authority changed.");
  }
  const content = await readExactGitHubPublicationContent({
    proposal: input.proposal,
    review: input.review,
    source: input.contentSource,
  });
  let acknowledgement: GitHubMutationAcknowledgement;
  try {
    acknowledgement = await input.adapter.publishDraftPullRequest(input.proposal, content);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (acknowledgement.status === "rejected") {
    const failure = rejectionReceipt("draft-pull-request", pending, acknowledgement.code);
    await storeTerminal(input.store, pending, failure);
    throw new Error(publicationRejectionMessage(acknowledgement));
  }
  if (!/^[-A-Za-z0-9_]{1,128}$/u.test(acknowledgement.requestId)) {
    throw new GitHubOutcomeUnknownError();
  }
  try {
    observed = await input.adapter.inspectDraftPublication(input.proposal);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  let success: DraftPullRequestSuccessReceipt;
  try {
    success = draftSuccess({
      pending,
      proposal: input.proposal,
      readBack: observed,
      recovered: false,
    });
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  await storeTerminal(input.store, pending, success);
  return success;
};
