import { observePlannedAuthoringInspection } from "../../lib/agent/planned-proposal-authoring";
import { defineHook } from "eve/hooks";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
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
  observedIntent: boolean;
}>("autograph-app-builder.preapproval-authoring-boundary.v1", () => ({
  blocked: false,
  observedIntent: false,
  pendingCalls: [],
  pendingInputs: [],
}));
const record = async (ctx: HookContext, completed = false, blocked = false, cancelled = false) => {
  if ("appSpec" in appBuilderWorkflowState.get()) {
    boundary.update((current) => ({ ...current, observedIntent: true }));
  }
  const state = boundary.get();
  if (!state.observedIntent) {
    return;
  }
  const decision = currentAuthoringDecision(ctx, {
    blocked: blocked || state.blocked || state.pendingCalls.length > 0,
    completed,
    pendingInput: state.pendingInputs.length > 0,
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
    async "action.result"(event, ctx) {
      observePlannedAuthoringInspection(event, ctx);
      const resultFailed =
        event.data.error !== undefined ||
        (event.data.result.kind === "tool-result" && event.data.result.isError === true);
      boundary.update((current) => ({
        ...current,
        pendingCalls: current.pendingCalls.filter((callId) => callId !== event.data.result.callId),
        blocked: current.blocked || event.data.status !== "completed" || resultFailed,
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
    async "turn.cancelled"(_event, ctx) {
      await record(ctx, false, true, true);
    },
    async "turn.completed"(_event, ctx) {
      await record(ctx, true);
    },
    async "turn.failed"(_event, ctx) {
      await record(ctx, false, true);
    },
    async "turn.started"(_event, ctx) {
      boundary.update((current) => ({ ...current, blocked: false, pendingCalls: [] }));
      await record(ctx);
    },
  },
});
