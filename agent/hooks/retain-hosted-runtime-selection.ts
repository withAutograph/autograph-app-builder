import { defineHook } from "eve/hooks";

import { retainHostedRuntimePreparationReference } from "../../lib/agent/hosted-runtime-selection-handoff";
import { reportHostedRuntimeHandoffDiagnostic } from "../../lib/agent/hosted-runtime-handoff-diagnostic";

// Module evaluation proves loading only; the result marker proves handler invocation.
reportHostedRuntimeHandoffDiagnostic({ stage: "hook_module_loaded" });

export default defineHook({
  events: {
    "action.result"(event) {
      if (
        event.data.result.kind !== "tool-result" ||
        event.data.result.toolName !== "prepare-app-hosted-runtime"
      ) {
        return;
      }
      reportHostedRuntimeHandoffDiagnostic({
        eventCompleted: event.data.status === "completed",
        isError: event.data.result.isError === true,
        output: event.data.result.output,
        stage: "owner_action_result",
      });
      if (event.data.status !== "completed") {
        return;
      }
      try {
        if (retainHostedRuntimePreparationReference(event.data.result.output)) {
          console.info(
            JSON.stringify({
              event: "autograph.hosted-runtime.reference-retained",
              ownerContext: true,
            }),
          );
        }
      } catch (error) {
        reportHostedRuntimeHandoffDiagnostic({ outcome: "failed", stage: "reference_capture" });
        throw error;
      }
    },
  },
});
