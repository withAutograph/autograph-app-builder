import { defineHook } from "eve/hooks";
import { observePrivateApplyDecisionEvent } from "../../lib/agent/private-apply-decision-lifecycle";
/** Genuine framework denials are terminal bookkeeping, never execution approval. */
export default defineHook({
  events: {
    "input.requested"(event, ctx) {
      observePrivateApplyDecisionEvent(event, ctx.session.id);
    },
    "input.resolved"(event, ctx) {
      observePrivateApplyDecisionEvent(event, ctx.session.id);
    },
    "action.result"(event, ctx) {
      observePrivateApplyDecisionEvent(event, ctx.session.id);
    },
  },
});
