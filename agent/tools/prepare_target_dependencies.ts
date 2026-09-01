import { defineTool } from "eve/tools";
import { z } from "zod";

import { prepareOrReuseDependencies } from "@/lib/agent/target-dependency-preparation";
import {
  appBuilderWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";

export default defineTool({
  description:
    "Diagnostic-only dependency readiness check. Normal planning prepares or reuses the verified dependency closure automatically; callers never need to select this tool for the app workflow to continue. No provider or target-repository mutation is available.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedAppSpecDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "target dependency preparation");
    if (current.phase === "empty" || current.phase === "prepared")
      throw new Error(
        "Accept a build-ready AppSpec before preparing target dependencies.",
      );
    const prepared = await prepareOrReuseDependencies({
      current,
      expectedAppSpecDigest,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      environment: process.env,
      getSandbox: () => ctx.getSandbox(),
    });
    return { ...prepared.receipt, reused: prepared.reused };
  },
});
