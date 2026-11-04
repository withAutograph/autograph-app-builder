import { defineTool } from "eve/tools";
import { z } from "zod";
import { appIntegrationCapabilityPlanSchema } from "../../lib/provisioning/app-integration-capability-contract";
export default defineTool({
  availableInSubagents: false,
  description:
    "Plan this saved app's optional QuickBooks development integration capability through its normal Builder destination. Resolves the actual checked provider read configuration, isolated control resource, separate central-host/caller readiness and exact service memberships. No provider activation. Prepare the returned complete plan with prepare-app-integration-capability under separate ordinary effect approval.",
  inputSchema: z.strictObject({
    appId: appIntegrationCapabilityPlanSchema.shape.selection.shape.appId,
  }),
  async execute(input, ctx) {
    const { appIntegrationCapabilityClientForContext } =
      await import("../../lib/agent/app-integration-capability-client");
    const client = await appIntegrationCapabilityClientForContext(ctx);
    return await client.plan(input.appId);
  },
});
