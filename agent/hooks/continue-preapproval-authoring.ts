import { observePlannedAuthoringInspection } from "../../lib/agent/planned-proposal-authoring";
import { defineHook } from "eve/hooks";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { currentInitialBuildAuthoring } from "../../lib/agent/initial-build-authoring";
import { defineState } from "eve/context";
import type { HookContext } from "eve/hooks";
import {
  currentAuthoringDecision,
  recordPreapprovalAuthoringDecision,
  authenticatedAuthoringDelivery,
} from "../../lib/agent/preapproval-authoring-runtime";

const boundary = defineState<{
  pendingInputs: string[];
  pendingCalls: string[];
  blocked: boolean;
  draftingToolFailed?: boolean;
  observedIntent: boolean;
}>("autograph-app-builder.preapproval-authoring-boundary.v1", () => ({
  pendingInputs: [],
  pendingCalls: [],
  blocked: false,
  observedIntent: false,
}));
const record = async (ctx: HookContext, completed = false, blocked = false, cancelled = false) => {
  if ("appSpec" in appBuilderWorkflowState.get()) {
    boundary.update((current) => ({ ...current, observedIntent: true }));
  }
  const state = boundary.get();
  if (!state.observedIntent) {
    return;
  }
  // A failed drafting tool does not retire a valid first plan. The retry can
  // correct the draft and present approval, but cannot apply or release it.
  const failedWithoutInitialPlan =
    state.draftingToolFailed === true && currentInitialBuildAuthoring(ctx.session.id) === undefined;
  const decision = currentAuthoringDecision(ctx, {
    completed,
    pendingInput: state.pendingInputs.length > 0,
    blocked: blocked || state.blocked || failedWithoutInitialPlan || state.pendingCalls.length > 0,
  });
  if (cancelled) {
    decision.reason = "authoring_cancelled";
  }
  const delivery = authenticatedAuthoringDelivery.get();
  if (
    completed &&
    decision.decision === "runnable" &&
    delivery?.turnId === ctx.session.turn.id &&
    delivery.scopeDigest === decision.scopeDigest
  ) {
    decision.decision = "blocked";
    decision.reason = "authoring_no_progress";
  }
  await recordPreapprovalAuthoringDecision(ctx, decision);
};
/** Drafting is distinct from execution: this hook only records actual native boundaries. */
export default defineHook({
  events: {
    async "turn.started"(_event, ctx) {
      boundary.update((current) => ({
        ...current,
        blocked: false,
        draftingToolFailed: false,
        pendingCalls: [],
      }));
      await record(ctx);
    },
    "actions.requested"(event) {
      boundary.update((current) => ({
        ...current,
        pendingCalls: [
          ...new Set([
            ...current.pendingCalls,
            ...event.data.actions.map((action) => action.callId),
          ]),
        ],
      }));
    },
    async "action.result"(event, ctx) {
      observePlannedAuthoringInspection(event, ctx);
      const { result, status, error } = event.data;
      const resultFailed =
        status === "failed" ||
        error !== undefined ||
        (result.kind === "tool-result" && result.isError === true);
      const failedDraftingTool =
        result.kind === "tool-result" && status !== "rejected" && resultFailed;
      boundary.update((current) => ({
        ...current,
        pendingCalls: current.pendingCalls.filter((callId) => callId !== result.callId),
        blocked: current.blocked || status === "rejected" || (resultFailed && !failedDraftingTool),
        draftingToolFailed: current.draftingToolFailed === true || failedDraftingTool,
      }));
      await record(ctx);
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
      const ids = new Set(event.data.resolutions.map((result) => result.requestId));
      boundary.update((current) => ({
        ...current,
        pendingInputs: current.pendingInputs.filter((id) => !ids.has(id)),
      }));
    },
    "step.failed"() {
      boundary.update((current) => ({ ...current, blocked: true }));
    },
    async "turn.completed"(_event, ctx) {
      await record(ctx, true);
    },
    async "turn.failed"(_event, ctx) {
      await record(ctx, false, true);
    },
    async "turn.cancelled"(_event, ctx) {
      await record(ctx, false, true, true);
    },
  },
});
