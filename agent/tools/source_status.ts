import { defineTool } from "eve/tools";
import { z } from "zod";
import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "@/lib/repository/development-source";

export default defineTool({
  description:
    "Return the durable source-review phase, automatically binding the configured local development source when one is available.",
  inputSchema: z.object({}),
  async execute() {
    let state = sourceWorkflowState.get();
    if (state.phase === "empty" && canAutoSelectDevelopmentSource()) {
      const receipt = await developmentSourceReceipt("existing-repository");
      if (receipt !== undefined) {
        sourceWorkflowState.update(() => ({
          version: APP_BUILDER_SOURCE_VERSION,
          phase: "reviewed",
          receipt,
        }));
        state = sourceWorkflowState.get();
      }
    }
    return state.phase === "empty"
      ? state
      : { version: state.version, phase: state.phase, receipt: state.receipt };
  },
});
