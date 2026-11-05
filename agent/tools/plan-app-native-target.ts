import { defineTool } from "eve/tools";
import { nativeTargetPlanRequestSchema } from "../../lib/agent/native-target-onboarding-input-schema";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan the selected app's dedicated native Preview target before a Vercel project exists. Propose the exact project name, authorized team/installation, source build settings and branch. The protected service reads the accepted app, captured release description and actual product roles, current owner/provider grant, explicitly approved native Neon scope and worker, cost and retention. An explicit resourceProfileId selects only an existing deployment-approved profile for this exact owner/app, never caller-supplied credentials or Neon scope. A changed resource selection may revise a never-dispatched planned operation while preserving its prior intent; a revised digest needs fresh exact-plan approval. This call does not create provider resources. Keep the returned immutable plan and operation for prepare-app-native-target; ordinary source edits do not allocate another target.",
  inputSchema: nativeTargetPlanRequestSchema,
  async execute(input, ctx) {
    const [{ nativeTargetOnboardingRuntimeForSession }, { appBuilderWorkflowState }] =
      await Promise.all([
        import("../../lib/agent/native-target-onboarding-runtime"),
        import("../../lib/agent/workflow-state"),
      ]);
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.plan(input, ctx, appBuilderWorkflowState.get());
  },
});
