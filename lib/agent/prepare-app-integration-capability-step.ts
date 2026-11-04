import type { WorkflowStepToolContext } from "eve/tools";
import type { AppIntegrationCapabilityApprovalInput } from "../provisioning/app-integration-capability-contract";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAppIntegrationCapabilityStep(
  input: AppIntegrationCapabilityApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { appIntegrationCapabilityClientForContext } =
    await import("./app-integration-capability-client");
  const client = await appIntegrationCapabilityClientForContext(ctx);
  return await client.prepare(input);
}
