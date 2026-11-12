import type { AppBuilderWorkflowState } from "./workflow-state";
import { reviewedChangeSetReference } from "./review-result-summaries";
import { approvalReceiptForExistingDraftUpdate } from "./approval-receipt";

const nextDraftReviewCall = (
  state: Extract<AppBuilderWorkflowState, { phase: "validated" | "reviewed" }>,
  sessionId?: string,
) => {
  if (
    state.phase === "reviewed" &&
    state.githubDraftProposal !== undefined &&
    state.publishedGitHubDraftProposalDigest === state.githubDraftProposal.proposal.digest
  ) {
    return { tool: "read_github_pr_delivery" as const, input: {} };
  }
  if (state.phase === "reviewed" && state.existingDraftUpdate !== undefined) {
    const { proposal } = state.existingDraftUpdate;
    return {
      tool: "update_github_draft_pr" as const,
      input: {
        approvalReceipt: approvalReceiptForExistingDraftUpdate(proposal),
        expectedProposalDigest: proposal.digest,
      },
    };
  }
  if (state.phase === "reviewed" && state.githubDraftProposal !== undefined) {
    return { tool: "artifact_workflow_status" as const, input: {} };
  }
  if (state.phase === "reviewed" && state.githubDestinationReview !== undefined) {
    const title = `Update ${state.appSpec.appId}`.slice(0, 120);
    if (sessionId !== undefined) {
      return {
        tool: "seal_github_draft_pr_proposal" as const,
        input: {
          reviewReference: reviewedChangeSetReference(state.reviewReceipt.digest, sessionId),
          title,
        },
      };
    }
    const source =
      state.githubSource === undefined
        ? { expectedDestinationReviewDigest: state.githubDestinationReview.digest }
        : { expectedGitHubSourceDigest: state.githubSource.digest };
    return {
      tool: "seal_github_draft_pr_proposal" as const,
      input: {
        ...source,
        expectedReviewDigest: state.reviewReceipt.digest,
        title,
      },
    };
  }
  return { tool: "prepare_github_draft_review" as const, input: {} };
};

/** An ordinary review read, never publication consent or evidence that the app works. */
export const draftReviewAfterTechnicalValidation = (
  state: AppBuilderWorkflowState,
  directProduction = false,
  sessionId?: string,
) => {
  if (state.phase !== "validated" && state.phase !== "reviewed") {
    // oxlint-disable-next-line unicorn/no-useless-undefined -- An unvalidated workflow has no draft-review continuation.
    return undefined;
  }
  return {
    status: "available" as const,
    nextCall: nextDraftReviewCall(state, sessionId),
    guidance: directProduction
      ? "Continue the approved Arrusted Production release using the saved destination. Required repository commands passed. Use nextCall to review and seal the exact candidate, then publish, prepare managed data and access, and finish reviewed merge and native availability. Preview and optional browser results do not delay this release."
      : "For requested GitHub delivery, continue normal draft review and its exact publication approval using the saved repository. A draft saves reviewable work without releasing it. Retain failed or unverified browser outcomes; they do not invalidate passed repository commands or prevent draft review. After publication, use the owned draft's normal current-base reconciliation and candidate validation when a shared source repair must be adopted, then rerun the affected app-owned behavior checks there. Do not claim a usable app, Ready, merge or deployment from this continuation.",
  };
};
