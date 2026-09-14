import { defineHook } from "eve/hooks";
import {
  productRequestState,
  retainProductRequest,
} from "../../lib/agent/product-source-review-state";

export default defineHook({
  events: {
    "message.received"(event) {
      productRequestState.update((current) =>
        retainProductRequest(
          current,
          event.data.message,
          `${event.data.turnId}:${event.data.sequence}`,
        ),
      );
    },
  },
});
