import { defineTool } from "eve/tools";
import { z } from "zod";

import { prepareOrReuseDependencies } from "@/lib/agent/target-dependency-preparation";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Diagnostic-only dependency readiness check. Normal planning prepares or reuses the verified dependency closure automatically; callers never need to select this tool for the app workflow to continue. No provider or target-repository mutation is available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().optional(),
  }),
  async execute({ expectedAppSpecDigest }, ctx) {
    void expectedAppSpecDigest;
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
      sessionId: ctx.session.id,
      callId: ctx.callId,
      environment: process.env,
      getSandbox: () => ctx.getSandbox(),
    });
    return { ...prepared.receipt, reused: prepared.reused };
  },
});
