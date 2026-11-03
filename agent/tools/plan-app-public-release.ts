import { defineTool } from "eve/tools";
import { publicReleasePlanSchema } from "../../lib/provisioning/public-release-contract";
import { z } from "zod";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan public delivery in the app's existing normal Builder Services project. The protected service resolves the reviewed app source, owned provisioning receipt, public domain and independently verified isolated development resources. The returned approval names Production runtime bindings and normal Git source publication. It never provisions a customer provider, deploys, aliases or modifies existing frozen Preview plans. Use release-app-public-release for separate exact-plan approval; a public URL still requires BetterAuth for app data and actions.",
  inputSchema: z.strictObject({ appId: publicReleasePlanSchema.shape.selection.shape.appId }),
  async execute(input, ctx) {
    const { publicReleaseClientForContext } = await import("../../lib/agent/public-release-client");
    const client = await publicReleaseClientForContext(ctx);
    return await client.plan(input.appId);
  },
});
