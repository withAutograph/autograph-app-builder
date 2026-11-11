import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { sleep } from "workflow";
import { observeAppProductionStep } from "../../lib/agent/observe-app-production-step";
import { builderAppIdSchema } from "../../lib/provisioning/names";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Read the saved app's current native Production availability and continue watching pending provider activation. This independent read works without an old Build, Ready call, executable artifact or setup journal. Builder resolves the same owned app and configured destination. An available app entry can be opened immediately; requestedRevision remains unassessed and this does not verify the latest code, sign-in or business behavior. Service issues are Builder-managed; retain any known safe app link and retry this same saved app when service access is restored. This never provisions, approves, merges, deploys, activates or tests anything.",
  inputSchema: z.strictObject({ appId: builderAppIdSchema }),
  async execute(input, ctx) {
    "use workflow";
    let observed = await observeAppProductionStep(input.appId, ctx);
    while (observed.status === "pending") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while the provider owns activation.
      await sleep("15s");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Recheck the same saved ownership before each read; no effect is retried.
      observed = await observeAppProductionStep(input.appId, ctx);
    }
    return observed;
  },
});
