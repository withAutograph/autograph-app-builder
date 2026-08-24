import { defineTool } from "eve/tools";
import { z } from "zod";
import { sourceWorkflowState } from "@/lib/agent/source-state";

export default defineTool({
  description: "Return the durable source-review phase without changing it.",
  inputSchema: z.object({}),
  execute() {
    const state = sourceWorkflowState.get();
    return state.phase === "empty"
      ? state
      : { version: state.version, phase: state.phase, receipt: state.receipt };
  },
});
