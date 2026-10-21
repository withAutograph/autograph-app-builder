import { defineWorkflowTool } from "eve/tools";
import { nativeTargetPreparationRequestSchema } from "../../lib/agent/native-target-onboarding-runtime";
import {
  authorizeNativeTargetApprovalResponseStep,
  prepareNativeTargetStep,
  readNativeTargetApprovalStep,
} from "../../lib/agent/prepare-app-native-target-step";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "After human approval, prepare the exact native Preview target plan returned by plan-app-native-target. The protected workflow persists the same immutable operation, actual settled human approval and attempt before one project create, then independently reads the accepted project ID. Resume this same operation after technical failure; an uncertain create never repeats automatically. This creates only the approved dedicated project and native registration, preserving ordinary source changes as planning inputs. It does not deploy or activate Production.",
  inputSchema: nativeTargetPreparationRequestSchema,
  approval: {
    request: async (ctx) => {
      if (ctx.toolInput === undefined) {
        return "user-approval";
      }
      try {
        return (await readNativeTargetApprovalStep(ctx.toolInput, ctx))
          ? "not-applicable"
          : "user-approval";
      } catch {
        return {
          type: "denied",
          reason: "The current owner and exact native target operation could not be verified.",
        };
      }
    },
    response: async (ctx) => {
      try {
        await authorizeNativeTargetApprovalResponseStep(ctx);
        return { status: "allowed" };
      } catch {
        return {
          status: "rejected",
          reason: "The responder cannot approve this exact native target operation.",
        };
      }
    },
  },
  async execute(input, ctx) {
    "use workflow";
    return await prepareNativeTargetStep(input, ctx);
  },
});
