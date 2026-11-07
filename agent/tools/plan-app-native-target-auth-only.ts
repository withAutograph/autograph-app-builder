import { defineTool } from "eve/tools";
import { nativeTargetAuthOnlyPlanRequestSchema } from "../../lib/agent/native-target-onboarding-input-schema";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan a dedicated Preview target for a static app that needs isolated Auth only. This reads the selected app's saved static description, published source, immutable Auth schema artifact selection and the deployment-owned owner/app Auth profile and role catalog. The retained approval digest binds the exact schema artifact and pinned installer, source description, project settings, verified-email signup policy, role and isolated Auth authority. This planning call creates no provider resources and grants no product-data access.",
  inputSchema: nativeTargetAuthOnlyPlanRequestSchema,
  async execute(input, ctx) {
    const [
      { nativeTargetOnboardingRuntimeForSession },
      { appBuilderWorkflowState },
      { publishCompiledOperatorArtifactsForSession },
      { hostedOperatorCallbackExecution },
    ] = await Promise.all([
      import("../../lib/agent/native-target-onboarding-runtime"),
      import("../../lib/agent/workflow-state"),
      import("../../lib/agent/compiled-operator-artifacts"),
      import("../../lib/provisioning/hosted-operator-callback-owner"),
    ]);
    const state = appBuilderWorkflowState.get();
    if (
      !("applyReceipt" in state) ||
      state.phase !== "validated" ||
      state.appSpec.appId !== input.appId
    ) {
      throw new Error(
        "Auth-only target planning requires the same validated selected app session.",
      );
    }
    const sandbox = await ctx.getSandbox();
    await publishCompiledOperatorArtifactsForSession({
      adapterSessionId: ctx.session.id,
      appId: input.appId,
      appSpecDigest: state.appSpec.digest,
      callId: ctx.callId,
      callbackExecution: hostedOperatorCallbackExecution(ctx.session),
      expectedBackend: "static",
      root: state.applyReceipt.applyRoot,
      sandbox,
      sessionAuth: ctx.session.auth,
      signal: ctx.abortSignal,
    });
    const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
    return await runtime.planAuthOnly(input, ctx, state);
  },
});
