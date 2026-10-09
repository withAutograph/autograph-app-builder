import { reviewAppliedProductSource } from "@/lib/agent/review-applied-product-source";
import { currentProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactNormalizedChangeSet } from "./change_set_status";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
  assertCompleteGitHubDestinationReview,
} from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";
import { reviewedChangeSetSummary } from "@/lib/agent/review-result-summaries";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";

export default defineTool({
  description:
    "Record the current reviewed change summary after repository validation succeeds and required complete diff reads finish. Return a compact receipt summary and current-session references; the full receipt stays authoritative in this session. Read its complete product/source evidence through change_set_status view=acceptance. This is internal and never publishes or changes an external repository.",
  async execute(_input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (state.phase !== "validated" && state.phase !== "reviewed") {
      throw new Error("Run the repository validation before reviewing its changes.");
    }
    const changeSet = await exactNormalizedChangeSet({
      sandbox: await ctx.getSandbox(),
      state,
    });
    if (state.githubDestinationReview !== undefined) {
      assertCompleteGitHubDestinationReview(state.githubDestinationReviewRead, changeSet.digest);
    }
    const sourceAssessment = await reviewAppliedProductSource({
      abortSignal: ctx.abortSignal,
      appSpec: state.appSpec,
      applyReceipt: state.applyReceipt,
      artifacts: state.artifacts,
      callId: ctx.callId,
      getSandbox: async () => await ctx.getSandbox(),
      sessionAuth: ctx.session.auth,
      sessionId: ctx.session.id,
    });
    ctx.abortSignal?.throwIfAborted();
    const productAcceptance = productAcceptanceObligations(
      state.appSpec,
      currentProductBehaviorEvidence(state.appSpec.digest, state.applyReceipt.digest),
      sourceAssessment,
    );
    const metadata = {
      callId: ctx.callId,
      toolName: "accept_change_set",
      turnId: ctx.session.turn.id,
    };
    if (state.phase === "reviewed") {
      const expectedReceipt = createReviewedChangeSetReceipt(
        changeSet,
        state.reviewReceipt.reviewedByCallId,
      );
      if (expectedReceipt.digest === state.reviewReceipt.digest) {
        return checkedNativeToolResult(
          reviewedChangeSetSummary({
            productAcceptance,
            receipt: state.reviewReceipt,
            reused: true,
            sessionId: ctx.session.id,
            sourceAssessment,
          }),
          metadata,
        );
      }
    }
    const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
    updateExactWorkflow({
      expected: state,
      operation: "destination change-set acceptance",
      transition: () => ({
        appSpec: state.appSpec,
        applyReceipt: state.applyReceipt,
        artifacts: state.artifacts,
        ...(state.publishedGitHubDraftProposalDigest === undefined
          ? {}
          : { publishedGitHubDraftProposalDigest: state.publishedGitHubDraftProposalDigest }),
        dependencyReceipt: state.dependencyReceipt,
        ...(state.githubSource === undefined ? {} : { githubSource: state.githubSource }),
        ...(state.githubDestinationReview === undefined
          ? {}
          : { githubDestinationReview: state.githubDestinationReview }),
        ...(state.githubDestinationReviewRead === undefined
          ? {}
          : { githubDestinationReviewRead: state.githubDestinationReviewRead }),
        identityReceipt: state.identityReceipt,
        phase: "reviewed",
        preparedByCallId: state.preparedByCallId,
        proposal: state.proposal,
        reviewReceipt: receipt,
        sourceReceipt: state.sourceReceipt,
        validationReceipt: state.validationReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: state.workspace,
      }),
    });
    return checkedNativeToolResult(
      reviewedChangeSetSummary({
        productAcceptance,
        receipt,
        reused: false,
        sessionId: ctx.session.id,
        sourceAssessment,
      }),
      metadata,
    );
  },
  inputSchema: z.strictObject({}),
});
