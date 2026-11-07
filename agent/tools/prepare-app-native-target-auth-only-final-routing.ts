import { defineWorkflowTool } from "eve/tools";
import { nativeTargetAuthOnlyFinalRoutingApprovalInputSchema } from "../../lib/eve/private-native-target-auth-only-final-routing-approval";
import {
  authorizeAuthOnlyFinalRoutingApprovalResponseStep,
  prepareAuthOnlyFinalRoutingStep,
  readAuthOnlyFinalRoutingApprovalStep,
} from "../../lib/agent/prepare-app-native-target-auth-only-step";

export default defineWorkflowTool({
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) {
        return "user-approval" as const;
      }
      try {
        return (await readAuthOnlyFinalRoutingApprovalStep(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied" as const,
          reason:
            "The current owner and exact retained Auth-only final routing operation could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        await authorizeAuthOnlyFinalRoutingApprovalResponseStep(ctx);
        return { status: "allowed" as const };
      } catch {
        return {
          status: "rejected" as const,
          reason:
            "Only the current owner can approve this exact retained Auth-only final routing operation.",
        };
      }
    },
  },
  availableInSubagents: false,
  description:
    "Approve and complete the retained final Gateway routing operation for this isolated Auth-only Preview. Reconciles the exact saved source, app projection, refreshed Gateway and stable alias on retry. The prepared result establishes routing readiness; hosted signup, sign-in and email delivery remain separate acceptance results.",
  async execute(input, ctx) {
    "use workflow";
    return await prepareAuthOnlyFinalRoutingStep(input, ctx);
  },
  inputSchema: nativeTargetAuthOnlyFinalRoutingApprovalInputSchema,
});
