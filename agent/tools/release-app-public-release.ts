import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { publicReleaseApprovalInputSchema } from "../../lib/provisioning/public-release-contract";
import { releasePublicAppStep } from "../../lib/agent/release-app-public-release-step";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Approve and release the exact plan from plan-app-public-release. This binds only the named restricted synthetic app/Auth runtime configuration to the app's own Production environment and publishes the reviewed source through normal Git delivery. The app domain is public, with BetterAuth enforcing application access. Both effects require current-owner consent from this call's committed approval. It never creates a second project, activates customer Production provider connections, calls deployment POST, promotes or writes aliases. Unknown effects retain their checkpoints for reconciliation; never replace the operation or replay an uncertain public response.",
  inputSchema: publicReleaseApprovalInputSchema,
  approval: always(),
  async execute(input, ctx) {
    "use workflow";
    return await releasePublicAppStep(input, ctx);
  },
});
