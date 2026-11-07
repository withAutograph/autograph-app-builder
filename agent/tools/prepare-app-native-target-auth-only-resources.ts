import { defineWorkflowTool } from "eve/tools";
import {
  nativeTargetAuthOnlyResourcePreparationInputSchema,
} from "../../lib/eve/private-native-target-auth-only-resource-approval";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "After the dedicated Preview project has been created, approve and prepare exactly its isolated Auth database resource from the retained resource plan. This applies only the pinned one-resource Auth bootstrap and verified-email Auth schema. It creates no app database, deployment, or product-data grant. Retry uses the original settled approval and retained resource bytes.",
  inputSchema: nativeTargetAuthOnlyResourcePreparationInputSchema,
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) return "user-approval" as const;
      try {
        const { nativeTargetOnboardingRuntimeForSession } =
          await import("../../lib/agent/native-target-onboarding-runtime");
        const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
        return (await runtime.hasAuthOnlyResourceApproval(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied" as const,
          reason: "The current owner and exact retained Auth resource plan could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        const { nativeTargetOnboardingRuntimeForSession } =
          await import("../../lib/agent/native-target-onboarding-runtime");
        const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
        await runtime.authorizeAuthOnlyResourceApprovalResponse(ctx);
        return { status: "allowed" as const };
      } catch {
        return {
          status: "rejected" as const,
          reason: "Only the current owner can approve this exact retained Auth resource plan.",
        };
      }
    },
  },
  async execute(input, ctx) {
    "use workflow";
    const { nativeTargetOnboardingRuntimeForSession } =
      await import("../../lib/agent/native-target-onboarding-runtime");
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.prepareAuthOnlyResources(input, ctx);
  },
});
