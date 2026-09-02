import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Accept the exact reviewed UI direction before functional planning may begin. Call this only after the user explicitly asks to finalize functionality.",
  inputSchema: z.strictObject({ expectedRevision: z.string().regex(/^[a-f0-9]{64}$/u) }),
  async execute({ expectedRevision }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (current.phase !== "ui_previewed")
      throw new Error("A current UI preview is required before finalization.");
    if (current.uiPreview.revision !== expectedRevision)
      throw new Error("The reviewed UI preview changed before finalization.");
    updateExactWorkflow({
      expected: current,
      operation: "UI preview finalization",
      transition: () => ({
        ...current,
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "ui_accepted",
        uiAcceptedByCallId: ctx.callId,
      }),
    });
    return { appId: current.uiPreview.appId, revision: expectedRevision, accepted: true };
  },
});
