interface ReconciliationWorkflowPrerequisites {
  phase: string;
  githubSource?: { digest: string };
  reviewReceipt?: { digest: string };
  sourceReceipt?: { sourceKind: string };
  publishedGitHubDraftProposalDigest?: string;
}

/** Routing guidance only; normal reconciliation verifies the owned publication. */
export const ownedPublishedDraftRecovery = (state: ReconciliationWorkflowPrerequisites) => {
  if (
    state.sourceReceipt?.sourceKind !== "fresh-template" ||
    state.githubSource !== undefined ||
    state.publishedGitHubDraftProposalDigest === undefined
  ) {
    return;
  }
  return {
    tool: "prepare_github_draft_pr_reconciliation" as const,
    recovery: "reopen-current-owned-draft" as const,
    reviewRequired: state.phase !== "reviewed",
    nextAction:
      "Preserve this app, its starter source and private work. Complete the normal current app review if needed, then call prepare_github_draft_pr_reconciliation for this same owned draft PR with recovery: reopen-current-owned-draft. Builder verifies the owned publication and opens a fresh private candidate from its current draft and base without replaying the ambiguous old review. Read preserved work as needed, deliberately edit the current candidate, validate it and review both diffs before sealing a new proposal and requesting exact publication approval. Do not replace the source or start another app build.",
  };
};

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
  | "review-app"
  | "select-source"
  | "use-current-review";

const prerequisiteReasons = [
  "candidate_missing",
  "candidate_review_missing",
  "candidate_validation_missing",
  "workflow_not_reviewed",
  "selected_source_missing",
  "source_not_existing_repository",
  "owned_published_draft_recovery",
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
  const ownedRecovery = ownedPublishedDraftRecovery(state);
  if (state.phase !== "reviewed") {
    return diagnostic(
      "workflow_not_reviewed",
      "review-app",
      `The current app workflow has not retained a completed review. Inspect its current status and continue the normal app review workflow before preparing reconciliation. Do not infer a validation failure or rerun completed checks solely from this missing review.${ownedRecovery === undefined ? "" : ` ${ownedRecovery.nextAction}`}`,
    );
  }
  if (ownedRecovery !== undefined) {
    return diagnostic(
      "owned_published_draft_recovery",
      prepareReconciliation,
      ownedRecovery.nextAction,
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
  /** Diagnostic projection from the caller's existing verified candidate-source authority. */
  resolvedSourceDigest?: string;
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
      "The candidate has no retained reconciliation review. If its validation is complete, use review_github_draft_pr_reconciliation with optional diff inspection as needed. Otherwise resume candidate validation first.",
    );
  }
  if (candidate.validation === undefined) {
    return diagnostic(
      "candidate_validation_missing",
      "resume-validation",
      "The candidate has no completed validation receipt. Resume validate_github_draft_pr_reconciliation using its returned nextCommand until it reports validated, then review the current merge. Individual passed commands do not establish that the sequence finished.",
    );
  }
  const sourceDigest = input.resolvedSourceDigest ?? state.githubSource?.digest;
  if (state.phase !== "reviewed" || sourceDigest === undefined) {
    return draftPreparationPrerequisiteDiagnostic(state);
  }
  if (sourceDigest !== candidate.githubSourceDigest) {
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
      "The seal request refers to a different reconciliation review. Use the current review result when sealing. If that result is unavailable, review the current candidate again; a stale seal argument alone does not require rerunning validation.",
    );
  }
  return null;
};

export const draftPrerequisiteMessage = (
  value: PrerequisiteDiagnostic | null,
  fallback: string,
): string =>
  value === null ? fallback : `${value.reason} (${value.recovery}): ${value.nextAction}`;
