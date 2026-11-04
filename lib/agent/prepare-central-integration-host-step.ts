import type { WorkflowStepToolContext } from "eve/tools";
import type { CentralHostApprovalInput } from "../provisioning/central-integration-host-transport";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareCentralHostStep(
  input: CentralHostApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { centralHostClientForContext } = await import("./central-integration-host-client");
  const client = await centralHostClientForContext(ctx);
  return await client.prepare(input);
}
