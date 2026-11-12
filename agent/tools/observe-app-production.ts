import { defineTool } from "eve/tools";
import { z } from "zod";
import { observeSavedAppProduction } from "../../lib/agent/app-production-observation";
import { builderAppIdSchema } from "../../lib/provisioning/names";

export default defineTool({
  availableInSubagents: false,
  description:
    "Check the saved app's current native Production availability once and return even when it is pending. Builder reads the same owned app and can confirm a reviewed revision when the saved publication and GitHub prove its merge. If that history is unavailable, check current app availability. An available app entry can be opened immediately. This observation does not verify authenticated app behavior or change delivery state.",
  inputSchema: z.strictObject({ appId: builderAppIdSchema }),
  async execute(input, ctx) {
    return await observeSavedAppProduction(input.appId, ctx);
  },
});
