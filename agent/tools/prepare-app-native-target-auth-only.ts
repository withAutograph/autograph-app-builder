import { defineWorkflowTool } from "eve/tools";
import { nativeTargetAuthOnlyPreparationRequestSchema } from "../../lib/agent/native-target-onboarding-input-schema";
import {
  authorizeAuthOnlyApprovalResponseStep,
  prepareAuthOnlyStep,
  readAuthOnlyApprovalStep,
} from "../../lib/agent/prepare-app-native-target-auth-only-step";

export default defineWorkflowTool({
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) {
        return "user-approval" as const;
      }
      try {
        return (await readAuthOnlyApprovalStep(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied" as const,
          reason: "The current owner and exact Auth-only target operation could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        await authorizeAuthOnlyApprovalResponseStep(ctx);
        return { status: "allowed" };
      } catch {
        return {
          status: "rejected",
          reason: "Only the current owner can approve this exact Auth-only target.",
        };
      }
    },
  },
  availableInSubagents: false,
  description:
    "After explicit human approval, create only the Vercel Preview project in the exact retained Auth-only plan. The protected service verifies the settled approval, owner, Auth profile and installation before one project create, then performs GET-only readback. It does not deploy Auth, create an app database, run an installer, or grant application data access. Resume the same operation after uncertainty.",
  async execute(input, ctx) {
    "use workflow";
    return await prepareAuthOnlyStep(input, ctx);
  },
  inputSchema: nativeTargetAuthOnlyPreparationRequestSchema,
});
