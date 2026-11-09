import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { authSchemaRolloutAvailable } from "../../lib/agent/auth-schema-rollout-availability";

const tool = () =>
  defineTool({
    availableInSubagents: false,
    description:
      "Private platform service administration only: inspect or plan the additive schema/ACL rollout for the deployment-enrolled existing Production Auth resource. The protected service verifies its enrolled administrator and selects the configured resource, workers and source catalog. This is one-time platform maintenance, never a generated-app requirement or a creator database question. Supply profileId to plan; supply the retained operationRef to read status after an interrupted or uncertain apply. Planning/status do not apply schema changes. Present the returned concrete SQL effects and existing resource for separate native approval before apply-production-auth-schema-rollout.",
    inputSchema: z.union([
      z.strictObject({ profileId: z.string().min(1) }),
      z.strictObject({ operationRef: z.uuid() }),
    ]),
    async execute(input, ctx) {
      const { authSchemaRolloutClientForContext } =
        await import("../../lib/agent/auth-schema-rollout-client");
      const client = await authSchemaRolloutClientForContext(ctx);
      return "operationRef" in input
        ? await client.status(input.operationRef)
        : await client.plan(input.profileId);
    },
  });

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => (authSchemaRolloutAvailable(ctx.session) ? tool() : null),
  },
});
