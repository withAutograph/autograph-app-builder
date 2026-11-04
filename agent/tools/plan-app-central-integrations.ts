import { defineTool } from "eve/tools";
import { centralHostPlanRequestSchema } from "../../lib/provisioning/central-integration-host-service";
export default defineTool({
  availableInSubagents: false,
  description:
    "Plan the separately approved isolated central Integrations host setup or this saved app's exact caller grant. Reads trusted Builder configuration and normal destination receipts. Returns the complete frozen effect scope or a read-only READY receipt for one unchanged canonical caller grant (no new approval or journal); no provider activation or deployment effect is performed by planning.",
  inputSchema: centralHostPlanRequestSchema,
  async execute(input, ctx) {
    const { centralHostClientForContext } =
      await import("../../lib/agent/central-integration-host-client");
    const client = await centralHostClientForContext(ctx);
    return await client.plan(input);
  },
});
