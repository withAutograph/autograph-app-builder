import { defineDynamic, defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { authSchemaRolloutApplyInputSchema } from "../../lib/provisioning/production-auth-schema-rollout-contract";
import { authSchemaRolloutAvailable } from "../../lib/agent/auth-schema-rollout-availability";

const tool = () =>
  defineTool({
    availableInSubagents: false,
    description:
      "Private platform service administration only: approve and apply the exact saved Production Auth schema/ACL plan using only the v2 approvalReference returned by plan-production-auth-schema-rollout (or its same-operation review:true). Do not reconstruct the reference or copy SQL. The reference binds the operation, plan digest, full saved-plan approvalDigest and reviewed resource label. Legacy full v1 input remains valid only when every field exactly matches its saved plan. The protected service independently checks deployment-enrolled administrator authority, the full saved plan, compatible worker identity and actual owner settlement, then applies and reads back that same rollout. This does not create an Auth database, provision app access, publish code or activate a deployment. Preserve the operationRef after an uncertain result and read its status before retrying. Never require this maintenance tool for ordinary generated apps.",
    inputSchema: authSchemaRolloutApplyInputSchema,
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
