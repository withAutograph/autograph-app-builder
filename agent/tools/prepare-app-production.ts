import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";
import { repositoryProductionPrepareInputSchema } from "../../lib/provisioning/repository-production-approval";
import {
  approvePrepareAppProduction,
  nextProductionDeliveryCall,
  prepareAppProductionStep,
  readProductionIdentitySetupStep,
} from "../../lib/agent/prepare-app-production-step";

const identityObservationMs = 5 * 60_000;
const identityReadIntervalMs = 30_000;

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Set up the approved app's Production data and access using the exact nextCall input returned by plan-app-production. Pass that compact approvalReference unchanged. A matching approval to release a private Arrusted app to Production covers setup; otherwise the ordinary setup approval still applies. Present the returned accessSummary for that approval. Existing linked creators skip sign-in. If sign-in is needed, the protected callback resumes the same setup automatically. Builder owns provisioning and account linking.",
  inputSchema: repositoryProductionPrepareInputSchema,
  approval: approvePrepareAppProduction,
  async *execute(input, ctx) {
    "use workflow";
    const { result, identityWait } = await prepareAppProductionStep(input, ctx);
    if (identityWait === undefined) {
      return result;
    }
    const linkExpires = Date.parse(identityWait.expiresAt);
    const deadline = Math.min(linkExpires, Date.now() + identityObservationMs);
    yield result;
    let { setup } = result;
    while (Date.now() < deadline) {
      const nextRead = new Date(Math.min(Date.now() + identityReadIntervalMs, deadline));
      // oxlint-disable-next-line eslint/no-await-in-loop -- Release compute while the creator follows the protected sign-in link.
      await sleep(nextRead);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Read the same owner-approved operation after each wait.
      setup = await readProductionIdentitySetupStep(identityWait, ctx);
      if (setup.state === "ready") {
        return { setup, nextCall: nextProductionDeliveryCall };
      }
    }
    if (Date.now() < linkExpires) {
      return result;
    }
    return {
      setup: { operationRef: setup.operationRef, state: setup.state },
      guidance:
        "The sign-in link has expired. If your access is still waiting for sign-in, use People to renew the link for this app, then continue the same Production release.",
    };
  },
});
