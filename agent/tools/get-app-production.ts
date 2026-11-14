import { defineTool } from "eve/tools";
import { z } from "zod";
import { currentDirectProductionGrant } from "../../lib/agent/direct-production-state";
import { nextProductionDeliveryCall } from "../../lib/agent/prepare-app-production-step";

export default defineTool({
  availableInSubagents: false,
  description:
    "Read the saved app's Production setup progress. Retains its original database, destination and account-link state across interrupted setup and revisions. Use after an uncertain response, or while waiting for the one-time app sign-in. For an approved optional-field revision blocked at setup, includeSchemaPredecessor checks the installed schema behind the exact current owned draft and returns checked identities. This read-only diagnostic does not run ordinary setup or continuation.",
  inputSchema: z.strictObject({
    appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
    includeSchemaPredecessor: z.literal(true).optional(),
  }),
  async execute(input, ctx) {
    if (input.includeSchemaPredecessor === true) {
      const { readInstalledSchemaPredecessor } =
        await import("../../lib/agent/installed-schema-predecessor-readback");
      return await readInstalledSchemaPredecessor(input.appId, ctx);
    }
    const { repositoryProductionClientForContext } =
      await import("../../lib/agent/repository-production-client");
    const client = await repositoryProductionClientForContext(ctx);
    const status = await client.status(input.appId);
    return status.state === "ready" && currentDirectProductionGrant(ctx, input) !== undefined
      ? { ...status, nextCall: nextProductionDeliveryCall }
      : status;
  },
});
