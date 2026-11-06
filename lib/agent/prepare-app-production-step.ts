import type { WorkflowStepToolContext } from "eve/tools";
import type { RepositoryProductionApprovalInput } from "../provisioning/repository-production-approval";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function prepareAppProductionStep(
  input: RepositoryProductionApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { repositoryProductionClientForContext } = await import("./repository-production-client");
  const client = await repositoryProductionClientForContext(ctx);
  return await client.prepare(input);
}
