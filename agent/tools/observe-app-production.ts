import { defineWorkflowTool } from "eve/tools";
import { z } from "zod";
import { observeAppProductionStep } from "../../lib/agent/observe-app-production-step";
import { builderAppIdSchema } from "../../lib/provisioning/names";

export default defineWorkflowTool({
  availableInSubagents: false,
  description:
    "Check the saved app's current native Production availability once and return even when it is pending. This independent read works without an old Build, Ready call, executable artifact or setup journal. Continue the reviewed PR delivery when availability is pending before merge. Builder resolves the same owned app and configured destination. An available app entry can be opened immediately; requestedRevision remains unassessed and this does not verify the latest code, sign-in or business behavior. Service issues are Builder-managed; retain any known safe app link and retry this same saved app when service access is restored. This never provisions, approves, merges, deploys, activates or tests anything.",
  inputSchema: z.strictObject({ appId: builderAppIdSchema }),
  async execute(input, ctx) {
    "use workflow";
    return await observeAppProductionStep(input.appId, ctx);
  },
});
