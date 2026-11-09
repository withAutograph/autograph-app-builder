import { defineDynamic, defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { authSchemaRolloutApprovalSchema } from "../../lib/provisioning/production-auth-schema-rollout-contract";
import { authSchemaRolloutAvailable } from "../../lib/agent/auth-schema-rollout-availability";

const tool = () =>
  defineTool({
    availableInSubagents: false,
    description:
      "Private platform service administration only: apply the exact existing Production Auth schema/ACL plan returned by plan-production-auth-schema-rollout after native approval. The protected service independently checks deployment-enrolled administrator authority, the full saved plan, compatible worker identity and actual owner settlement, then applies and reads back that same rollout. This does not create an Auth database, provision app access, publish code or activate a deployment. Preserve the operationRef after an uncertain result and read its status before retrying. Never require this maintenance tool for ordinary generated apps.",
    inputSchema: authSchemaRolloutApprovalSchema,
    approval: always(),
    async execute(input, ctx) {
      const { authSchemaRolloutClientForContext } =
        await import("../../lib/agent/auth-schema-rollout-client");
      const client = await authSchemaRolloutClientForContext(ctx);
      return await client.apply(input);
    },
  });

export default defineDynamic({
  events: {
    "turn.started": (_event, ctx) => (authSchemaRolloutAvailable(ctx.session) ? tool() : null),
  },
});
