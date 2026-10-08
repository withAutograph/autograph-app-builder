import { defineHook } from "eve/hooks";
import type { HookContext } from "eve/hooks";
import { defineState } from "eve/context";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import { assertApprovedPrivateApplySession } from "../../lib/agent/private-apply-authority";
import { decideApprovedBuildContinuation } from "../../lib/agent/approved-build-continuation";
import { recordApprovedBuildDecision } from "../../lib/agent/approved-build-continuation-runtime";

const boundary = defineState<{ pendingInputs: string[]; blocked: boolean }>(
  "autograph-app-builder.approved-build-boundary.v1",
  () => ({ blocked: false, pendingInputs: [] }),
);
const record = async (ctx: HookContext, forced?: "working" | "blocked") => {
  const current = boundary.get();
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
    state: appBuilderWorkflowState.get(),
    turnId: ctx.session.turn.id,
    turnSequence: ctx.session.turn.sequence,
  });
  if (forced !== undefined) {
    decision.decision = forced;
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
      if (
        event.data.result.kind === "tool-result" &&
        ["accept_app_spec", "apply_app_creation", "validate_app_creation"].includes(
          event.data.result.toolName,
        )
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
