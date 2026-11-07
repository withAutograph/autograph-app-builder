import { defineTool } from "eve/tools";
import { nativeTargetAuthOnlyDeliveryPlanInputSchema } from "../../lib/provisioning/native-target-onboarding-transport";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan Gateway and static-app Preview delivery for the retained Auth-only target after its isolated Auth resource is prepared. Reads the same saved operation, owner, resource approval, published source and registered project. Returns the exact delivery plan for separate approval; creates no deployment or product-data grants.",
  inputSchema: nativeTargetAuthOnlyDeliveryPlanInputSchema,
  async execute(input, ctx) {
    const { nativeTargetOnboardingRuntimeForSession } =
      await import("../../lib/agent/native-target-onboarding-runtime");
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.planAuthOnlyDelivery(input, ctx);
  },
});
