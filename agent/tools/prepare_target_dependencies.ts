import { defineTool } from "eve/tools";
import { z } from "zod";

import { prepareOrReuseDependencies } from "@/lib/agent/target-dependency-preparation";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Diagnostic-only planning setup. Records checkout-backed dependency metadata; it does not install or verify dependencies. Normal planning performs this automatically. No provider or target-repository mutation is available.",
  inputSchema: z.object({}),
  async execute(_, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase === "empty" ||
      current.phase === "prepared" ||
      current.phase === "ui_previewed" ||
      current.phase === "ui_accepted"
    )
      throw new Error(
        "Finalize the UI and accept a build-ready AppSpec before preparing target dependencies.",
      );
    const prepared = await prepareOrReuseDependencies({
      current,
      callId: ctx.callId,
      getSandbox: () => ctx.getSandbox(),
    });
    return { ...prepared.receipt, reused: prepared.reused };
  },
});
