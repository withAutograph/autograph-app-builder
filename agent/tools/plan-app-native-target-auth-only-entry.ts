import { defineTool } from "eve/tools";
import { nativeTargetAuthOnlyEntryPlanInputSchema } from "../../lib/provisioning/native-target-onboarding-transport";

export default defineTool({
  availableInSubagents: false,
  description:
    "Read the retained organization or signup-policy approval intent for this Auth-only Preview delivery. Returns only saved operation identifiers and digests; the controlled email list and verified owner proof remain private. Creates no account, app database or product-data grants.",
  inputSchema: nativeTargetAuthOnlyEntryPlanInputSchema,
  async execute(input, ctx) {
    const { nativeTargetOnboardingRuntimeForSession } =
      await import("../../lib/agent/native-target-onboarding-runtime");
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.planAuthOnlyEntry(input, ctx);
  },
});
