import { createHash } from "node:crypto";

import type { ReviewedChangeSetReceipt } from "./reviewed-change-set";
import {
  parseSourceReceiptEvidence,
  type SourceReceiptEvidence,
} from "./source-receipt";
import { safeSourcePath } from "./source-path";
import { compareOverlayPaths } from "./target-apply";

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
  workflows: "none" | "write";
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
    configured: boolean;
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
    configured: boolean;
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
  releaseGateUnchanged: true;
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

type GitHubPublicationFileState = {
  mode: string;
  digest: Digest;
};

export type GitHubFreshRepositoryContentFile = {
  path: string;
  mode: "100644" | "100755";
  objectId: ObjectId;
  digest: Digest;
  bytes: Uint8Array;
};

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
export type GitHubFreshRepositoryContent = {
  version: 1;
  kind: "fresh-repository-source-tree";
  sourceSha: ObjectId;
  sourceTree: ObjectId;
  files: readonly GitHubFreshRepositoryContentFile[];
};

export type GitHubDraftPullRequestContent = {
  version: 1;
  kind: "draft-reviewed-change-set";
  reviewDigest: Digest;
  changeSetDigest: Digest;
  changedContentDigest: Digest;
  approvedPaths: readonly string[];
  changes: readonly GitHubPublicationContentChange[];
};

export type GitHubPublicationContent =
  GitHubFreshRepositoryContent | GitHubDraftPullRequestContent;

/** Read-only access to the already-approved apply overlay. */
export interface GitHubFreshRepositoryContentSource {
  readFreshTree(): Promise<GitHubFreshRepositoryContent>;
}

export interface GitHubDraftPullRequestContentSource {
  readFile(path: string): Promise<{
    mode: string;
    digest: Digest;
    bytes: Uint8Array;
  } | null>;
}

export type GitHubPublicationContentSource =
  GitHubFreshRepositoryContentSource & GitHubDraftPullRequestContentSource;

export interface GitHubPublicationAdapter {
  inspectInstallation(
    operation: GitHubOperation,
  ): Promise<GitHubInstallationIdentity>;
  inspectRepository(input: {
    operation: "resolve-existing-source" | "publish-draft-pull-request";
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
    content: GitHubFreshRepositoryContent,
  ): Promise<GitHubMutationAcknowledgement>;
  inspectDraftPublication(
    proposal: DraftPullRequestProposal,
  ): Promise<DraftPublicationReadBack>;
  publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
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
const bytesDigest = (value: Uint8Array) =>
  createHash("sha256").update(value).digest("hex");

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
        workflows: "none",
        pullRequests: "none",
        administration: "none",
        variables: "read",
      };
    case "create-fresh-repository":
      return {
        metadata: "read",
        contents: "write",
        workflows: "write",
        pullRequests: "none",
        administration: "write",
        variables: "read",
      };
    case "publish-draft-pull-request":
      return {
        metadata: "read",
        contents: "write",
        workflows: "write",
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
  return [...paths].toSorted(compareOverlayPaths);
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
    compareOverlayPaths(left.path, right.path),
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

function reviewForProposal(
  proposal: FreshRepositoryProposal | DraftPullRequestProposal,
  review: ReviewedChangeSetReceipt,
): void {
  assertCanonicalReview(review);
  if (
    proposal.reviewDigest !== review.digest ||
    proposal.changeSetDigest !== review.changeSetDigest ||
    (proposal.intendedOutcome ===
      "publish-reviewed-change-set-as-draft-pull-request" &&
      (proposal.changedContentDigest !== review.changedContentDigest ||
        JSON.stringify(proposal.approvedPaths) !==
          JSON.stringify(review.approvedPaths)))
  )
    throw new Error(
      "The publication content review does not match the sealed proposal.",
    );
}

function contentManifest(
  changes: readonly GitHubPublicationContentChange[],
): ReviewedChangeSetReceipt["changes"] {
  return changes.map((change) => {
    if (change.kind === "added") {
      return {
        path: change.path,
        kind: change.kind,
        after: { mode: change.after.mode, digest: change.after.digest },
      };
    }
    if (change.kind === "modified") {
      return {
        path: change.path,
        kind: change.kind,
        before: change.before,
        after: { mode: change.after.mode, digest: change.after.digest },
      };
    }
    return {
      path: change.path,
      kind: change.kind,
      before: change.before,
    };
  });
}

function exactContentFileState(value: unknown, includeBytes: boolean): boolean {
  const keys = includeBytes
    ? (["mode", "digest", "bytes"] as const)
    : (["mode", "digest"] as const);
  if (!record(value) || !exactKeys(value, keys)) return false;
  return (
    (value.mode === "644" || value.mode === "755") &&
    isDigest(value.digest) &&
    (!includeBytes || value.bytes instanceof Uint8Array)
  );
}

function exactContentChange(change: unknown): boolean {
  if (
    !record(change) ||
    typeof change.path !== "string" ||
    !safeSourcePath(change.path)
  )
    return false;
  if (change.kind === "added")
    return (
      exactKeys(change, ["path", "kind", "after"]) &&
      exactContentFileState(change.after, true)
    );
  if (change.kind === "modified")
    return (
      exactKeys(change, ["path", "kind", "before", "after"]) &&
      exactContentFileState(change.before, false) &&
      exactContentFileState(change.after, true)
    );
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
    kind: "directory",
    children: new Map(),
  };
  for (const file of files) {
    let directory = root;
    const segments = file.path.split("/");
    for (const segment of segments.slice(0, -1)) {
      const existing = directory.children.get(segment);
      if (existing?.kind === "file")
        throw new Error("The fresh repository source manifest overlaps paths.");
      const child =
        existing ?? ({ kind: "directory", children: new Map() } as const);
      directory.children.set(segment, child);
      directory = child;
    }
    const name = segments.at(-1)!;
    if (directory.children.has(name))
      throw new Error("The fresh repository source manifest duplicates paths.");
    directory.children.set(name, { kind: "file", file });
  }
  const encodeTree = (
    directory: Extract<Node, { kind: "directory" }>,
  ): Buffer => {
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

export function assertExactGitHubFreshRepositoryContent(input: {
  proposal: FreshRepositoryProposal;
  content: GitHubFreshRepositoryContent;
}): void {
  const { content, proposal } = input;
  if (
    !exactKeys(content, [
      "version",
      "kind",
      "sourceSha",
      "sourceTree",
      "files",
    ]) ||
    content.version !== 1 ||
    content.kind !== "fresh-repository-source-tree" ||
    content.sourceSha !== proposal.sourceSha ||
    content.sourceTree !== proposal.sourceTree ||
    !Array.isArray(content.files) ||
    content.files.length === 0
  )
    throw new Error("The fresh repository content schema is invalid.");
  const algorithm = proposal.sourceTree.length === 64 ? "sha256" : "sha1";
  const paths = content.files.map((file) => file.path);
  if (
    new Set(paths).size !== paths.length ||
    content.files.some(
      (file) =>
        !exactKeys(file, ["path", "mode", "objectId", "digest", "bytes"]) ||
        !safeSourcePath(file.path) ||
        (file.mode !== "100644" && file.mode !== "100755") ||
        !isObjectId(file.objectId) ||
        !isDigest(file.digest) ||
        !(file.bytes instanceof Uint8Array) ||
        bytesDigest(file.bytes) !== file.digest ||
        gitObjectDigest("blob", file.bytes, algorithm).toString("hex") !==
          file.objectId,
    ) ||
    freshContentTree(content.files, algorithm) !== proposal.sourceTree
  )
    throw new Error(
      "The fresh repository content does not match the immutable source tree.",
    );
}

export function assertExactGitHubDraftPullRequestContent(input: {
  proposal: DraftPullRequestProposal;
  content: GitHubDraftPullRequestContent;
}): void {
  if (
    !exactKeys(input.content, [
      "version",
      "kind",
      "reviewDigest",
      "changeSetDigest",
      "changedContentDigest",
      "approvedPaths",
      "changes",
    ]) ||
    !Array.isArray(input.content.approvedPaths) ||
    !Array.isArray(input.content.changes) ||
    input.content.changes.some((change) => !exactContentChange(change))
  )
    throw new Error("The publication content schema is not closed.");
  const manifest = contentManifest(input.content.changes);
  if (
    input.content.version !== 1 ||
    input.content.kind !== "draft-reviewed-change-set" ||
    input.content.reviewDigest !== input.proposal.reviewDigest ||
    input.content.changeSetDigest !== input.proposal.changeSetDigest ||
    input.content.changedContentDigest !==
      input.proposal.changedContentDigest ||
    JSON.stringify(input.content.approvedPaths) !==
      JSON.stringify(input.proposal.approvedPaths) ||
    digest(manifest) !== input.proposal.changedContentDigest ||
    input.content.changes.some(
      (change) =>
        change.kind !== "deleted" &&
        bytesDigest(change.after.bytes) !== change.after.digest,
    )
  )
    throw new Error(
      "The publication content does not match the approved reviewed overlay.",
    );
}

export function assertExactGitHubPublicationContent(input: {
  proposal: DraftPullRequestProposal;
  review: ReviewedChangeSetReceipt;
  content: GitHubDraftPullRequestContent;
}): void {
  reviewForProposal(input.proposal, input.review);
  assertExactGitHubDraftPullRequestContent(input);
  if (
    JSON.stringify(contentManifest(input.content.changes)) !==
    JSON.stringify(input.review.changes)
  )
    throw new Error(
      "The publication content does not match the approved reviewed overlay.",
    );
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
      bytes: file.bytes.slice(),
    })),
  };
  assertExactGitHubFreshRepositoryContent({
    proposal: input.proposal,
    content,
  });
  return content;
}

export async function readExactGitHubPublicationContent(input: {
  proposal: DraftPullRequestProposal;
  review: ReviewedChangeSetReceipt;
  source: GitHubDraftPullRequestContentSource;
}): Promise<GitHubDraftPullRequestContent> {
  reviewForProposal(input.proposal, input.review);
  const changes: GitHubPublicationContentChange[] = [];
  for (const change of input.review.changes) {
    if (change.kind === "deleted") {
      if (change.before === undefined)
        throw new Error("The reviewed deletion preimage is missing.");
      changes.push({
        path: change.path,
        kind: change.kind,
        before: change.before,
      });
      continue;
    }
    if (change.after === undefined)
      throw new Error("The reviewed publication postimage is missing.");
    let observed: Awaited<ReturnType<typeof input.source.readFile>>;
    try {
      observed = await input.source.readFile(change.path);
    } catch {
      throw new Error("The approved publication content source failed.");
    }
    if (observed === null)
      throw new Error(
        `The approved publication postimage is missing for ${change.path}.`,
      );
    const bytes = observed.bytes.slice();
    if (
      observed.mode !== change.after.mode ||
      observed.digest !== change.after.digest ||
      bytesDigest(bytes) !== change.after.digest
    )
      throw new Error(
        `The approved publication postimage changed for ${change.path}.`,
      );
    if (change.kind === "added") {
      changes.push({
        path: change.path,
        kind: change.kind,
        after: { ...change.after, bytes },
      });
      continue;
    }
    if (change.before === undefined)
      throw new Error("The reviewed modification preimage is missing.");
    changes.push({
      path: change.path,
      kind: change.kind,
      before: change.before,
      after: { ...change.after, bytes },
    });
  }
  const content: GitHubDraftPullRequestContent = {
    version: 1,
    kind: "draft-reviewed-change-set",
    reviewDigest: input.review.digest,
    changeSetDigest: input.review.changeSetDigest,
    changedContentDigest: input.review.changedContentDigest,
    approvedPaths: input.review.approvedPaths,
    changes,
  };
  assertExactGitHubPublicationContent({
    proposal: input.proposal,
    review: input.review,
    content,
  });
  return content;
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
  "workflows",
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
    typeof input.releaseGate.configured !== "boolean"
  )
    throw new Error("The repository observation is invalid.");
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
    operation: "resolve-existing-source",
    repositoryId: input.repositoryId,
    ref: input.ref,
  });
  assertExactRepositoryObservation(repository);
  if (
    repository.installationIdentityDigest !== installation.digest ||
    repository.repositoryId !== input.repositoryId ||
    repository.headSha !== input.expectedSha ||
    repository.headTree !== input.expectedTree
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
  receipt: ImmutableGitHubSourceReceipt,
): void {
  if (!exactKeys(receipt, immutableSourceReceiptKeys))
    throw new Error(
      "The immutable GitHub source receipt schema is not closed.",
    );
  assertExactRepositoryObservation(receipt.repository);
  exactDigest(receipt, "Immutable GitHub source receipt");
  if (
    receipt.version !== GITHUB_PUBLICATION_VERSION ||
    !safeHeadRef(receipt.resolvedRef) ||
    !isObjectId(receipt.resolvedSha) ||
    !isObjectId(receipt.resolvedTree) ||
    !isDigest(receipt.installationIdentityDigest) ||
    receipt.resolvedByCallId.trim().length === 0 ||
    receipt.repository.headSha !== receipt.resolvedSha ||
    receipt.repository.headTree !== receipt.resolvedTree ||
    receipt.repository.installationIdentityDigest !==
      receipt.installationIdentityDigest
  )
    throw new Error("The immutable GitHub source receipt is malformed.");
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
    releaseGate: input.repository.releaseGate,
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
    typeof proposal.releaseGate.configured !== "boolean" ||
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
    readBack.repository.releaseGate.name !== proposal.releaseGate.name ||
    readBack.repository.releaseGate.configured !==
      proposal.releaseGate.configured ||
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
              "releaseGateUnchanged",
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
      (value.kind === "fresh-repository"
        ? value.releaseGateAbsent !== true
        : value.releaseGateUnchanged !== true)
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
    releaseGateUnchanged: true as const,
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
  review: ReviewedChangeSetReceipt;
  contentSource: GitHubFreshRepositoryContentSource;
  approvedByCallId: string;
}): Promise<FreshRepositorySuccessReceipt> {
  assertExactFreshRepositoryProposal(input.proposal);
  reviewForProposal(input.proposal, input.review);
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
  review: ReviewedChangeSetReceipt;
  contentSource: GitHubDraftPullRequestContentSource;
  approvedByCallId: string;
}): Promise<DraftPullRequestSuccessReceipt> {
  assertExactDraftPullRequestProposal(input.proposal);
  reviewForProposal(input.proposal, input.review);
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
  const content = await readExactGitHubPublicationContent({
    proposal: input.proposal,
    review: input.review,
    source: input.contentSource,
  });
  let acknowledgement: GitHubMutationAcknowledgement;
  try {
    acknowledgement = await input.adapter.publishDraftPullRequest(
      input.proposal,
      content,
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
