import { defineTool } from "eve/tools";
import { z } from "zod";

export default defineTool({
  availableInSubagents: false,
  description:
    "Plan the app's normal Production data and access setup in its selected existing repository. The protected service resolves the saved workspace, repository, organization, app schema and managed resources. Requires no database details or prepared synthetic runtime. Returns a server-derived approvalReference and nextCall for prepare-app-production; pass its input unchanged instead of copying database release or resource details. Planning has no provider effects. Optional creatorEmail selects the creator’s app sign-in account; it must complete its own secure authentication. Show the returned accessSummary before approval so the owner sees private access or the exact self-signup eligibility and app roles.",
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
    let result;
    try {
      result = await client.plan(input.appId, input.creatorEmail);
    } catch (error) {
      ctx.abortSignal.throwIfAborted();
      const { restoreReviewedStaticProduction } =
        await import("../../lib/agent/restore-reviewed-static-production");
      if (!(await restoreReviewedStaticProduction(input.appId, ctx))) {
        throw error;
      }
      result = await client.plan(input.appId, input.creatorEmail);
    }
    return {
      version: result.version,
      approvalReference: result.approvalReference,
      accessSummary: result.accessSummary,
      nextCall: result.nextCall,
    };
  },
});
