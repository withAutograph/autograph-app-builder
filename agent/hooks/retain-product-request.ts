import { authenticatedInternalBuildMessage } from "../../lib/agent/approved-build-continuation-runtime";
import { defineHook } from "eve/hooks";
import {
  productRequestState,
  retainProductRequest,
  retainProductInputs,
  retainProductResolutions,
} from "../../lib/agent/product-source-review-state";

export default defineHook({
  events: {
    "input.requested"(event) {
      productRequestState.update((current) => retainProductInputs(current, event.data.requests));
    },
    "input.resolved"(event) {
      productRequestState.update((current) =>
        retainProductResolutions(current, event.data.resolutions),
      );
    },
    async "message.received"(event, ctx) {
      if (
        await authenticatedInternalBuildMessage(ctx, {
          message: event.data.message,
          messageSequence: event.data.sequence,
          turnId: event.data.turnId,
        })
      ) {
        return;
      }
      productRequestState.update((current) =>
        retainProductRequest(
          current,
          event.data.message,
          `${event.data.turnId}:${event.data.sequence}`,
          ctx.session.turn.sequence === 0 && event.data.sequence === 0,
        ),
      );
    },
  },
});
