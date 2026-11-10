import { defineDynamic, defineTool } from "eve/tools";
import { z } from "zod";
import { authSchemaRolloutAvailable } from "../../lib/agent/auth-schema-rollout-availability";

const tool = () =>
  defineTool({
    availableInSubagents: false,
    description:
      "Private platform service administration only: inspect or plan the additive schema/ACL rollout for the deployment-enrolled existing Production Auth resource. The protected service verifies its enrolled administrator and selects the configured resource, workers and source catalog. This is one-time platform maintenance, never a generated-app requirement or a creator database question. Supply profileId to plan; supply the retained operationRef to read status after an interrupted or uncertain apply. To recover a fresh approval for that same saved operation, supply operationRef and review:true; this rereads the original frozen plan and its server-derived approvalReference without replacing or resetting it. Planning/status/review do not apply schema changes. Present the returned concrete SQL effects, existing resource and full saved-plan approvalDigest for separate native approval, then pass only the returned v2 approvalReference to apply-production-auth-schema-rollout; never copy SQL into its input.",
    inputSchema: z.union([
      z.strictObject({ profileId: z.string().min(1) }),
      z.strictObject({ operationRef: z.uuid(), review: z.literal(true).optional() }),
    ]),
    async execute(input, ctx) {
      const { authSchemaRolloutClientForContext } =
        await import("../../lib/agent/auth-schema-rollout-client");
      const client = await authSchemaRolloutClientForContext(ctx);
      if ("operationRef" in input) {
        if (input.review === true) {
          return await client.review(input.operationRef);
        }
        return await client.status(input.operationRef);
      }
      return await client.plan(input.profileId);
    },
  });

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => (authSchemaRolloutAvailable(ctx.session) ? tool() : null),
  },
});
