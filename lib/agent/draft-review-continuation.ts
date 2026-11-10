import type { AppBuilderWorkflowState } from "./workflow-state";

const nextDraftReviewCall = (
  state: Extract<AppBuilderWorkflowState, { phase: "validated" | "reviewed" }>,
) => {
  if (
    state.phase === "reviewed" &&
    state.githubDraftProposal !== undefined &&
    state.publishedGitHubDraftProposalDigest === state.githubDraftProposal.proposal.digest
  ) {
    return { tool: "read_github_pr_delivery" as const, input: {} };
  }
  if (
    state.phase === "reviewed" &&
    (state.githubDraftProposal !== undefined || state.existingDraftUpdate !== undefined)
  ) {
    return { tool: "artifact_workflow_status" as const, input: {} };
  }
  if (state.phase === "reviewed" && state.githubDestinationReview !== undefined) {
    const source =
      state.githubSource === undefined
        ? { expectedDestinationReviewDigest: state.githubDestinationReview.digest }
        : { expectedGitHubSourceDigest: state.githubSource.digest };
    return {
      tool: "seal_github_draft_pr_proposal" as const,
      input: {
        ...source,
        expectedReviewDigest: state.reviewReceipt.digest,
        title: `Update ${state.appSpec.appId}`.slice(0, 120),
      },
    };
  }
  return { tool: "prepare_github_draft_review" as const, input: {} };
};

/** An ordinary review read, never publication consent or evidence that the app works. */
export const draftReviewAfterTechnicalValidation = (state: AppBuilderWorkflowState) => {
  if (state.phase !== "validated" && state.phase !== "reviewed") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- An unvalidated workflow has no draft-review continuation.
    return undefined;
  }
  return {
    status: "available" as const,
    nextCall: nextDraftReviewCall(state),
    guidance:
      "For requested GitHub delivery, continue normal draft review and its exact publication approval using the saved repository. A draft saves reviewable work without releasing it. Retain failed or unverified browser outcomes; they do not invalidate passed repository commands or prevent draft review. After publication, use the owned draft's normal current-base reconciliation and candidate validation when a shared source repair must be adopted, then rerun the affected app-owned behavior checks there. Do not claim a usable app, Ready, merge or deployment from this continuation.",
  };
};
