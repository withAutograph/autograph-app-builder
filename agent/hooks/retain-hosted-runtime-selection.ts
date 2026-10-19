import { defineHook } from "eve/hooks";

import { retainHostedRuntimePreparationReference } from "../../lib/agent/hosted-runtime-selection-handoff";

export default defineHook({
  events: {
    "action.result"(event) {
      if (
        event.data.status !== "completed" ||
        event.data.result.kind !== "tool-result" ||
        event.data.result.toolName !== "prepare-app-hosted-runtime"
      ) {
        return;
      }
      if (retainHostedRuntimePreparationReference(event.data.result.output)) {
        console.info(
          JSON.stringify({
            event: "autograph.hosted-runtime.reference-retained",
            ownerContext: true,
          }),
        );
      }
    },
  },
});
