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
    "message.received"(event, ctx) {
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
