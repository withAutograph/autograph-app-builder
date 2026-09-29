import { createHash } from "node:crypto";

import type { ExistingDraftObservation } from "./github-draft-update";
import { safeSourcePath } from "./source-path";
import type {
  GitHubDraftPullRequestContentSource,
  GitHubInstallationIdentity,
  GitHubMutationAcknowledgement,
  GitHubRepositoryObservation,
} from "./github-publication";
import { compareOverlayPaths } from "./target-apply";
import type { OverlayChange } from "./target-apply";

// oxlint-disable sonarjs/expression-complexity -- sealed reconciliation validates several independent authority and review fields together

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- hashes only locally constructed and validated review/proposal objects
const digest = (value: unknown): string =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const objectId = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const fileDigest = /^[0-9a-f]{64}$/u;
const draftPublicationOperation = "publish-draft-pull-request" as const;
const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** The two exact diffs the user reviews after Builder reconciles a draft with live base. */
export interface ReconciliationReviewReceipt {
  version: 1;
  appId: string;
  baseSha: string;
  baseTree: string;
  headSha: string;
  headTree: string;
  resolvedTree: string;
  /** Final PR diff against the current base. Only app-owned paths may appear here. */
  baseChanges: readonly OverlayChange[];
  /** Every change from the old PR head, including inherited changes from base. */
  headChanges: readonly OverlayChange[];
  approvedPaths: readonly string[];
  digest: string;
}

const canonicalChanges = (changes: readonly OverlayChange[]): OverlayChange[] =>
  changes
    .map((change) => {
      const normalized: OverlayChange = { kind: change.kind, path: change.path };
      if (change.before !== undefined) {
        normalized.before = change.before;
      }
      if (change.after !== undefined) {
        normalized.after = change.after;
      }
      return normalized;
    })
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path));

const validChange = (change: OverlayChange): boolean => {
  if (!safeSourcePath(change.path)) {
    return false;
  }
  for (const state of [change.before, change.after]) {
    if (
      state !== undefined &&
      (!fileDigest.test(state.digest) || !["644", "755"].includes(state.mode))
    ) {
      return false;
    }
  }
  if (change.kind === "added") {
    return change.before === undefined && change.after !== undefined;
  }
  if (change.kind === "deleted") {
    return change.before !== undefined && change.after === undefined;
  }
  return change.kind === "modified" && change.before !== undefined && change.after !== undefined;
};

const uniquePaths = (changes: readonly OverlayChange[]): boolean =>
  changes.every((change, index) => index === 0 || change.path !== changes[index - 1]?.path);

const assertReview = (review: ReconciliationReviewReceipt): void => {
  const { digest: claimed, ...unsigned } = review;
  const baseChanges = canonicalChanges(review.baseChanges);
  const headChanges = canonicalChanges(review.headChanges);
  // oxlint-disable-next-line sonarjs/expression-complexity -- validate every sealed review dimension before approval
  if (
    !objectId.test(review.baseSha) ||
    !objectId.test(review.baseTree) ||
    !objectId.test(review.headSha) ||
    !objectId.test(review.headTree) ||
    !objectId.test(review.resolvedTree) ||
    !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(review.appId) ||
    !uniquePaths(baseChanges) ||
    !uniquePaths(headChanges) ||
    baseChanges.some(
      (change) => !validChange(change) || !change.path.startsWith(`apps/${review.appId}/`),
    ) ||
    headChanges.some((change) => !validChange(change)) ||
    JSON.stringify(review.baseChanges) !== JSON.stringify(baseChanges) ||
    JSON.stringify(review.headChanges) !== JSON.stringify(headChanges) ||
    JSON.stringify(review.approvedPaths) !== JSON.stringify(baseChanges.map(({ path }) => path)) ||
    claimed !== digest(unsigned)
  ) {
    throw new Error(
      "The resolved draft review is incomplete or changed. Reinspect both diffs, validate the merged tree, and review it again.",
    );
  }
};

export const createReconciliationReviewReceipt = (
  input: Omit<
    ReconciliationReviewReceipt,
    "digest" | "approvedPaths" | "baseChanges" | "headChanges"
  > & {
    baseChanges: readonly OverlayChange[];
    headChanges: readonly OverlayChange[];
  },
): ReconciliationReviewReceipt => {
  const baseChanges = canonicalChanges(input.baseChanges);
  const unsigned = {
    ...input,
    approvedPaths: baseChanges.map(({ path }) => path),
    baseChanges,
    headChanges: canonicalChanges(input.headChanges),
  };
  const review = { ...unsigned, digest: digest(unsigned) };
  assertReview(review);
  return review;
};

export interface ExistingDraftReconciliationProposal {
  version: 1;
  intendedOutcome: "reconcile-existing-draft-pull-request";
  installationIdentityDigest: string;
  repositoryId: string;
  owner: string;
  name: string;
  pullRequestNumber: number;
  pullRequestId: string;
  branchName: string;
  baseBranch: string;
  expectedHeadSha: string;
  expectedHeadTree: string;
  expectedBaseSha: string;
  expectedBaseTree: string;
  resolvedTree: string;
  reviewDigest: string;
  approvedPaths: readonly string[];
  baseChangesDigest: string;
  headChangesDigest: string;
  originMarker: string;
  priorPublicationDigest: string;
  idempotencyKey: string;
  digest: string;
}

export interface ReconciliationContent {
  version: 1;
  kind: "draft-reconciliation";
  reviewDigest: string;
  changes: readonly (OverlayChange & { bytes?: Uint8Array })[];
}

export const assertReconciliationContent = (
  proposal: ExistingDraftReconciliationProposal,
  content: ReconciliationContent,
): void => {
  const metadata = content.changes.map(({ bytes: _bytes, ...change }) => change);
  if (
    content.version !== 1 ||
    content.kind !== "draft-reconciliation" ||
    content.reviewDigest !== proposal.reviewDigest ||
    digest(metadata) !== proposal.baseChangesDigest ||
    JSON.stringify(metadata.map(({ path }) => path)) !== JSON.stringify(proposal.approvedPaths) ||
    content.changes.some((change) =>
      change.kind === "deleted"
        ? change.bytes !== undefined
        : change.after === undefined ||
          change.bytes === undefined ||
          digestBytes(change.bytes) !== change.after.digest,
    )
  ) {
    throw new Error(
      "The resolved publication bytes do not match the reviewed draft reconciliation. Reinspect both diffs and request approval again.",
    );
  }
};

export interface ExistingDraftReconciliationAdapter {
  inspectInstallation: () => Promise<GitHubInstallationIdentity>;
  inspectExistingDraft: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    number: number;
  }) => Promise<ExistingDraftObservation>;
  inspectRepository: (input: {
    operation: typeof draftPublicationOperation;
    repositoryId: string;
    ref: string;
  }) => Promise<GitHubRepositoryObservation>;
  reconcileExistingDraft: (
    proposal: ExistingDraftReconciliationProposal,
    content: ReconciliationContent,
  ) => Promise<GitHubMutationAcknowledgement>;
  inspectAppliedDraftReconciliation: (
    proposal: ExistingDraftReconciliationProposal,
    observed: ExistingDraftObservation,
  ) => Promise<boolean>;
}

const sameDraft = (
  proposal: ExistingDraftReconciliationProposal,
  current: ExistingDraftObservation,
): boolean =>
  current.repositoryId === proposal.repositoryId &&
  current.owner === proposal.owner &&
  current.name === proposal.name &&
  current.number === proposal.pullRequestNumber &&
  current.pullRequestId === proposal.pullRequestId &&
  current.headRepositoryId === proposal.repositoryId &&
  current.baseRepositoryId === proposal.repositoryId &&
  current.headBranch === proposal.branchName &&
  current.baseBranch === proposal.baseBranch &&
  current.draft &&
  current.state === "open";

export const sealExistingDraftReconciliation = async (input: {
  adapter: ExistingDraftReconciliationAdapter;
  installation: GitHubInstallationIdentity;
  repository: GitHubRepositoryObservation;
  review: ReconciliationReviewReceipt;
  pullRequestNumber: number;
  selectedSourceRef: string;
  priorPublicationDigest: string;
  originMarker: string;
}): Promise<ExistingDraftReconciliationProposal> => {
  assertReview(input.review);
  if (
    input.installation.operation !== draftPublicationOperation ||
    input.repository.installationIdentityDigest !== input.installation.digest ||
    !input.installation.selectedRepositoryIds.includes(input.repository.repositoryId)
  ) {
    throw new Error(
      "The selected GitHub installation cannot reconcile this repository's draft PR.",
    );
  }
  const observed = await input.adapter.inspectExistingDraft({
    name: input.repository.name,
    number: input.pullRequestNumber,
    owner: input.repository.owner,
    repositoryId: input.repository.repositoryId,
  });
  if (input.selectedSourceRef !== `refs/heads/${observed.headBranch}`) {
    throw new Error(
      "Builder's selected source is not the current draft PR branch. Reopen that branch and review its changes.",
    );
  }
  if (
    observed.repositoryId !== input.repository.repositoryId ||
    observed.headRepositoryId !== input.repository.repositoryId ||
    observed.baseRepositoryId !== input.repository.repositoryId ||
    observed.baseBranch !== input.repository.defaultBranch ||
    !observed.draft ||
    observed.state !== "open"
  ) {
    throw new Error(
      "The selected pull request is not an open draft with its head and base in the selected repository.",
    );
  }
  const base = await input.adapter.inspectRepository({
    operation: draftPublicationOperation,
    ref: `refs/heads/${observed.baseBranch}`,
    repositoryId: input.repository.repositoryId,
  });
  if (
    observed.headSha !== input.review.headSha ||
    observed.headTree !== input.review.headTree ||
    base.headSha !== input.review.baseSha ||
    base.headTree !== input.review.baseTree
  ) {
    throw new Error(
      "The PR head or live base branch moved during reconciliation. Refresh both branches, resolve again, and review both new diffs.",
    );
  }
  if (
    observed.verifiedBuilderOrigin?.marker !== input.originMarker ||
    input.priorPublicationDigest.length === 0
  ) {
    throw new Error(
      "Builder cannot verify this draft PR's origin. Refresh its publication provenance before reconciling.",
    );
  }
  const unsigned = {
    approvedPaths: input.review.approvedPaths,
    baseBranch: observed.baseBranch,
    baseChangesDigest: digest(input.review.baseChanges),
    branchName: observed.headBranch,
    expectedBaseSha: base.headSha,
    expectedBaseTree: base.headTree,
    expectedHeadSha: observed.headSha,
    expectedHeadTree: observed.headTree,
    headChangesDigest: digest(input.review.headChanges),
    installationIdentityDigest: input.installation.digest,
    intendedOutcome: "reconcile-existing-draft-pull-request" as const,
    name: observed.name,
    originMarker: input.originMarker,
    owner: observed.owner,
    priorPublicationDigest: input.priorPublicationDigest,
    pullRequestId: observed.pullRequestId,
    pullRequestNumber: observed.number,
    repositoryId: observed.repositoryId,
    resolvedTree: input.review.resolvedTree,
    reviewDigest: input.review.digest,
    version: 1 as const,
  };
  const idempotencyKey = digest(unsigned);
  return { ...unsigned, digest: digest({ ...unsigned, idempotencyKey }), idempotencyKey };
};

const readContent = async (
  review: ReconciliationReviewReceipt,
  source: GitHubDraftPullRequestContentSource,
): Promise<ReconciliationContent> => {
  const changes = await Promise.all(
    review.baseChanges.map(async (change) => {
      if (change.kind === "deleted") {
        return change;
      }
      const file = await source.readFile(change.path);
      if (
        file === null ||
        change.after === undefined ||
        file.mode !== change.after.mode ||
        file.digest !== change.after.digest ||
        digestBytes(file.bytes) !== change.after.digest
      ) {
        throw new Error(
          `The resolved file ${change.path} differs from the reviewed content. Refresh both diffs and request approval again.`,
        );
      }
      return { ...change, bytes: new Uint8Array(file.bytes) };
    }),
  );
  return { changes, kind: "draft-reconciliation", reviewDigest: review.digest, version: 1 };
};

// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript catch values are unknown; expose only an Error message.
const errorDescription = (error: unknown): string =>
  error instanceof Error ? error.message : "unknown provider error";

const inspectDraftAfterWrite = async (input: {
  adapter: ExistingDraftReconciliationAdapter;
  proposal: ExistingDraftReconciliationProposal;
  writeError?: unknown;
}): Promise<ExistingDraftObservation> => {
  try {
    return await input.adapter.inspectExistingDraft({
      name: input.proposal.name,
      number: input.proposal.pullRequestNumber,
      owner: input.proposal.owner,
      repositoryId: input.proposal.repositoryId,
    });
  } catch (readbackError) {
    const prefix =
      input.writeError === undefined
        ? `GitHub accepted the merge commit for draft PR #${input.proposal.pullRequestNumber}, but Builder could not read the PR branch afterward.`
        : `GitHub did not confirm the draft PR #${input.proposal.pullRequestNumber} update, and Builder could not read the PR branch afterward. The branch may already have moved.`;
    const writeDetail =
      input.writeError === undefined ? "" : ` Update error: ${errorDescription(input.writeError)}`;
    throw new Error(
      `${prefix} Inspect its live head before retrying this sealed operation.${writeDetail} Readback error: ${errorDescription(readbackError)}`,
      { cause: readbackError },
    );
  }
};

// oxlint-disable-next-line eslint/complexity -- sealed review, live refs, uncertain-result recovery, and readback are one publication operation
export const reconcileExistingDraft = async (input: {
  adapter: ExistingDraftReconciliationAdapter;
  proposal: ExistingDraftReconciliationProposal;
  review: ReconciliationReviewReceipt;
  contentSource: GitHubDraftPullRequestContentSource;
}): Promise<ExistingDraftObservation> => {
  const { proposal, review } = input;
  assertReview(review);
  const { digest: claimed, ...unsigned } = proposal;
  const { idempotencyKey, ...identity } = unsigned;
  if (
    proposal.version !== 1 ||
    proposal.intendedOutcome !== "reconcile-existing-draft-pull-request" ||
    claimed !== digest(unsigned) ||
    idempotencyKey !== digest(identity) ||
    proposal.reviewDigest !== review.digest ||
    proposal.baseChangesDigest !== digest(review.baseChanges) ||
    proposal.headChangesDigest !== digest(review.headChanges) ||
    proposal.resolvedTree !== review.resolvedTree ||
    JSON.stringify(proposal.approvedPaths) !== JSON.stringify(review.approvedPaths)
  ) {
    throw new Error(
      "The draft reconciliation proposal no longer matches the reviewed merge. Review and seal it again.",
    );
  }
  const installation = await input.adapter.inspectInstallation();
  if (
    installation.digest !== proposal.installationIdentityDigest ||
    !installation.selectedRepositoryIds.includes(proposal.repositoryId)
  ) {
    throw new Error(
      "GitHub installation access changed before reconciliation. Reconnect and seal a new proposal.",
    );
  }
  const current = await input.adapter.inspectExistingDraft({
    name: proposal.name,
    number: proposal.pullRequestNumber,
    owner: proposal.owner,
    repositoryId: proposal.repositoryId,
  });
  if (!sameDraft(proposal, current)) {
    throw new Error(
      "The PR identity changed or is no longer an open draft. Reopen and review the current PR.",
    );
  }
  if (
    current.headSha !== proposal.expectedHeadSha ||
    current.headTree !== proposal.expectedHeadTree
  ) {
    if (await input.adapter.inspectAppliedDraftReconciliation(proposal, current)) {
      return current;
    }
    throw new Error(
      "The draft PR branch moved after review. Reconcile its current head and request approval again.",
    );
  }
  const base = await input.adapter.inspectRepository({
    operation: draftPublicationOperation,
    ref: `refs/heads/${proposal.baseBranch}`,
    repositoryId: proposal.repositoryId,
  });
  if (base.headSha !== proposal.expectedBaseSha || base.headTree !== proposal.expectedBaseTree) {
    throw new Error(
      "The base branch moved after review. Refresh it, resolve the merge again, and request approval for the new result.",
    );
  }
  const content = await readContent(review, input.contentSource);
  let result: GitHubMutationAcknowledgement;
  try {
    result = await input.adapter.reconcileExistingDraft(proposal, content);
  } catch (error) {
    const latest = await inspectDraftAfterWrite({
      adapter: input.adapter,
      proposal,
      writeError: error,
    });
    if (
      sameDraft(proposal, latest) &&
      (await input.adapter.inspectAppliedDraftReconciliation(proposal, latest))
    ) {
      return latest;
    }
    throw error;
  }
  if (result.status === "rejected") {
    const location = result.path === undefined ? "" : `: ${result.path}`;
    throw new Error(
      `GitHub rejected the draft reconciliation (${result.code}${location}). Refresh both branch heads and the reviewed merge before retrying.`,
    );
  }
  const updated = await inspectDraftAfterWrite({ adapter: input.adapter, proposal });
  if (
    !sameDraft(proposal, updated) ||
    !(await input.adapter.inspectAppliedDraftReconciliation(proposal, updated))
  ) {
    throw new Error(
      "GitHub accepted the merge commit, but its branch head could not be verified. Inspect the PR before retrying.",
    );
  }
  return updated;
};
