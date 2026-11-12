/* oxlint-disable github/filenames-match-regex, unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
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

import { observeNormalizedChangeSet } from "./change_set_status";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import { createReviewedChangeSetReceipt } from "@/lib/repository/reviewed-change-set";
import { reviewedChangeSetSummary } from "@/lib/agent/review-result-summaries";
import { currentDirectProductionGrant } from "@/lib/agent/direct-production-state";
import { draftReviewAfterTechnicalValidation } from "@/lib/agent/draft-review-continuation";
import { checkedNativeToolResult } from "@/lib/eve/payload-envelope";

export interface ChangeSetAcceptanceRuntime {
  observeChangeSet: typeof observeNormalizedChangeSet;
  reviewSource: typeof reviewAppliedProductSource;
  prepareSourceReview?: typeof prepareAppliedProductSourceReview;
  finalizeSourceReview?: typeof finalizeAppliedProductSourceReview;
  readDirectProductionGrant?: typeof currentDirectProductionGrant;
}
const changeSetAcceptanceRuntime: ChangeSetAcceptanceRuntime = {
  observeChangeSet: observeNormalizedChangeSet,
  reviewSource: reviewAppliedProductSource,
  prepareSourceReview: prepareAppliedProductSourceReview,
  finalizeSourceReview: finalizeAppliedProductSourceReview,
  readDirectProductionGrant: currentDirectProductionGrant,
};
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
      const { changeSet, observed } = await runtime.observeChangeSet({
        sandbox: await ctx.getSandbox(),
        state,
      });
      const reviewInput = {
        abortSignal: ctx.abortSignal,
        appSpec: state.appSpec,
        applyReceipt: state.applyReceipt,
        normalizedChanges: changeSet.changes,
        observed,
        artifacts: state.artifacts,
        callId: ctx.callId,
        getSandbox: async () => await ctx.getSandbox(),
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
            status: "source_review_pending",
            sourceReview: prepared.reference,
            nextAction: { tool: "review-current-product-source", input: prepared.reference },
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
      const nextDeliveryStep = () => {
        const grant = runtime.readDirectProductionGrant?.(ctx, { appId: state.appSpec.appId });
        const current = appBuilderWorkflowState.get();
        if (
          grant === undefined &&
          (current.phase !== "reviewed" ||
            (current.githubDestinationReview === undefined &&
              current.existingDraftUpdate === undefined))
        ) {
          return {};
        }
        const draftReview = draftReviewAfterTechnicalValidation(
          current,
          grant !== undefined,
          ctx.session.id,
        );
        return draftReview === undefined ? {} : { nextCall: draftReview.nextCall };
      };
      if (state.phase === "reviewed") {
        const expectedReceipt = createReviewedChangeSetReceipt(
          changeSet,
          state.reviewReceipt.reviewedByCallId,
        );
        if (expectedReceipt.digest === state.reviewReceipt.digest) {
          return checkedNativeToolResult(
            {
              ...reviewedChangeSetSummary({
                productAcceptance,
                receipt: state.reviewReceipt,
                reused: true,
                sessionId: ctx.session.id,
                sourceAssessment,
              }),
              ...nextDeliveryStep(),
            },
            metadata,
          );
        }
      }
      const receipt = createReviewedChangeSetReceipt(changeSet, ctx.callId);
      updateExactWorkflow({
        expected: state,
        operation: "destination change-set acceptance",
        transition: () => {
          type ReviewedState = Extract<
            ReturnType<typeof appBuilderWorkflowState.get>,
            { phase: "reviewed" }
          >;
          const appSpec = { appSpec: state.appSpec };
          const backend: Pick<ReviewedState, "appBackendKind"> = {};
          if (state.appBackendKind !== undefined) {
            backend.appBackendKind = state.appBackendKind;
          }
          const applied = { applyReceipt: state.applyReceipt, artifacts: state.artifacts };
          const publication: Pick<ReviewedState, "publishedGitHubDraftProposalDigest"> = {};
          if (state.publishedGitHubDraftProposalDigest !== undefined) {
            publication.publishedGitHubDraftProposalDigest =
              state.publishedGitHubDraftProposalDigest;
          }
          const dependency = { dependencyReceipt: state.dependencyReceipt };
          const github: Pick<
            ReviewedState,
            "githubSource" | "githubDestinationReview" | "githubDestinationReviewRead"
          > = {};
          if (state.githubSource !== undefined) {
            github.githubSource = state.githubSource;
          }
          if (state.githubDestinationReview !== undefined) {
            github.githubDestinationReview = state.githubDestinationReview;
          }
          if (state.githubDestinationReviewRead !== undefined) {
            github.githubDestinationReviewRead = state.githubDestinationReviewRead;
          }
          return {
            ...appSpec,
            ...backend,
            ...applied,
            ...publication,
            ...dependency,
            ...github,
            identityReceipt: state.identityReceipt,
            phase: "reviewed",
            preparedByCallId: state.preparedByCallId,
            proposal: state.proposal,
            reviewReceipt: receipt,
            sourceReceipt: state.sourceReceipt,
            validationReceipt: state.validationReceipt,
            version: APP_BUILDER_WORKFLOW_VERSION,
            workspace: state.workspace,
          };
        },
      });
      return checkedNativeToolResult(
        {
          ...reviewedChangeSetSummary({
            productAcceptance,
            receipt,
            reused: false,
            sessionId: ctx.session.id,
            sourceAssessment,
          }),
          ...nextDeliveryStep(),
        },
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
