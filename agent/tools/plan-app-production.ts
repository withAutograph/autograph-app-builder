import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan the app's normal Production data and access setup in its selected existing repository. The protected service resolves the saved workspace, repository, organization, app schema and managed resources. Requires no database details or prepared synthetic runtime. Returns the exact plan for prepare-app-production approval; planning has no provider effects. Optional creatorEmail selects the creator’s app sign-in account; it must complete its own secure authentication.",
  inputSchema: z.strictObject({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    creatorEmail: z
      .email()
      .transform((email) => email.toLowerCase())
      .optional(),
  }),
  async execute(input, ctx) {
    const { repositoryProductionClientForContext } =
      await import("../../lib/agent/repository-production-client");
    const client = await repositoryProductionClientForContext(ctx);
    return await client.plan(input.appId, input.creatorEmail);
  },
});
