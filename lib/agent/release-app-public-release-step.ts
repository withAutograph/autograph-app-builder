import type { WorkflowStepToolContext } from "eve/tools";
import type { PublicReleaseApprovalInput } from "../provisioning/public-release-contract";

// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a hoisted top-level step.
export async function releasePublicAppStep(
  input: PublicReleaseApprovalInput,
  ctx: WorkflowStepToolContext,
) {
  "use step";
  const { publicReleaseClientForContext } = await import("./public-release-client");
  const client = await publicReleaseClientForContext(ctx);
  return await client.release(input);
}
