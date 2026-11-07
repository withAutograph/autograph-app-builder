import type { ApprovalContext, ApprovalResponseContext } from "eve/tools/approval";
import type { WorkflowStepToolContext } from "eve/tools";
import type { NativeTargetAuthOnlyPreparationRequest } from "./native-target-onboarding-input-schema";
import type { NativeTargetAuthOnlyDeliveryPreparationInput } from "../eve/private-native-target-auth-only-delivery-approval";
import type { NativeTargetAuthOnlyFinalRoutingApprovalInput } from "../eve/private-native-target-auth-only-final-routing-approval";
import type { NativeTargetAuthOnlyResourcePreparationInput } from "../eve/private-native-target-auth-only-resource-approval";
import type { NativeTargetAuthOnlyEntryApprovalInput } from "../provisioning/native-target-auth-only-entry-plan-store";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readAuthOnlyApprovalStep(
  input: NativeTargetAuthOnlyPreparationRequest,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetAuthOnlyPreparationRequest>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasAuthOnlyApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function authorizeAuthOnlyApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetAuthOnlyPreparationRequest>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeAuthOnlyApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAuthOnlyStep(
  input: NativeTargetAuthOnlyPreparationRequest,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepareAuthOnly(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readAuthOnlyDeliveryApprovalStep(
  input: NativeTargetAuthOnlyDeliveryPreparationInput,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetAuthOnlyDeliveryPreparationInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasAuthOnlyDeliveryApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function authorizeAuthOnlyDeliveryApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetAuthOnlyDeliveryPreparationInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeAuthOnlyDeliveryApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAuthOnlyDeliveryStep(
  input: NativeTargetAuthOnlyDeliveryPreparationInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepareAuthOnlyDelivery(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readAuthOnlyEntryApprovalStep(
  input: NativeTargetAuthOnlyEntryApprovalInput,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetAuthOnlyEntryApprovalInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasAuthOnlyEntryApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function authorizeAuthOnlyEntryApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetAuthOnlyEntryApprovalInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeAuthOnlyEntryApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAuthOnlyEntryStep(
  input: NativeTargetAuthOnlyEntryApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepareAuthOnlyEntry(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readAuthOnlyFinalRoutingApprovalStep(
  input: NativeTargetAuthOnlyFinalRoutingApprovalInput,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetAuthOnlyFinalRoutingApprovalInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasAuthOnlyFinalRoutingApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function authorizeAuthOnlyFinalRoutingApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetAuthOnlyFinalRoutingApprovalInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeAuthOnlyFinalRoutingApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAuthOnlyFinalRoutingStep(
  input: NativeTargetAuthOnlyFinalRoutingApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepareAuthOnlyFinalRouting(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function readAuthOnlyResourceApprovalStep(
  input: NativeTargetAuthOnlyResourcePreparationInput,
  ctx: WorkflowStepToolContext | ApprovalContext<NativeTargetAuthOnlyResourcePreparationInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.hasAuthOnlyResourceApproval(input, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function authorizeAuthOnlyResourceApprovalResponseStep(
  ctx: ApprovalResponseContext<NativeTargetAuthOnlyResourcePreparationInput>,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  await runtime.authorizeAuthOnlyResourceApprovalResponse(ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAuthOnlyResourcesStep(
  input: NativeTargetAuthOnlyResourcePreparationInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { nativeTargetOnboardingRuntimeForSession } =
    await import("./native-target-onboarding-runtime");
  const runtime = await nativeTargetOnboardingRuntimeForSession(ctx);
  return await runtime.prepareAuthOnlyResources(input, ctx);
}
