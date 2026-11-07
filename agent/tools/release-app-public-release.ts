import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { publicReleaseApprovalInputSchema } from "../../lib/provisioning/public-release-contract";
import { releasePublicAppStep } from "../../lib/agent/release-app-public-release-step";

export default defineWorkflowTool({
  approval: always(),
  availableInSubagents: false,
  description:
    "Approve and release the exact plan from plan-app-public-release. This binds the named restricted synthetic app/Auth runtime configuration to the app's own Production environment and publishes the reviewed source through normal Git delivery. Both effects require current-owner consent from this call's committed approval. If deployment observation is pending, use observe-app-public-release with the same plan to read back the active deployment. Unknown effects retain their checkpoints for reconciliation.",
  async execute(input, ctx) {
    "use workflow";
    return await releasePublicAppStep(input, ctx);
  },
  inputSchema: publicReleaseApprovalInputSchema,
});
