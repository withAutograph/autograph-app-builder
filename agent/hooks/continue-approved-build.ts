import { currentLocalSourcePrerequisite } from "../../lib/agent/local-source-prerequisite-state";
import { repositoryAccessReceiptState } from "../../lib/agent/repository-access-state";

import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { z } from "zod";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { assertApprovedPrivateApplySession } from "../../lib/agent/private-apply-authority";
import {
  approvedBuildProgress,
  decideApprovedBuildContinuation,
} from "../../lib/agent/approved-build-continuation";
import {
  approvedBuildReviewProgress,
  authenticatedBuildDelivery,
  currentApprovedBuildProgress,
  recordApprovedBuildDecision,
} from "../../lib/agent/approved-build-continuation-runtime";
import { hasCurrentProductBehaviorPreview } from "../../lib/agent/product-behavior-state";
import { workingPreviewState } from "../../lib/agent/working-preview-state";

const preparedReviewResult = z.object({ status: z.literal("source_review_pending") });
const completedReviewResult = z.object({
  sourceReview: z.object({ outcomeRef: z.string().min(1) }),
});

const boundary = defineState<{ pendingInputs: string[]; blocked: boolean }>(
  "autograph-app-builder.approved-build-boundary.v1",
  () => ({ blocked: false, pendingInputs: [] }),
);
const record = async (ctx: HookContext, forced?: "working" | "blocked") => {
  const current = boundary.get();
  const state = appBuilderWorkflowState.get();
  const decision = decideApprovedBuildContinuation({
    adapterSessionId: ctx.session.id,
    approvalMatches: (scope) => {
      try {
        assertApprovedPrivateApplySession(scope);
        return true;
      } catch {
        return false;
      }
    },
    blocked: current.blocked,
    pendingInput: current.pendingInputs.length > 0,
    repositoryAccess: repositoryAccessReceiptState.get(),
    sourcePrerequisite: currentLocalSourcePrerequisite(state, ctx.session.id),
    state,
    turnId: ctx.session.turn.id,
    turnSequence: ctx.session.turn.sequence,
  });
  if (forced === "blocked" || (forced === "working" && decision.sourcePrerequisite === undefined)) {
    decision.decision = forced;
  }
  const delivered = authenticatedBuildDelivery.get();
  if (
    forced === undefined &&
    decision.decision === "runnable" &&
    delivered?.turnId === ctx.session.turn.id &&
    delivered.progress === currentApprovedBuildProgress()
  ) {
    const preview = workingPreviewState.get();
    const previewReady =
      state.phase === "applied" &&
      preview?.receipt.appId === state.appSpec.appId &&
      Date.parse(preview.receipt.expiresAt) > Date.now() &&
      hasCurrentProductBehaviorPreview(preview.commandId);
    decision.decision = previewReady ? "settled" : "blocked";
    if (!previewReady) {
      decision.reason = "build_no_progress";
    }
  }
  if (decision.scope === undefined && decision.currentSpec === undefined) {
    return;
  }
  await recordApprovedBuildDecision(ctx, decision);
};
/** Observe actual workflow/approval state; this hook never sends a message or executes an app stage. */
export default defineHook({
  events: {
    async "action.result"(event, ctx) {
      const { result, status } = event.data;
      if (status === "completed" && result.kind === "tool-result" && result.isError !== true) {
        const state = appBuilderWorkflowState.get();
        if (state.phase === "validated") {
          const buildProgress = approvedBuildProgress(state);
          if (
            result.toolName === "accept_change_set" &&
            preparedReviewResult.safeParse(result.output).success
          ) {
            approvedBuildReviewProgress.update((currentReview) =>
              currentReview?.buildProgress === buildProgress
                ? currentReview
                : { buildProgress, stage: "prepared" },
            );
          } else if (
            result.toolName === "review-current-product-source" &&
            completedReviewResult.safeParse(result.output).success
          ) {
            approvedBuildReviewProgress.update(() => ({ buildProgress, stage: "assessed" }));
          }
        }
      }
      if (
        event.data.result.kind === "tool-result" &&
        [
          "accept_app_spec",
          "apply_app_creation",
          "validate_app_creation",
          "prepare_workspace",
          "prepare_app_creation",
        ].includes(event.data.result.toolName)
      ) {
        await record(ctx, "working");
      }
    },
    "input.requested"(event) {
      boundary.update((current) => ({
        ...current,
        pendingInputs: [
          ...new Set([
            ...current.pendingInputs,
            ...event.data.requests.map((request) => request.requestId),
          ]),
        ],
      }));
    },
    "input.resolved"(event) {
      const resolved = new Set(event.data.resolutions.map((resolution) => resolution.requestId));
      boundary.update((current) => ({
        ...current,
        pendingInputs: current.pendingInputs.filter((id) => !resolved.has(id)),
      }));
    },
    "step.failed"() {
      boundary.update((current) => ({ ...current, blocked: true }));
    },
    async "turn.cancelled"(_event, ctx) {
      await record(ctx, "blocked");
    },
    async "turn.completed"(_event, ctx) {
      await record(ctx);
    },
    async "turn.failed"(_event, ctx) {
      await record(ctx, "blocked");
    },
    async "turn.started"(_event, ctx) {
      boundary.update((current) => ({ ...current, blocked: false }));
      await record(ctx, "working");
    },
  },
});
