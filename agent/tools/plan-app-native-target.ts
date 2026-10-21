import { defineTool } from "eve/tools";
import { appBuilderWorkflowState } from "../../lib/agent/workflow-state";
import {
  nativeTargetOnboardingRuntimeForSession,
  nativeTargetPlanRequestSchema,
} from "../../lib/agent/native-target-onboarding-runtime";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan the selected app's dedicated native Preview target before a Vercel project exists. Propose the exact project name, authorized team/installation, source build settings and branch. The protected service reads the accepted app, captured release description and actual product roles, current owner/provider grant, explicitly approved native Neon scope and worker, cost and retention. This call does not create provider resources. Keep the returned immutable plan and operation for prepare-app-native-target; ordinary source edits do not allocate another target.",
  inputSchema: nativeTargetPlanRequestSchema,
  async execute(input, ctx) {
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.plan(input, ctx, appBuilderWorkflowState.get());
  },
});
