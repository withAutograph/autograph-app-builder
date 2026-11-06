import { appIntegrationCapabilityPointerSchema } from "../../lib/provisioning/app-integration-release-contract";
import {
  PublicReleasePrerequisiteError,
  publicReleasePrerequisiteResponse,
} from "@/lib/provisioning/public-release-prerequisite";
import { defineTool } from "eve/tools";
import { publicReleasePlanSchema } from "../../lib/provisioning/public-release-contract";
import { z } from "zod";
import { planPublicAppWithGuidance } from "../../lib/agent/public-release-planning";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan public delivery in the app's existing normal Builder Services project. The protected service resolves the reviewed app source, owned provisioning receipt, public domain and independently verified isolated development resources. The returned approval names Production runtime bindings and normal Git source publication. It never provisions a customer provider, deploys, aliases or modifies existing frozen Preview plans. Use release-app-public-release for separate exact-plan approval; a public URL still requires BetterAuth for app data and actions.",
  async execute(input, ctx) {
    const { publicReleaseClientForContext } = await import("../../lib/agent/public-release-client");
    const client = await publicReleaseClientForContext(ctx);
    try {
      return await planPublicAppWithGuidance(client, input.appId, input.integrationCapability);
    } catch (error) {
      if (error instanceof PublicReleasePrerequisiteError) {
        return publicReleasePrerequisiteResponse(error);
      }
      throw error;
    }
  },
  inputSchema: z.strictObject({
    appId: publicReleasePlanSchema.shape.selection.shape.appId,
    integrationCapability: appIntegrationCapabilityPointerSchema.optional(),
  }),
});
