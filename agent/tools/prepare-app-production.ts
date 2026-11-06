import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { repositoryProductionApprovalInputSchema } from "../../lib/provisioning/repository-production-approval";
import { prepareAppProductionStep } from "../../lib/agent/prepare-app-production-step";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Set up the approved app's Production data and creator access using the exact plan returned by plan-app-production. Builder owns provisioning, reconciliation and account linking. Show the returned one-time sign-in link if needed; the protected callback resumes the same setup automatically. Existing linked creators skip sign-in. Never ask the creator for database details or perform manual enrollment. This does not merge code or activate a deployment.",
  inputSchema: repositoryProductionApprovalInputSchema,
  approval: always(),
  async execute(input, ctx) {
    "use workflow";
    return await prepareAppProductionStep(input, ctx);
  },
});
