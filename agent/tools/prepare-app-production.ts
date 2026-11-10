import { defineWorkflowTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { repositoryProductionPrepareInputSchema } from "../../lib/provisioning/repository-production-approval";
import { prepareAppProductionStep } from "../../lib/agent/prepare-app-production-step";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Set up the approved app's Production data and access using the exact nextCall input returned by plan-app-production. Pass that compact approvalReference unchanged; never reconstruct a database release checksum, resource selection, or full plan. Legacy full-plan inputs remain supported. Present the returned accessSummary before approval, including self-signup eligibility and app roles when requested. Builder owns provisioning, reconciliation and account linking. Show the returned one-time sign-in link if needed; the protected callback resumes the same setup automatically. Existing linked creators skip sign-in. Never ask the creator for database details or perform manual enrollment. This does not merge code or activate a deployment.",
  inputSchema: repositoryProductionPrepareInputSchema,
  approval: always(),
  async execute(input, ctx) {
    "use workflow";
    return await prepareAppProductionStep(input, ctx);
  },
});
