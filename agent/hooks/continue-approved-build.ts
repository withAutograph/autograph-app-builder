import { currentDirectProductionGrant } from "../../lib/agent/direct-production-state";
import { repositoryProductionNativeStatusSchema } from "../../lib/provisioning/repository-production-native-status-contract";
import {
  invalidateGitHubPrDeliveryCallsForTurn,
  gitHubPrDeliveryAuthorityProjectionChanged,
} from "../../lib/agent/github-pr-delivery-authority-state";
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
import {
  directProductionProgressState,
  recordDirectProductionProgress,
} from "../../lib/agent/direct-production-progress";
import { hasCurrentProductBehaviorPreview } from "../../lib/agent/product-behavior-state";
import { workingPreviewState } from "../../lib/agent/working-preview-state";

const preparedReviewResult = z.object({ status: z.literal("source_review_pending") });
const completedReviewResult = z.object({
  sourceReview: z.object({ outcomeRef: z.string().min(1) }),
});

const draftPublished = z.object({
  appSourceRecording: z.object({ status: z.literal("recorded") }),
});
const setupState = z.object({ state: z.literal("ready") });
const preparedSetup = z.object({ setup: setupState });
const mergedDelivery = z.object({
  status: z.literal("merged"),
  nativeProduction: repositoryProductionNativeStatusSchema.optional(),
  schemaUpdatePending: z.literal(true).optional(),
});
const finishedDeliveryTool = "finish-github-pr-delivery";
const observeProductionTool = "observe-app-production";
const liveStage = "live";
const activationUnavailable = "activation-unavailable";
const deliveryProgress = (toolName: string, output: z.infer<ReturnType<typeof z.json>>) => {
  if (toolName === "publish_github_draft_pr" && draftPublished.safeParse(output).success) {
    return "draft";
  }
  if (
    (toolName === "prepare-app-production" && preparedSetup.safeParse(output).success) ||
    (toolName === "get-app-production" && setupState.safeParse(output).success)
  ) {
    return "setup";
  }
  if (toolName === finishedDeliveryTool) {
    const delivered = mergedDelivery.safeParse(output);
    if (delivered.success) {
      if (delivered.data.schemaUpdatePending === true) {
        return "schema-update-pending";
      }
      return delivered.data.nativeProduction?.requestedRevision === "live"
        ? liveStage
        : activationUnavailable;
    }
  }
  if (toolName === observeProductionTool) {
    const observed = repositoryProductionNativeStatusSchema.safeParse(output);
    if (observed.data?.requestedRevision === "live") {
      return liveStage;
    }
  }
  return null;
};

const boundary = defineState<{ pendingInputs: string[]; blocked: boolean }>(
  "autograph-app-builder.approved-build-boundary.v1",
  () => ({ blocked: false, pendingInputs: [] }),
);
const record = async (ctx: HookContext, forced?: "working" | "blocked") => {
  const current = boundary.get();
  const state = appBuilderWorkflowState.get();
  const grant = "appSpec" in state ? currentDirectProductionGrant(ctx, state.appSpec) : undefined;
  const progress = directProductionProgressState.get();
  const decision = decideApprovedBuildContinuation({
    directProduction: grant,
    releaseFinished:
      progress !== null &&
      progress.grantDigest === grant?.digest &&
      [liveStage, activationUnavailable].includes(progress.stage),
    adapterSessionId: ctx.session.id,
    repositoryAccess: repositoryAccessReceiptState.get(),

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
    state,
    sourcePrerequisite: currentLocalSourcePrerequisite(state, ctx.session.id),
    turnId: ctx.session.turn.id,
    turnSequence: ctx.session.turn.sequence,
  });
  if (forced === "blocked" || (forced === "working" && decision.sourcePrerequisite === undefined)) {
    decision.decision = forced;
  }
  if (forced === undefined && decision.decision === "runnable") {
    const preview = workingPreviewState.get();
    const privatePreviewPhase =
      grant === undefined && (state.phase === "applied" || state.phase === "validated");
    const matchingLivePreview =
      privatePreviewPhase &&
      preview?.receipt.appId === state.appSpec.appId &&
      Date.parse(preview.receipt.expiresAt) > Date.now();
    if (matchingLivePreview && hasCurrentProductBehaviorPreview(preview.commandId)) {
      decision.decision = "settled";
    } else {
      const delivered = authenticatedBuildDelivery.get();
      if (
        delivered?.turnId === ctx.session.turn.id &&
        delivered.progress === currentApprovedBuildProgress()
      ) {
        decision.decision = "blocked";
        decision.reason = "build_no_progress";
      }
    }
  }
  if (
    decision.scope === undefined &&
    decision.currentSpec === undefined &&
    !gitHubPrDeliveryAuthorityProjectionChanged()
  ) {
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
        const grant =
          "appSpec" in state ? currentDirectProductionGrant(ctx, state.appSpec) : undefined;
        const observed = z.json().safeParse(result.output);
        const stage =
          grant !== undefined && observed.success
            ? deliveryProgress(result.toolName, observed.data)
            : null;
        if (grant !== undefined && stage !== null) {
          const current = directProductionProgressState.get();
          // A standalone status read cannot mark an unmerged release as live.
          const canRecord =
            result.toolName !== observeProductionTool ||
            (current?.grantDigest === grant.digest && current.stage === activationUnavailable);
          if (canRecord) {
            recordDirectProductionProgress(grant.digest, stage);
          }
        }
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
      if (gitHubPrDeliveryAuthorityProjectionChanged()) {
        await record(ctx, "working");
        return;
      }
      if (
        event.data.result.kind === "tool-result" &&
        [
          "accept_app_spec",
          "apply_app_creation",
          "release-app-production",
          "validate_app_creation",
          "publish_github_draft_pr",
          "prepare-app-production",
          "get-app-production",
          finishedDeliveryTool,
          observeProductionTool,
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
    async "turn.cancelled"(event, ctx) {
      invalidateGitHubPrDeliveryCallsForTurn(event.data.turnId);
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
