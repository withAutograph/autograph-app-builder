import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { centralHostApprovalInputSchema } from "../../lib/provisioning/central-integration-host-transport";
import { prepareCentralHostStep } from "../../lib/agent/prepare-central-integration-host-step";
export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Approve this exact isolated central Integrations setup or caller grant. Setup creates the reviewed development control resource, fixed schema, deployment-event subscription, inspector grant and branch-scoped runtime, then publishes the reviewed native Git branch. Caller intent grants only this app's Production workload access to the existing central Preview host. Preserves uncertain effects; does not activate a provider or change customer Production.",
  inputSchema: centralHostApprovalInputSchema,
  approval: always(),
  async execute(input, ctx) {
    "use workflow";
    return await prepareCentralHostStep(input, ctx);
  },
});
