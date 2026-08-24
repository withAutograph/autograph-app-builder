import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  appBuilderWorkflowState,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { inspectPreparedSandboxWorkspace } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Report the durable App Builder workflow phase and verify any prepared repository workspace without mutating it.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const durable = appBuilderWorkflowState.get();
    const observed = await inspectPreparedSandboxWorkspace(
      await ctx.getSandbox(),
    );
    if (durable.phase === "empty") {
      if (observed.state === "absent") return durable;
      appBuilderWorkflowState.update(() => ({
        version: 1,
        phase: "prepared",
        preparedByCallId: "recovered-from-sandbox",
        workspace: observed.workspace,
      }));
      return {
        version: 1 as const,
        phase: "prepared" as const,
        recovered: true,
        workspace: observed.workspace,
      };
    }
    if (observed.state === "absent")
      throw new Error(
        "The durable workflow receipt exists but its sandbox workspace is missing.",
      );
    if (
      JSON.stringify(workflowWorkspace(durable)) !==
      JSON.stringify(observed.workspace)
    )
      throw new Error(
        "The durable workflow receipt does not match the sandbox workspace.",
      );
    return { ...durable, recovered: false };
  },
});
