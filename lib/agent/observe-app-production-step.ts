import type { WorkflowStepToolContext } from "eve/tools";
import type { AppProductionDeliveryTarget } from "./app-production-observation";

// eslint-disable-next-line eslint/func-style -- Workflow requires a hoisted top-level step.
export async function observeAppProductionStep(appId: string, ctx: WorkflowStepToolContext) {
  "use step";
  const { observeAppProduction } = await import("./app-production-observation");
  return await observeAppProduction(appId, ctx);
}

// eslint-disable-next-line eslint/func-style -- Workflow requires a hoisted top-level step.
export async function observeMergedAppProductionStep(
  target: AppProductionDeliveryTarget,
  ctx: WorkflowStepToolContext,
  expectedMergeSha?: string,
) {
  "use step";
  const { observeMergedAppProduction } = await import("./app-production-observation");
  return await observeMergedAppProduction(target, ctx, expectedMergeSha);
}
