import { defineDynamic, defineInstructions } from "eve/instructions";

import { completionGuidance } from "@/lib/agent/completion-guidance";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineDynamic({
  events: {
    "turn.started": () =>
      defineInstructions({
        content: completionGuidance(appBuilderWorkflowState.get()),
      }),
  },
});
