import { defineWorkflowTool } from "eve/tools";
import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "../../lib/provisioning/native-target-auth-only-entry-plan-store";
import {
  authorizeAuthOnlyEntryApprovalResponseStep,
  prepareAuthOnlyEntryStep,
  readAuthOnlyEntryApprovalStep,
} from "../../lib/agent/prepare-app-native-target-auth-only-step";

export default defineWorkflowTool({
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) {
        return "user-approval" as const;
      }
      try {
        return (await readAuthOnlyEntryApprovalStep(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied" as const,
          reason:
            "The current owner and exact retained Auth-only entry effect could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        await authorizeAuthOnlyEntryApprovalResponseStep(ctx);
        return { status: "allowed" as const };
      } catch {
        return {
          status: "rejected" as const,
          reason: "Only the current owner can approve this exact retained Auth-only entry effect.",
        };
      }
    },
  },
  availableInSubagents: false,
  description:
    "Approve and prepare exactly one retained organization or signup-policy effect for this Auth-only Preview delivery. Reuses its settled approval and saved child operation on retry. Private owner proof and controlled email details stay in retained state. Creates no account, app database or product-data grants; this result does not establish hosted signup acceptance.",
  async execute(input, ctx) {
    "use workflow";
    return await prepareAuthOnlyEntryStep(input, ctx);
  },
  inputSchema: nativeTargetAuthOnlyEntryApprovalInputSchema,
});
