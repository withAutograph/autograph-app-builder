import { defineTool } from "eve/tools";
import { centralHostReadInputSchema } from "../../lib/provisioning/central-integration-host-transport";
export default defineTool({
  availableInSubagents: false,
  description:
    "Read and independently reconcile this exact saved central Integrations intent. Preserves pending or uncertain effects and waits for signed native deployment identity and real readiness. Does not retry mutations or activate providers.",
  inputSchema: centralHostReadInputSchema,
  async execute(input, ctx) {
    const { centralHostClientForContext } =
      await import("../../lib/agent/central-integration-host-client");
    const client = await centralHostClientForContext(ctx);
    return await client.read(input);
  },
});
