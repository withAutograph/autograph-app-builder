interface ReconciliationWorkflowPrerequisites {
  phase: string;
  githubSource?: { digest: string };
  reviewReceipt?: { digest: string };
  sourceReceipt?: { sourceKind: string };
}

interface ReconciliationCandidatePrerequisites {
  githubSourceDigest: string;
  originalReviewDigest: string;
  review?: { digest: string };
  validation?: { resolvedTree: string };
  reviewReadProgress?: {
    reviewDigest: string;
    baseComplete: boolean;
    headComplete: boolean;
  };
}

type Recovery =
  | "prepare-reconciliation"
  | "review-candidate"
  | "resume-validation"
  | "inspect-diff"
  | "review-app"
  | "select-source"
  | "use-current-review";

const prerequisiteReasons = [
  "candidate_missing",
  "candidate_review_missing",
  "candidate_validation_missing",
  "diff_progress_missing",
  "diff_progress_review_changed",
  "base_diff_incomplete",
  "head_diff_incomplete",
  "workflow_not_reviewed",
  "selected_source_missing",
  "source_not_existing_repository",
  "source_binding_changed",
  "app_review_changed",
  "seal_review_input_changed",
] as const;

interface PrerequisiteDiagnostic {
  reason: (typeof prerequisiteReasons)[number];
  recovery: Recovery;
  nextAction: string;
}

const prepareReconciliation = "prepare-reconciliation";
const inspectDiff = "inspect-diff";

const sameSessionRecovery =
  "Continue automatically through Builder's normal tools in this same session for the same draft PR. Preserve the existing app work and publication provenance. Technical recovery does not need a user Continue reply; the later GitHub update still requires its existing exact publication approval.";

const diagnostic = (
  reason: PrerequisiteDiagnostic["reason"],
  recovery: Recovery,
  action: string,
): PrerequisiteDiagnostic => ({
  reason,
  recovery,
  nextAction: `${action} ${sameSessionRecovery}`,
});

/** Diagnostic only: callers retain their original prerequisite checks and ordering. */
export const draftPreparationPrerequisiteDiagnostic = (
  state: ReconciliationWorkflowPrerequisites,
): PrerequisiteDiagnostic | null => {
  if (state.phase !== "reviewed") {
    return diagnostic(
      "workflow_not_reviewed",
      "review-app",
      "The current app workflow has not retained a completed review. Inspect its current status and continue the normal app review workflow before preparing reconciliation. Do not infer a validation failure or rerun completed checks solely from this missing review.",
    );
  }
  if (state.githubSource === undefined) {
    return diagnostic(
      "selected_source_missing",
      "select-source",
      "The current app workflow has no selected GitHub source. Recover its normal repository selection and app review, then prepare reconciliation for the existing draft PR. Do not replace the session or copy the app into another source.",
    );
  }
  if (state.sourceReceipt?.sourceKind !== "existing-repository") {
    return diagnostic(
      "source_not_existing_repository",
      "select-source",
      "The current reviewed source is not the existing-repository source required by draft reconciliation. Inspect and recover the existing app's normal source-selection and review workflow before retrying; do not force a branch or substitute another app.",
    );
  }
  return null;
};

/** Explain the first failed seal prerequisite without claiming that app bytes or Git refs moved. */
export const draftSealPrerequisiteDiagnostic = (input: {
  candidate: ReconciliationCandidatePrerequisites | null;
  state: ReconciliationWorkflowPrerequisites;
  expectedReviewDigest: string;
}): PrerequisiteDiagnostic | null => {
  const { candidate, state } = input;
  if (candidate === null) {
    return diagnostic(
      "candidate_missing",
      prepareReconciliation,
      "No prepared merge candidate is retained. Use prepare_github_draft_pr_reconciliation for the existing draft PR, then continue its returned recovery.",
    );
  }
  if (candidate.review === undefined) {
    return diagnostic(
      "candidate_review_missing",
      "review-candidate",
      "The candidate has no retained reconciliation review. If its validation is complete, use review_github_draft_pr_reconciliation and inspect the resulting diffs. Otherwise resume candidate validation first.",
    );
  }
  if (candidate.validation === undefined) {
    return diagnostic(
      "candidate_validation_missing",
      "resume-validation",
      "The candidate has no completed validation receipt. Resume validate_github_draft_pr_reconciliation using its returned nextCommand until it reports validated, then review the current merge. Individual passed commands do not establish that the sequence finished.",
    );
  }
  const progress = candidate.reviewReadProgress;
  if (progress === undefined || progress.reviewDigest !== candidate.review.digest) {
    return diagnostic(
      progress === undefined ? "diff_progress_missing" : "diff_progress_review_changed",
      inspectDiff,
      "The current reconciliation review has no matching diff inspection progress. Use inspect_github_draft_pr_reconciliation to inspect the current base and head diffs from their available cursors, then seal the current review. This condition alone does not require reinstalling, compiling, rerunning checks or starting a private Preview.",
    );
  }
  if (!progress.baseComplete) {
    return diagnostic(
      "base_diff_incomplete",
      inspectDiff,
      "Inspection of the current diff against base is incomplete. Continue that side with inspect_github_draft_pr_reconciliation using its saved next cursor, then seal the current review. Do not rerun validation solely to finish diff inspection.",
    );
  }
  if (!progress.headComplete) {
    return diagnostic(
      "head_diff_incomplete",
      inspectDiff,
      "Inspection of the current diff against the old PR head is incomplete. Continue that side with inspect_github_draft_pr_reconciliation using its saved next cursor, then seal the current review. Do not rerun validation solely to finish diff inspection.",
    );
  }
  if (state.phase !== "reviewed" || state.githubSource === undefined) {
    return draftPreparationPrerequisiteDiagnostic(state);
  }
  if (state.githubSource.digest !== candidate.githubSourceDigest) {
    return diagnostic(
      "source_binding_changed",
      prepareReconciliation,
      "The candidate belongs to a different selected source than the current reviewed app. Prepare reconciliation again through the existing tool; it preserves the old candidate and prepares the verified current draft and base. Continue the returned validation and review requirements.",
    );
  }
  if (state.reviewReceipt?.digest !== candidate.originalReviewDigest) {
    return diagnostic(
      "app_review_changed",
      prepareReconciliation,
      "The app review associated with this candidate differs from the current app review. Prepare reconciliation again for the existing draft PR, preserving the old candidate, then validate and review the resulting current candidate.",
    );
  }
  if (candidate.review.digest !== input.expectedReviewDigest) {
    return diagnostic(
      "seal_review_input_changed",
      "use-current-review",
      "The seal request refers to a different reconciliation review. Use the current review result when sealing. If that result is unavailable, review the current candidate again and inspect its current diffs; a stale seal argument alone does not require rerunning validation.",
    );
  }
  return null;
};

export const draftPrerequisiteMessage = (
  value: PrerequisiteDiagnostic | null,
  fallback: string,
): string =>
  value === null ? fallback : `${value.reason} (${value.recovery}): ${value.nextAction}`;
