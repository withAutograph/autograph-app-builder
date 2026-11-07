import { defineTool } from "eve/tools";
import { nativeTargetAuthOnlyFinalRoutingPlanInputSchema } from "../../lib/eve/private-native-target-auth-only-final-routing-approval";

export default defineTool({
  availableInSubagents: false,
  description:
    "Read the saved final Gateway routing approval intent for this isolated Auth-only Preview. Returns only saved operation identifiers and digests. Does not publish routing or create a deployment.",
  async execute(input, ctx) {
    const { nativeTargetOnboardingRuntimeForSession } =
      await import("../../lib/agent/native-target-onboarding-runtime");
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.planAuthOnlyFinalRouting(input, ctx);
  },
  inputSchema: nativeTargetAuthOnlyFinalRoutingPlanInputSchema,
});
