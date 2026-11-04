import type { AppBuilderWorkflowState } from "./workflow-state";
import type { DraftReconciliationCandidate } from "./draft-reconciliation-state";

export type DraftReviewedWorkflow = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;

const sameBinding = (actual: string | undefined, expected: string | undefined): boolean =>
  actual !== undefined && actual.length > 0 && actual === expected;

/** The original app review is lineage; it never reviews or approves edited candidate bytes. */
// oxlint-disable-next-line eslint/complexity -- Check each retained authority binding independently, including omitted legacy fields.
export const resolveDraftReviewedWorkflow = (
  state: AppBuilderWorkflowState,
  candidate: DraftReconciliationCandidate | null,
): DraftReviewedWorkflow | undefined => {
  // A newly completed review always supersedes retained lineage, even when it differs.
  if (state.phase === "reviewed") {
    return state;
  }
  if (
    state.phase !== "applied" &&
    state.phase !== "validation_pending" &&
    state.phase !== "validation_failed" &&
    state.phase !== "validated"
  ) {
    return undefined;
  }
  const retained = candidate?.reviewedLineage;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- All retained review and selected-source prerequisites must be present before binding checks.
    retained === undefined ||
    candidate === null ||
    retained.phase !== "reviewed" ||
    retained.sourceReceipt?.sourceKind !== "existing-repository" ||
    retained.githubSource === undefined ||
    state.githubSource === undefined
  ) {
    return undefined;
  }
  const matches = [
    sameBinding(retained.reviewReceipt?.digest, candidate.originalReviewDigest),
    sameBinding(retained.appSpec?.appId, candidate.appId),
    sameBinding(state.appSpec.appId, retained.appSpec?.appId),
    sameBinding(state.appSpec.digest, retained.appSpec?.digest),
    sameBinding(state.applyReceipt.digest, retained.applyReceipt?.digest),
    sameBinding(state.applyReceipt.applyRoot, retained.applyReceipt?.applyRoot),
    sameBinding(state.sourceReceipt.digest, retained.sourceReceipt?.digest),
    sameBinding(state.sourceReceipt.sourceKind, retained.sourceReceipt?.sourceKind),
    sameBinding(state.githubSource.digest, retained.githubSource.digest),
    sameBinding(retained.githubSource.digest, candidate.githubSourceDigest),
    sameBinding(
      state.githubSource.repository.repositoryId,
      retained.githubSource.repository.repositoryId,
    ),
    sameBinding(retained.githubSource.repository.repositoryId, candidate.repositoryId),
    sameBinding(state.identityReceipt.digest, retained.identityReceipt?.digest),
    sameBinding(state.proposal.digest, retained.proposal?.digest),
    sameBinding(state.workspace.workspaceId, retained.workspace?.workspaceId),
    sameBinding(state.workspace.workspaceDigest, retained.workspace?.workspaceDigest),
  ].every(Boolean);
  return matches ? retained : undefined;
};
