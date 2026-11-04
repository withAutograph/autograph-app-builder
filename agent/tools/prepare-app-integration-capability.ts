import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { appIntegrationCapabilityApprovalInputSchema } from "../../lib/provisioning/app-integration-capability-contract";
import { prepareAppIntegrationCapabilityStep } from "../../lib/agent/prepare-app-integration-capability-step";
export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Approve the exact separately planned optional integration capability: prepare the isolated per-app control SQL principal, install the fixed control schema, bind declared kernel service memberships, prepare the exact app-owned provider webhook destination under v2 consent (create once or disclosed verified reuse, never retarget), and atomically register sealed central app authority. Preserves uncertain outcomes and existing app/tenant/provider resources. This does not activate a provider connection or deploy the app; publish the optional configuration through a new reviewed public release afterward.",
  inputSchema: appIntegrationCapabilityApprovalInputSchema,
  approval: always(),
  async execute(input, ctx) {
    "use workflow";
    return await prepareAppIntegrationCapabilityStep(input, ctx);
  },
});
