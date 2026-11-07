import { defineTool } from "eve/tools";
import { publicReleaseApprovalInputSchema } from "../../lib/provisioning/public-release-contract";
import {
  PublicReleasePrerequisiteError,
  publicReleasePrerequisiteResponse,
} from "../../lib/provisioning/public-release-prerequisite";

export default defineTool({
  availableInSubagents: false,
  description:
    "Check the native deployment for the same public release plan after publication. Pass the exact plan, operation reference, and plan digest already returned by planning. A pending result means the selected deployment is still unverified. A ready result identifies the active public origin. This reads provider status without repeating publication or requesting another approval.",
  async execute(input, ctx) {
    const { publicReleaseClientForContext } = await import("../../lib/agent/public-release-client");
    const client = await publicReleaseClientForContext(ctx);
    try {
      return await client.observe(input);
    } catch (error) {
      if (error instanceof PublicReleasePrerequisiteError) {
        return publicReleasePrerequisiteResponse(error);
      }
      throw error;
    }
  },
  inputSchema: publicReleaseApprovalInputSchema,
});
