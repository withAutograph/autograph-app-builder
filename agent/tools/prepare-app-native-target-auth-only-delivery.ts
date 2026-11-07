import { defineWorkflowTool } from "eve/tools";
import { nativeTargetAuthOnlyDeliveryPreparationInputSchema } from "../../lib/eve/private-native-target-auth-only-delivery-approval";

export default defineWorkflowTool({
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) return "user-approval" as const;
      try {
        const { nativeTargetOnboardingRuntimeForSession } =
          await import("../../lib/agent/native-target-onboarding-runtime");
        const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
        return (await runtime.hasAuthOnlyDeliveryApproval(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied" as const,
          reason:
            "The current owner and exact retained Auth-only delivery plan could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        const { nativeTargetOnboardingRuntimeForSession } =
          await import("../../lib/agent/native-target-onboarding-runtime");
        const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
        await runtime.authorizeAuthOnlyDeliveryApprovalResponse(ctx);
        return { status: "allowed" as const };
      } catch {
        return {
          status: "rejected" as const,
          reason: "Only the current owner can approve this exact retained Auth-only delivery plan.",
        };
      }
    },
  },
  availableInSubagents: false,
  description:
    "Approve and deliver exactly the retained Gateway and static-app Preview plan for this Auth-only target. Reuses the original settled approval and operation on retry, and reconciles uncertain delivery. Creates no app database or product-data grants; deployment readiness is not signup acceptance.",
  async *execute(input, ctx) {
    "use workflow";
    const { nativeTargetOnboardingRuntimeForSession } =
      await import("../../lib/agent/native-target-onboarding-runtime");
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    const result = await runtime.prepareAuthOnlyDelivery(input, ctx);
    if (result.status === "pending-owner") {
      yield {
        authIdentityLink: result.authIdentityLink,
        authIdentityLinkExpiresAt: result.authIdentityLinkExpiresAt,
      };
    }
    return result;
  },
  inputSchema: nativeTargetAuthOnlyDeliveryPreparationInputSchema,
});
