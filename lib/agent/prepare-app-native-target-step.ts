import type { WorkflowStepToolContext } from "eve/tools";
import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";
import type { NativeTargetPreparationRequest } from "./native-target-onboarding-runtime";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readNativeTargetApprovalStep(
  input: NativeTargetPreparationRequest,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetPreparationRequest>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Plain native response policy keeps SDK auth functions inside its authenticated invocation.
export async function authorizeNativeTargetApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetPreparationRequest>,
) {
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareNativeTargetStep(
  input: NativeTargetPreparationRequest,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepare(input, ctx);
}
