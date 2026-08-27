import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import {
  parseSourceReceiptEvidence,
  type SourceReceiptEvidence,
} from "./source-receipt";
import { safeSourcePath } from "./source-path";

export const GITHUB_PUBLICATION_VERSION = 2 as const;
export const REPOSITORY_RELEASE_GATE = "REPOSITORY_RELEASE_ENABLED" as const;

type Digest = string;
type ObjectId = string;
export type GitHubOperation =
  | "resolve-existing-source"
  | "create-fresh-repository"
  | "publish-draft-pull-request";

type GitHubPermissions = {
  metadata: "read";
  contents: "read" | "write";
  pullRequests: "none" | "write";
  administration: "none" | "write";
  variables: "read";
};

export type GitHubInstallationIdentity = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  operation: GitHubOperation;
  installationId: string;
  accountId: string;
  accountLogin: string;
  accountType: "Organization" | "User";
  repositorySelection: "selected";
  selectedRepositoryIds: readonly string[];
  permissions: GitHubPermissions;
  digest: Digest;
};

export type GitHubRepositoryObservation = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  repositoryId: string;
  owner: string;
  name: string;
  visibility: "private";
  defaultBranch: string;
  headSha: ObjectId;
  headTree: ObjectId;
  installationIdentityDigest: Digest;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: false;
  };
  digest: Digest;
};

export type ImmutableGitHubSourceReceipt = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  repository: GitHubRepositoryObservation;
  resolvedRef: string;
  resolvedSha: ObjectId;
  resolvedTree: ObjectId;
  installationIdentityDigest: Digest;
  resolvedByCallId: string;
  digest: Digest;
};

export type FreshRepositoryProposal = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  installationIdentityDigest: Digest;
  destinationOwner: string;
  destinationName: string;
  visibility: "private";
  defaultBranch: "main";
  sourceReceiptDigest: Digest;
  sourceSha: ObjectId;
  sourceTree: ObjectId;
  contractDigest: Digest;
  eligibilityDigest: Digest;
  reviewDigest: Digest;
  changeSetDigest: Digest;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: false;
  };
  initialCommitMessage: "Initialize repository from supported template";
  idempotencyKey: Digest;
  intendedOutcome: "create-private-fresh-history-repository";
  digest: Digest;
};

export type DraftPullRequestProposal = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  installationIdentityDigest: Digest;
  repositoryId: string;
  owner: string;
  name: string;
  visibility: "private";
  baseBranch: string;
  baseSha: ObjectId;
  baseTree: ObjectId;
  repositoryObservationDigest: Digest;
  releaseGate: {
    name: typeof REPOSITORY_RELEASE_GATE;
    configured: false;
  };
  reviewDigest: Digest;
  changeSetDigest: Digest;
  changedContentDigest: Digest;
  approvedPaths: readonly string[];
  branchName: string;
  draft: true;
  title: string;
  idempotencyKey: Digest;
  intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request";
  digest: Digest;
};

type MutationKind = "fresh-repository" | "draft-pull-request";

export type GitHubMutationPendingReceipt = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: MutationKind;
  status: "pending";
  proposalDigest: Digest;
  idempotencyKey: Digest;
  approvedByCallId: string;
  digest: Digest;
};

export type GitHubMutationFailureReceipt = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: MutationKind;
  status: "failed";
  proposalDigest: Digest;
  idempotencyKey: Digest;
  approvedByCallId: string;
  failureCode: "provider-rejected" | "postcondition-failed";
  providerCode: string;
  recoveryRequired: true;
  digest: Digest;
};

export type FreshRepositorySuccessReceipt = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: "fresh-repository";
  status: "succeeded";
  proposalDigest: Digest;
  idempotencyKey: Digest;
  approvedByCallId: string;
  installationIdentityDigest: Digest;
  repository: GitHubRepositoryObservation;
  initialCommitSha: ObjectId;
  initialCommitTree: ObjectId;
  parentCount: 0;
  freshHistory: true;
  releaseGateAbsent: true;
  recoveredFromPending: boolean;
  providerReadBackDigest: Digest;
  digest: Digest;
};

export type DraftPullRequestSuccessReceipt = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  kind: "draft-pull-request";
  status: "succeeded";
  proposalDigest: Digest;
  idempotencyKey: Digest;
  approvedByCallId: string;
  installationIdentityDigest: Digest;
  repositoryId: string;
  branchName: string;
  branchSha: ObjectId;
  branchTree: ObjectId;
  pullRequestId: string;
  pullRequestNumber: number;
  draft: true;
  baseBranch: string;
  baseSha: ObjectId;
  changeSetDigest: Digest;
  changedContentDigest: Digest;
  normalizedChangedPaths: readonly string[];
  releaseGateAbsent: true;
  recoveredFromPending: boolean;
  providerReadBackDigest: Digest;
  digest: Digest;
};

export type GitHubMutationReceipt =
  | GitHubMutationPendingReceipt
  | GitHubMutationFailureReceipt
  | FreshRepositorySuccessReceipt
  | DraftPullRequestSuccessReceipt;

export type FreshRepositoryReadBack = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  idempotencyKey: Digest;
  repository: GitHubRepositoryObservation;
  initialCommit: { sha: ObjectId; tree: ObjectId; parents: readonly [] };
  digest: Digest;
};

type AbsentBranch = { status: "absent" };
type PresentBranch = {
  status: "present";
  branchName: string;
  branchSha: ObjectId;
  branchTree: ObjectId;
  normalizedChangedPaths: readonly string[];
  changedContentDigest: Digest;
  idempotencyKey: Digest;
};
type AbsentPullRequest = { status: "absent" };
type PresentPullRequest = {
  status: "present";
  pullRequestId: string;
  pullRequestNumber: number;
  draft: boolean;
  headRepositoryId: string;
  headBranch: string;
  headSha: ObjectId;
  baseRepositoryId: string;
  baseBranch: string;
  baseSha: ObjectId;
  changeSetDigest: Digest;
  idempotencyKey: Digest;
};

export type DraftPublicationReadBack = {
  version: typeof GITHUB_PUBLICATION_VERSION;
  idempotencyKey: Digest;
  repository: GitHubRepositoryObservation;
  changedPathsSinceBase: readonly string[];
  branch: AbsentBranch | PresentBranch;
  pullRequest: AbsentPullRequest | PresentPullRequest;
  digest: Digest;
};

export type GitHubMutationAcknowledgement =
  | { status: "accepted"; requestId: string }
  | { status: "rejected"; code: string };

export interface GitHubPublicationAdapter {
  inspectInstallation(
    operation: GitHubOperation,
  ): Promise<GitHubInstallationIdentity>;
  inspectRepository(input: {
    repositoryId: string;
    ref: string;
  }): Promise<GitHubRepositoryObservation>;
  inspectDestination(input: {
    owner: string;
    name: string;
  }): Promise<"absent" | GitHubRepositoryObservation>;
  inspectFreshRepositoryOutcome(
    proposal: FreshRepositoryProposal,
  ): Promise<FreshRepositoryReadBack | undefined>;
  createPrivateFreshHistoryRepository(
    proposal: FreshRepositoryProposal,
  ): Promise<GitHubMutationAcknowledgement>;
  inspectDraftPublication(
    proposal: DraftPullRequestProposal,
  ): Promise<DraftPublicationReadBack>;
  publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
  ): Promise<GitHubMutationAcknowledgement>;
}

export interface GitHubPublicationReceiptStore {
  read(proposalDigest: string): Promise<GitHubMutationReceipt | undefined>;
  compareAndSet(
    proposalDigest: string,
    expectedDigest: string | undefined,
    receipt: GitHubMutationReceipt,
  ): Promise<boolean>;
}

export class GitHubOutcomeUnknownError extends Error {
  constructor() {
    super(
      "GitHub mutation outcome is unknown; durable intent remains pending.",
    );
  }
}

const digest = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(value: unknown, keys: readonly string[]): boolean {
  return (
    record(value) &&
    Object.keys(value).toSorted().join("\0") === [...keys].toSorted().join("\0")
  );
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function isObjectId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    (/^[0-9a-f]{40}$/u.test(value) || /^[0-9a-f]{64}$/u.test(value))
  );
}

function isDecimal(value: unknown): value is string {
  return typeof value === "string" && /^[1-9]\d*$/u.test(value);
}

function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,98}[A-Za-z0-9])?$/u.test(value) &&
    value !== "." &&
    value !== ".." &&
    !value.endsWith(".git")
  );
}

function safeBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 200 &&
    !value.startsWith("/") &&
    !value.endsWith("/") &&
    !value.endsWith(".") &&
    !value.endsWith(".lock") &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !/[~^:?*[\\\s\x00-\x1f\x7f]/u.test(value) &&
    value.split("/").every((part) => part.length > 0 && !part.startsWith("."))
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
  if (
    !isDigest(value.digest) ||
    digest(canonicalWithoutDigest(value)) !== value.digest
  )
    throw new Error(`${label} digest is malformed.`);
}

export function githubPermissionsFor(
  operation: GitHubOperation,
): GitHubPermissions {
  switch (operation) {
    case "resolve-existing-source":
      return {
        metadata: "read",
        contents: "read",
        pullRequests: "none",
        administration: "none",
        variables: "read",
      };
    case "create-fresh-repository":
      return {
        metadata: "read",
        contents: "write",
        pullRequests: "none",
        administration: "write",
        variables: "read",
      };
    case "publish-draft-pull-request":
      return {
        metadata: "read",
        contents: "write",
        pullRequests: "write",
        administration: "none",
        variables: "read",
      };
  }
}

function pathsOverlap(left: string, right: string): boolean {
  return (
    left === right ||
    left.startsWith(`${right}/`) ||
    right.startsWith(`${left}/`)
  );
}

function canonicalPaths(paths: readonly string[]): readonly string[] {
  if (
    paths.length === 0 ||
    new Set(paths).size !== paths.length ||
    paths.some((path) => !safeSourcePath(path))
  )
    throw new Error("GitHub publication paths are unsafe or duplicated.");
  return [...paths].toSorted();
}

function canonicalPathsOrEmpty(paths: readonly string[]): readonly string[] {
  if (paths.length === 0) return [];
  return canonicalPaths(paths);
}

function releaseGateAbsent(repository: GitHubRepositoryObservation): boolean {
  return (
    repository.releaseGate.name === REPOSITORY_RELEASE_GATE &&
    repository.releaseGate.configured === false
  );
}

function assertCanonicalReview(review: ReviewedChangeSetReceipt): void {
  const changeSet = { ...review } as Record<string, unknown>;
  delete changeSet.changeSetDigest;
  delete changeSet.reviewedByCallId;
  changeSet.digest = review.changeSetDigest;
  const sortedChanges = [...review.changes].toSorted((left, right) =>
    left.path.localeCompare(right.path),
  );
  if (
    !isDigest(review.changeSetDigest) ||
    digest(canonicalWithoutDigest(changeSet as { digest: string })) !==
      review.changeSetDigest ||
    digest({
      ...changeSet,
      changeSetDigest: review.changeSetDigest,
      reviewedByCallId: review.reviewedByCallId,
    }) !== review.digest ||
    JSON.stringify(review.changes) !== JSON.stringify(sortedChanges) ||
    JSON.stringify(canonicalPaths(review.approvedPaths)) !==
      JSON.stringify(review.approvedPaths) ||
    JSON.stringify(review.approvedPaths) !==
      JSON.stringify(review.changes.map(({ path }) => path))
  )
    throw new Error("The reviewed change-set receipt is non-canonical.");
}

function assertReviewedBinding(
  source: SourceReceiptEvidence,
  review: ReviewedChangeSetReceipt,
): void {
  parseSourceReceiptEvidence(source);
  assertCanonicalReview(review);
  if (
    source.releaseEnabled !== false ||
    source.sourceSha !== review.sourceSha ||
    source.sourceTree !== review.sourceTree ||
    source.contractDigest !== review.repositoryContractDigest ||
    source.eligibilityDigest !== review.eligibilityDigest
  )
    throw new Error(
      "The reviewed change set is not bound to the exact source receipt.",
    );
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
  "pullRequests",
  "administration",
  "variables",
] as const;

export function createGitHubInstallationIdentity(
  input: Omit<GitHubInstallationIdentity, "version" | "permissions" | "digest">,
): GitHubInstallationIdentity {
  if (
    (input.operation !== "resolve-existing-source" &&
      input.operation !== "create-fresh-repository" &&
      input.operation !== "publish-draft-pull-request") ||
    !isDecimal(input.installationId) ||
    !isDecimal(input.accountId) ||
    !safeName(input.accountLogin) ||
    (input.accountType !== "Organization" && input.accountType !== "User") ||
    input.repositorySelection !== "selected" ||
    !Array.isArray(input.selectedRepositoryIds) ||
    new Set(input.selectedRepositoryIds).size !==
      input.selectedRepositoryIds.length ||
    input.selectedRepositoryIds.some((id) => !isDecimal(id))
  )
    throw new Error("The GitHub installation identity is invalid.");
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    operation: input.operation,
    installationId: input.installationId,
    accountId: input.accountId,
    accountLogin: input.accountLogin,
    accountType: input.accountType,
    repositorySelection: "selected" as const,
    selectedRepositoryIds: [...input.selectedRepositoryIds].toSorted(),
    permissions: githubPermissionsFor(input.operation),
  };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactInstallationIdentity(
  identity: GitHubInstallationIdentity,
): void {
  if (
    !exactKeys(identity, installationKeys) ||
    !exactKeys(identity.permissions, permissionKeys)
  )
    throw new Error("The GitHub installation identity schema is not closed.");
  const rebuilt = createGitHubInstallationIdentity({
    operation: identity.operation,
    installationId: identity.installationId,
    accountId: identity.accountId,
    accountLogin: identity.accountLogin,
    accountType: identity.accountType,
    repositorySelection: identity.repositorySelection,
    selectedRepositoryIds: identity.selectedRepositoryIds,
  });
  if (JSON.stringify(identity) !== JSON.stringify(rebuilt))
    throw new Error(
      "The GitHub installation identity is non-canonical or over-privileged.",
    );
}

const repositoryKeys = [
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
  if (
    !isDecimal(input.repositoryId) ||
    !safeName(input.owner) ||
    !safeName(input.name) ||
    input.visibility !== "private" ||
    !safeBranch(input.defaultBranch) ||
    !isObjectId(input.headSha) ||
    !isObjectId(input.headTree) ||
    !isDigest(input.installationIdentityDigest) ||
    !exactKeys(input.releaseGate, ["name", "configured"]) ||
    input.releaseGate.name !== REPOSITORY_RELEASE_GATE ||
    input.releaseGate.configured !== false
  )
    throw new Error(
      "The repository observation is invalid or release-enabled.",
    );
  const unsigned = { version: GITHUB_PUBLICATION_VERSION, ...input };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactRepositoryObservation(
  repository: GitHubRepositoryObservation,
): void {
  if (!exactKeys(repository, repositoryKeys))
    throw new Error("The repository observation schema is not closed.");
  const rebuilt = createRepositoryObservation({
    repositoryId: repository.repositoryId,
    owner: repository.owner,
    name: repository.name,
    visibility: repository.visibility,
    defaultBranch: repository.defaultBranch,
    headSha: repository.headSha,
    headTree: repository.headTree,
    installationIdentityDigest: repository.installationIdentityDigest,
    releaseGate: repository.releaseGate,
  });
  if (JSON.stringify(repository) !== JSON.stringify(rebuilt))
    throw new Error("The repository observation is non-canonical.");
}

export async function resolveImmutableExistingSource(input: {
  adapter: GitHubPublicationAdapter;
  repositoryId: string;
  ref: string;
  expectedSha: ObjectId;
  expectedTree: ObjectId;
  resolvedByCallId: string;
}): Promise<ImmutableGitHubSourceReceipt> {
  if (
    !isDecimal(input.repositoryId) ||
    !safeHeadRef(input.ref) ||
    !isObjectId(input.expectedSha) ||
    !isObjectId(input.expectedTree)
  )
    throw new Error("The immutable source request is invalid.");
  const installation = await input.adapter.inspectInstallation(
    "resolve-existing-source",
  );
  assertExactInstallationIdentity(installation);
  if (
    installation.operation !== "resolve-existing-source" ||
    !installation.selectedRepositoryIds.includes(input.repositoryId)
  )
    throw new Error("The installation is not selected for source resolution.");
  const repository = await input.adapter.inspectRepository({
    repositoryId: input.repositoryId,
    ref: input.ref,
  });
  assertExactRepositoryObservation(repository);
  if (
    repository.installationIdentityDigest !== installation.digest ||
    repository.repositoryId !== input.repositoryId ||
    repository.headSha !== input.expectedSha ||
    repository.headTree !== input.expectedTree ||
    !releaseGateAbsent(repository)
  )
    throw new Error(
      "The GitHub source changed or is outside the approved installation.",
    );
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    repository,
    resolvedRef: input.ref,
    resolvedSha: repository.headSha,
    resolvedTree: repository.headTree,
    installationIdentityDigest: installation.digest,
    resolvedByCallId: input.resolvedByCallId,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

const freshProposalKeys = [
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
  )
    throw new Error(
      "Fresh repository creation is outside the approved destination.",
    );
  const idempotencyKey = digest({
    installationIdentityDigest: input.installation.digest,
    destinationOwner: input.destinationOwner,
    destinationName: input.destinationName,
    sourceReceiptDigest: input.source.digest,
    reviewDigest: input.review.digest,
  });
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    installationIdentityDigest: input.installation.digest,
    destinationOwner: input.destinationOwner,
    destinationName: input.destinationName,
    visibility: "private" as const,
    defaultBranch: "main" as const,
    sourceReceiptDigest: input.source.digest,
    sourceSha: input.source.sourceSha,
    sourceTree: input.source.sourceTree,
    contractDigest: input.source.contractDigest,
    eligibilityDigest: input.source.eligibilityDigest,
    reviewDigest: input.review.digest,
    changeSetDigest: input.review.changeSetDigest,
    releaseGate: { name: REPOSITORY_RELEASE_GATE, configured: false as const },
    initialCommitMessage:
      "Initialize repository from supported template" as const,
    idempotencyKey,
    intendedOutcome: "create-private-fresh-history-repository" as const,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactFreshRepositoryProposal(
  proposal: FreshRepositoryProposal,
): void {
  if (
    !exactKeys(proposal, freshProposalKeys) ||
    !exactKeys(proposal.releaseGate, ["name", "configured"])
  )
    throw new Error("The fresh repository proposal schema is not closed.");
  exactDigest(proposal, "Fresh repository proposal");
  const expectedKey = digest({
    installationIdentityDigest: proposal.installationIdentityDigest,
    destinationOwner: proposal.destinationOwner,
    destinationName: proposal.destinationName,
    sourceReceiptDigest: proposal.sourceReceiptDigest,
    reviewDigest: proposal.reviewDigest,
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
    proposal.releaseGate.configured !== false ||
    proposal.initialCommitMessage !==
      "Initialize repository from supported template" ||
    proposal.intendedOutcome !== "create-private-fresh-history-repository" ||
    proposal.idempotencyKey !== expectedKey
  )
    throw new Error("The fresh repository proposal is malformed.");
}

const draftProposalKeys = [
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
    !/[\r\n\x00-\x1f\x7f]/u.test(value)
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
  const concurrentPaths = canonicalPathsOrEmpty(input.changedPathsSinceBase);
  if (
    input.installation.operation !== "publish-draft-pull-request" ||
    !input.installation.selectedRepositoryIds.includes(
      input.repository.repositoryId,
    ) ||
    input.repository.installationIdentityDigest !== input.installation.digest ||
    input.repository.headSha !== input.review.sourceSha ||
    input.repository.headTree !== input.review.sourceTree ||
    concurrentPaths.some((path) =>
      approvedPaths.some((approved) => pathsOverlap(path, approved)),
    ) ||
    !safeTitle(input.title)
  )
    throw new Error(
      "The draft pull-request proposal is stale, overlapping, or unauthorized.",
    );
  const idempotencyKey = digest({
    installationIdentityDigest: input.installation.digest,
    repositoryObservationDigest: input.repository.digest,
    reviewDigest: input.review.digest,
  });
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    installationIdentityDigest: input.installation.digest,
    repositoryId: input.repository.repositoryId,
    owner: input.repository.owner,
    name: input.repository.name,
    visibility: "private" as const,
    baseBranch: input.repository.defaultBranch,
    baseSha: input.repository.headSha,
    baseTree: input.repository.headTree,
    repositoryObservationDigest: input.repository.digest,
    releaseGate: { name: REPOSITORY_RELEASE_GATE, configured: false as const },
    reviewDigest: input.review.digest,
    changeSetDigest: input.review.changeSetDigest,
    changedContentDigest: input.review.changedContentDigest,
    approvedPaths,
    branchName: `app-builder/review-${idempotencyKey.slice(0, 20)}`,
    draft: true as const,
    title: input.title,
    idempotencyKey,
    intendedOutcome:
      "publish-reviewed-change-set-as-draft-pull-request" as const,
  };
  return { ...unsigned, digest: digest(unsigned) };
}

export function assertExactDraftPullRequestProposal(
  proposal: DraftPullRequestProposal,
): void {
  if (
    !exactKeys(proposal, draftProposalKeys) ||
    !exactKeys(proposal.releaseGate, ["name", "configured"])
  )
    throw new Error("The draft pull-request proposal schema is not closed.");
  exactDigest(proposal, "Draft pull-request proposal");
  const idempotencyKey = digest({
    installationIdentityDigest: proposal.installationIdentityDigest,
    repositoryObservationDigest: proposal.repositoryObservationDigest,
    reviewDigest: proposal.reviewDigest,
  });
  if (
    proposal.version !== GITHUB_PUBLICATION_VERSION ||
    !isDecimal(proposal.repositoryId) ||
    !safeName(proposal.owner) ||
    !safeName(proposal.name) ||
    proposal.visibility !== "private" ||
    !safeBranch(proposal.baseBranch) ||
    !isObjectId(proposal.baseSha) ||
    !isObjectId(proposal.baseTree) ||
    !isDigest(proposal.repositoryObservationDigest) ||
    proposal.releaseGate.name !== REPOSITORY_RELEASE_GATE ||
    proposal.releaseGate.configured !== false ||
    !isDigest(proposal.reviewDigest) ||
    !isDigest(proposal.changeSetDigest) ||
    !isDigest(proposal.changedContentDigest) ||
    JSON.stringify(canonicalPaths(proposal.approvedPaths)) !==
      JSON.stringify(proposal.approvedPaths) ||
    !safeBranch(proposal.branchName) ||
    proposal.draft !== true ||
    !safeTitle(proposal.title) ||
    proposal.idempotencyKey !== idempotencyKey ||
    proposal.branchName !==
      `app-builder/review-${idempotencyKey.slice(0, 20)}` ||
    proposal.intendedOutcome !==
      "publish-reviewed-change-set-as-draft-pull-request"
  )
    throw new Error("The draft pull-request proposal is malformed.");
}

function assertFreshReadBack(
  readBack: FreshRepositoryReadBack,
  proposal: FreshRepositoryProposal,
): void {
  if (
    !exactKeys(readBack, [
      "version",
      "idempotencyKey",
      "repository",
      "initialCommit",
      "digest",
    ]) ||
    !exactKeys(readBack.initialCommit, ["sha", "tree", "parents"]) ||
    !Array.isArray(readBack.initialCommit.parents) ||
    readBack.initialCommit.parents.length !== 0
  )
    throw new Error(
      "Fresh repository provider read-back schema is not closed.",
    );
  exactDigest(readBack, "Fresh repository provider read-back");
  assertExactRepositoryObservation(readBack.repository);
  if (
    readBack.version !== GITHUB_PUBLICATION_VERSION ||
    readBack.idempotencyKey !== proposal.idempotencyKey ||
    readBack.repository.installationIdentityDigest !==
      proposal.installationIdentityDigest ||
    readBack.repository.owner !== proposal.destinationOwner ||
    readBack.repository.name !== proposal.destinationName ||
    readBack.repository.visibility !== "private" ||
    readBack.repository.defaultBranch !== proposal.defaultBranch ||
    readBack.repository.headSha !== readBack.initialCommit.sha ||
    readBack.repository.headTree !== readBack.initialCommit.tree ||
    readBack.initialCommit.tree !== proposal.sourceTree ||
    !releaseGateAbsent(readBack.repository)
  )
    throw new Error(
      "Fresh repository provider read-back does not match the proposal.",
    );
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
  )
    throw new Error(
      "Draft publication provider read-back schema is not closed.",
    );
  exactDigest(readBack, "Draft publication provider read-back");
  assertExactRepositoryObservation(readBack.repository);
  if (
    readBack.version !== GITHUB_PUBLICATION_VERSION ||
    readBack.idempotencyKey !== proposal.idempotencyKey ||
    readBack.repository.digest !== proposal.repositoryObservationDigest ||
    readBack.repository.repositoryId !== proposal.repositoryId ||
    readBack.repository.headSha !== proposal.baseSha ||
    readBack.repository.headTree !== proposal.baseTree ||
    !releaseGateAbsent(readBack.repository) ||
    JSON.stringify(canonicalPathsOrEmpty(readBack.changedPathsSinceBase)) !==
      JSON.stringify(readBack.changedPathsSinceBase) ||
    canonicalPathsOrEmpty(readBack.changedPathsSinceBase).some((path) =>
      proposal.approvedPaths.some((approved) => pathsOverlap(path, approved)),
    )
  )
    throw new Error(
      "Draft publication provider read-back is stale or overlapping.",
    );
  if (readBack.branch.status === "absent") {
    if (!exactKeys(readBack.branch, ["status"]))
      throw new Error("Absent branch read-back schema is not closed.");
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
  )
    throw new Error(
      "Branch provider read-back does not match the approved change set.",
    );
  if (readBack.pullRequest.status === "absent") {
    if (!exactKeys(readBack.pullRequest, ["status"]))
      throw new Error("Absent pull-request read-back schema is not closed.");
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
    readBack.pullRequest.draft !== true ||
    readBack.pullRequest.headRepositoryId !== proposal.repositoryId ||
    readBack.pullRequest.headBranch !== proposal.branchName ||
    readBack.pullRequest.baseRepositoryId !== proposal.repositoryId ||
    readBack.pullRequest.baseBranch !== proposal.baseBranch ||
    readBack.pullRequest.baseSha !== proposal.baseSha ||
    readBack.pullRequest.changeSetDigest !== proposal.changeSetDigest ||
    readBack.pullRequest.idempotencyKey !== proposal.idempotencyKey ||
    (readBack.branch.status === "present" &&
      readBack.pullRequest.headSha !== readBack.branch.branchSha)
  )
    throw new Error(
      "Pull-request provider read-back does not match the proposal.",
    );
}

function receipt<T extends Omit<GitHubMutationReceipt, "digest">>(
  value: T,
): T & { digest: string } {
  return { ...value, digest: digest(value) };
}

export function assertCanonicalGitHubMutationReceipt(
  value: GitHubMutationReceipt,
): void {
  const common = [
    "version",
    "kind",
    "status",
    "proposalDigest",
    "idempotencyKey",
    "approvedByCallId",
  ];
  const extra =
    value.status === "pending"
      ? []
      : value.status === "failed"
        ? ["failureCode", "providerCode", "recoveryRequired"]
        : value.kind === "fresh-repository"
          ? [
              "installationIdentityDigest",
              "repository",
              "initialCommitSha",
              "initialCommitTree",
              "parentCount",
              "freshHistory",
              "releaseGateAbsent",
              "recoveredFromPending",
              "providerReadBackDigest",
            ]
          : [
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
              "releaseGateAbsent",
              "recoveredFromPending",
              "providerReadBackDigest",
            ];
  if (!exactKeys(value, [...common, ...extra, "digest"]))
    throw new Error("GitHub mutation receipt schema is not closed.");
  exactDigest(value, "GitHub mutation receipt");
  if (
    value.version !== GITHUB_PUBLICATION_VERSION ||
    !isDigest(value.proposalDigest) ||
    !isDigest(value.idempotencyKey) ||
    typeof value.approvedByCallId !== "string" ||
    value.approvedByCallId.length === 0 ||
    (value.kind !== "fresh-repository" && value.kind !== "draft-pull-request")
  )
    throw new Error("GitHub mutation receipt bindings are invalid.");
  if (value.status === "failed") {
    if (
      (value.failureCode !== "provider-rejected" &&
        value.failureCode !== "postcondition-failed") ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.providerCode) ||
      value.recoveryRequired !== true
    )
      throw new Error("GitHub failure receipt is invalid.");
  } else if (value.status === "succeeded") {
    if (
      !isDigest(value.providerReadBackDigest) ||
      !isDigest(value.installationIdentityDigest) ||
      value.releaseGateAbsent !== true
    )
      throw new Error("GitHub success receipt read-back binding is invalid.");
    if (value.kind === "fresh-repository") {
      assertExactRepositoryObservation(value.repository);
      if (
        value.installationIdentityDigest !==
          value.repository.installationIdentityDigest ||
        value.parentCount !== 0 ||
        value.freshHistory !== true ||
        value.initialCommitSha !== value.repository.headSha ||
        value.initialCommitTree !== value.repository.headTree
      )
        throw new Error("Fresh repository success receipt is invalid.");
    } else if (
      !isDecimal(value.repositoryId) ||
      !safeBranch(value.branchName) ||
      !isObjectId(value.branchSha) ||
      !isObjectId(value.branchTree) ||
      !isDecimal(value.pullRequestId) ||
      !Number.isSafeInteger(value.pullRequestNumber) ||
      value.pullRequestNumber < 1 ||
      value.draft !== true ||
      !safeBranch(value.baseBranch) ||
      !isObjectId(value.baseSha) ||
      !isDigest(value.changeSetDigest) ||
      !isDigest(value.changedContentDigest) ||
      JSON.stringify(canonicalPaths(value.normalizedChangedPaths)) !==
        JSON.stringify(value.normalizedChangedPaths)
    )
      throw new Error("Draft pull-request success receipt is invalid.");
  } else if (value.status !== "pending") {
    throw new Error("GitHub mutation receipt status is invalid.");
  }
}

async function readJournal(
  store: GitHubPublicationReceiptStore,
  proposal: { digest: string; idempotencyKey: string },
  kind: MutationKind,
): Promise<GitHubMutationReceipt | undefined> {
  const value = await store.read(proposal.digest);
  if (value === undefined) return undefined;
  assertCanonicalGitHubMutationReceipt(value);
  if (
    value.kind !== kind ||
    value.proposalDigest !== proposal.digest ||
    value.idempotencyKey !== proposal.idempotencyKey
  )
    throw new Error("The GitHub journal belongs to a different proposal.");
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
    version: GITHUB_PUBLICATION_VERSION,
    kind: input.kind,
    status: "pending" as const,
    proposalDigest: input.proposalDigest,
    idempotencyKey: input.idempotencyKey,
    approvedByCallId: input.approvedByCallId,
  });
  if (
    !(await input.store.compareAndSet(input.proposalDigest, undefined, pending))
  )
    throw new Error("The GitHub journal changed concurrently.");
  return pending;
}

async function storeTerminal(
  store: GitHubPublicationReceiptStore,
  pending: GitHubMutationPendingReceipt,
  terminal: GitHubMutationReceipt,
): Promise<void> {
  assertCanonicalGitHubMutationReceipt(terminal);
  if (
    !(await store.compareAndSet(
      pending.proposalDigest,
      pending.digest,
      terminal,
    ))
  )
    throw new GitHubOutcomeUnknownError();
}

function freshSuccess(input: {
  proposal: FreshRepositoryProposal;
  pending: GitHubMutationPendingReceipt;
  readBack: FreshRepositoryReadBack;
  recovered: boolean;
}): FreshRepositorySuccessReceipt {
  assertFreshReadBack(input.readBack, input.proposal);
  return receipt({
    version: GITHUB_PUBLICATION_VERSION,
    kind: "fresh-repository" as const,
    status: "succeeded" as const,
    proposalDigest: input.proposal.digest,
    idempotencyKey: input.proposal.idempotencyKey,
    approvedByCallId: input.pending.approvedByCallId,
    installationIdentityDigest: input.proposal.installationIdentityDigest,
    repository: input.readBack.repository,
    initialCommitSha: input.readBack.initialCommit.sha,
    initialCommitTree: input.readBack.initialCommit.tree,
    parentCount: 0 as const,
    freshHistory: true as const,
    releaseGateAbsent: true as const,
    recoveredFromPending: input.recovered,
    providerReadBackDigest: input.readBack.digest,
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
  )
    throw new Error(
      "The approved branch and draft pull request are not both present.",
    );
  return receipt({
    version: GITHUB_PUBLICATION_VERSION,
    kind: "draft-pull-request" as const,
    status: "succeeded" as const,
    proposalDigest: input.proposal.digest,
    idempotencyKey: input.proposal.idempotencyKey,
    approvedByCallId: input.pending.approvedByCallId,
    installationIdentityDigest: input.proposal.installationIdentityDigest,
    repositoryId: input.proposal.repositoryId,
    branchName: input.readBack.branch.branchName,
    branchSha: input.readBack.branch.branchSha,
    branchTree: input.readBack.branch.branchTree,
    pullRequestId: input.readBack.pullRequest.pullRequestId,
    pullRequestNumber: input.readBack.pullRequest.pullRequestNumber,
    draft: true as const,
    baseBranch: input.readBack.pullRequest.baseBranch,
    baseSha: input.readBack.pullRequest.baseSha,
    changeSetDigest: input.readBack.pullRequest.changeSetDigest,
    changedContentDigest: input.readBack.branch.changedContentDigest,
    normalizedChangedPaths: input.readBack.branch.normalizedChangedPaths,
    releaseGateAbsent: true as const,
    recoveredFromPending: input.recovered,
    providerReadBackDigest: input.readBack.digest,
  });
}

function rejectionReceipt(
  kind: MutationKind,
  pending: GitHubMutationPendingReceipt,
  code: string,
): GitHubMutationFailureReceipt {
  const safeCode = /^[a-z][a-z0-9-]{0,63}$/u.test(code)
    ? code
    : "provider-rejected";
  return receipt({
    version: GITHUB_PUBLICATION_VERSION,
    kind,
    status: "failed" as const,
    proposalDigest: pending.proposalDigest,
    idempotencyKey: pending.idempotencyKey,
    approvedByCallId: pending.approvedByCallId,
    failureCode: "provider-rejected" as const,
    providerCode: safeCode,
    recoveryRequired: true as const,
  });
}

export async function createApprovedFreshRepository(input: {
  adapter: GitHubPublicationAdapter;
  store: GitHubPublicationReceiptStore;
  proposal: FreshRepositoryProposal;
  approvedByCallId: string;
}): Promise<FreshRepositorySuccessReceipt> {
  assertExactFreshRepositoryProposal(input.proposal);
  const prior = await readJournal(
    input.store,
    input.proposal,
    "fresh-repository",
  );
  if (prior?.status === "succeeded") {
    if (prior.kind !== "fresh-repository")
      throw new Error("Unreachable receipt kind.");
    return prior;
  }
  if (prior?.status === "failed")
    throw new Error("The failed GitHub mutation requires explicit recovery.");
  const pending =
    prior ??
    (await claimPending({
      store: input.store,
      kind: "fresh-repository",
      proposalDigest: input.proposal.digest,
      idempotencyKey: input.proposal.idempotencyKey,
      approvedByCallId: input.approvedByCallId,
    }));
  if (pending.status !== "pending")
    throw new Error("Unreachable journal status.");
  let existing: FreshRepositoryReadBack | undefined;
  try {
    existing = await input.adapter.inspectFreshRepositoryOutcome(
      input.proposal,
    );
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (existing !== undefined) {
    const success = freshSuccess({
      proposal: input.proposal,
      pending,
      readBack: existing,
      recovered: true,
    });
    await storeTerminal(input.store, pending, success);
    return success;
  }
  const installation = await input.adapter.inspectInstallation(
    "create-fresh-repository",
  );
  assertExactInstallationIdentity(installation);
  const destination = await input.adapter.inspectDestination({
    owner: input.proposal.destinationOwner,
    name: input.proposal.destinationName,
  });
  if (
    installation.operation !== "create-fresh-repository" ||
    installation.digest !== input.proposal.installationIdentityDigest ||
    destination !== "absent"
  )
    throw new Error("Fresh repository preconditions changed after approval.");
  let acknowledgement: GitHubMutationAcknowledgement;
  try {
    acknowledgement = await input.adapter.createPrivateFreshHistoryRepository(
      input.proposal,
    );
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (acknowledgement.status === "rejected") {
    const failure = rejectionReceipt(
      "fresh-repository",
      pending,
      acknowledgement.code,
    );
    await storeTerminal(input.store, pending, failure);
    throw new Error(
      "GitHub rejected repository creation; sanitized receipt recorded.",
    );
  }
  if (!/^[-A-Za-z0-9_]{1,128}$/u.test(acknowledgement.requestId))
    throw new GitHubOutcomeUnknownError();
  let readBack: FreshRepositoryReadBack | undefined;
  try {
    readBack = await input.adapter.inspectFreshRepositoryOutcome(
      input.proposal,
    );
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (readBack === undefined) throw new GitHubOutcomeUnknownError();
  let success: FreshRepositorySuccessReceipt;
  try {
    success = freshSuccess({
      proposal: input.proposal,
      pending,
      readBack,
      recovered: false,
    });
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  await storeTerminal(input.store, pending, success);
  return success;
}

export async function publishApprovedDraftPullRequest(input: {
  adapter: GitHubPublicationAdapter;
  store: GitHubPublicationReceiptStore;
  proposal: DraftPullRequestProposal;
  approvedByCallId: string;
}): Promise<DraftPullRequestSuccessReceipt> {
  assertExactDraftPullRequestProposal(input.proposal);
  const prior = await readJournal(
    input.store,
    input.proposal,
    "draft-pull-request",
  );
  if (prior?.status === "succeeded") {
    if (prior.kind !== "draft-pull-request")
      throw new Error("Unreachable receipt kind.");
    return prior;
  }
  if (prior?.status === "failed")
    throw new Error("The failed GitHub mutation requires explicit recovery.");
  const pending =
    prior ??
    (await claimPending({
      store: input.store,
      kind: "draft-pull-request",
      proposalDigest: input.proposal.digest,
      idempotencyKey: input.proposal.idempotencyKey,
      approvedByCallId: input.approvedByCallId,
    }));
  if (pending.status !== "pending")
    throw new Error("Unreachable journal status.");
  let observed: DraftPublicationReadBack;
  try {
    observed = await input.adapter.inspectDraftPublication(input.proposal);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  assertDraftReadBack(observed, input.proposal);
  if (observed.pullRequest.status === "present") {
    const success = draftSuccess({
      proposal: input.proposal,
      pending,
      readBack: observed,
      recovered: true,
    });
    await storeTerminal(input.store, pending, success);
    return success;
  }
  if (observed.branch.status === "present")
    throw new Error(
      "A branch collision exists without the approved draft pull request.",
    );
  const installation = await input.adapter.inspectInstallation(
    "publish-draft-pull-request",
  );
  assertExactInstallationIdentity(installation);
  if (
    installation.operation !== "publish-draft-pull-request" ||
    installation.digest !== input.proposal.installationIdentityDigest ||
    !installation.selectedRepositoryIds.includes(input.proposal.repositoryId)
  )
    throw new Error("Draft pull-request installation authority changed.");
  let acknowledgement: GitHubMutationAcknowledgement;
  try {
    acknowledgement = await input.adapter.publishDraftPullRequest(
      input.proposal,
    );
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  if (acknowledgement.status === "rejected") {
    const failure = rejectionReceipt(
      "draft-pull-request",
      pending,
      acknowledgement.code,
    );
    await storeTerminal(input.store, pending, failure);
    throw new Error(
      "GitHub rejected draft pull-request publication; sanitized receipt recorded.",
    );
  }
  if (!/^[-A-Za-z0-9_]{1,128}$/u.test(acknowledgement.requestId))
    throw new GitHubOutcomeUnknownError();
  try {
    observed = await input.adapter.inspectDraftPublication(input.proposal);
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  let success: DraftPullRequestSuccessReceipt;
  try {
    success = draftSuccess({
      proposal: input.proposal,
      pending,
      readBack: observed,
      recovered: false,
    });
  } catch {
    throw new GitHubOutcomeUnknownError();
  }
  await storeTerminal(input.store, pending, success);
  return success;
}
