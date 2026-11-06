import {
  reviewAppliedProductSource,
  prepareAppliedProductSourceReview,
  finalizeAppliedProductSourceReview,
} from "@/lib/agent/review-applied-product-source";
import { unavailableSourceAssessment } from "@/lib/agent/product-source-review";
import { currentProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";

import { observeNormalizedChangeSet } from "./change-set-status";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";
import { reviewedChangeSetSummary } from "@/lib/agent/review-result-summaries";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";

export interface ChangeSetAcceptanceRuntime {
  observeChangeSet: typeof observeNormalizedChangeSet;
  reviewSource: typeof reviewAppliedProductSource;
  prepareSourceReview?: typeof prepareAppliedProductSourceReview;
  finalizeSourceReview?: typeof finalizeAppliedProductSourceReview;
}
const changeSetAcceptanceRuntime: ChangeSetAcceptanceRuntime = {
  finalizeSourceReview: finalizeAppliedProductSourceReview,
  observeChangeSet: observeNormalizedChangeSet,
  prepareSourceReview: prepareAppliedProductSourceReview,
  reviewSource: reviewAppliedProductSource,
};
type ObservedAcceptance = Awaited<ReturnType<typeof observeNormalizedChangeSet>>;
/** Internal ports preserve optional independent source review without public injection. */
export const createChangeSetAcceptanceTool = (
  runtime: ChangeSetAcceptanceRuntime = changeSetAcceptanceRuntime,
) =>
  defineTool({
    description:
      "Record the current change set after repository validation succeeds. Request independent paid source assessment explicitly with runSourceReview. Reuse only completed source evidence whose current source and requirements still match. Record the reviewed change summary and return a compact receipt with current-session references; the full receipt stays authoritative in this session. Read its complete product/source evidence through change_set_status view=acceptance. This is internal and never publishes or changes an external repository.",
    async execute(input, ctx) {
      const state = appBuilderWorkflowState.get();
      if (state.phase !== "validated" && state.phase !== "reviewed") {
        throw new Error("Run the repository validation before reviewing its changes.");
      }
      const acceptance: ObservedAcceptance = await runtime.observeChangeSet({
        sandbox: await ctx.getSandbox(),
        state,
      });
      const { changeSet, observed } = acceptance;
      const reviewInput = {
        abortSignal: ctx.abortSignal,
        appSpec: state.appSpec,
        applyReceipt: state.applyReceipt,
        artifacts: state.artifacts,
        callId: ctx.callId,
        getSandbox: async () => await ctx.getSandbox(),
        normalizedChanges: changeSet.changes,
        observed,
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      };
      const prepared =
        input.runSourceReview === true &&
        input.sourceReview === undefined &&
        runtime.prepareSourceReview !== undefined
          ? await runtime.prepareSourceReview(reviewInput)
          : undefined;
      if (prepared !== undefined && "reference" in prepared) {
        return checkedNativeToolResult(
          {
            nextAction: { input: prepared.reference, tool: "review-current-product-source" },
            sourceReview: prepared.reference,
            status: "source_review_pending",
          },
          { callId: ctx.callId, toolName: "accept_change_set", turnId: ctx.session.turn.id },
        );
      }
      let sourceAssessment;
      if (prepared !== undefined && "assessment" in prepared) {
        sourceAssessment = prepared.assessment;
      } else if (input.sourceReview !== undefined && runtime.finalizeSourceReview !== undefined) {
        sourceAssessment = await runtime.finalizeSourceReview({
          ...reviewInput,
          reference: input.sourceReview,
        });
      } else if (input.runSourceReview === true || input.sourceReview !== undefined) {
        sourceAssessment = await runtime.reviewSource(reviewInput);
      } else {
        sourceAssessment = unavailableSourceAssessment(
          {
            appSpec: state.appSpec.content ?? "",
            appSpecDigest: state.appSpec.digest,
            clarifications: [],
            files: [],
            omissions: [],
            originalRequest: "",
            sourceDigest: observed.treeDigest,
          },
          "Independent source assessment was not requested.",
        );
      }
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
      const nextState: typeof state = {
        appSpec: state.appSpec,
        applyReceipt: state.applyReceipt,
        artifacts: state.artifacts,
        dependencyReceipt: state.dependencyReceipt,
        identityReceipt: state.identityReceipt,
        phase: "reviewed" as const,
        preparedByCallId: state.preparedByCallId,
        proposal: state.proposal,
        reviewReceipt: receipt,
        sourceReceipt: state.sourceReceipt,
        validationReceipt: state.validationReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: state.workspace,
      };
      if (state.appBackendKind !== undefined) {
        nextState.appBackendKind = state.appBackendKind;
      }
      if (state.publishedGitHubDraftProposalDigest !== undefined) {
        nextState.publishedGitHubDraftProposalDigest = state.publishedGitHubDraftProposalDigest;
      }
      if (state.githubSource !== undefined) {
        nextState.githubSource = state.githubSource;
      }
      if (state.githubDestinationReview !== undefined) {
        nextState.githubDestinationReview = state.githubDestinationReview;
      }
      if (state.githubDestinationReviewRead !== undefined) {
        nextState.githubDestinationReviewRead = state.githubDestinationReviewRead;
      }
      updateExactWorkflow({
        expected: state,
        operation: "destination change-set acceptance",
        transition: () => nextState,
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
    inputSchema: z.strictObject({
      runSourceReview: z.boolean().optional(),
      sourceReview: z
        .strictObject({
          appId: z.string().min(1),
          contextRef: z.string().min(1),
          outcomeRef: z.string().min(1).optional(),
        })
        .optional(),
    }),
  });

export default createChangeSetAcceptanceTool();
