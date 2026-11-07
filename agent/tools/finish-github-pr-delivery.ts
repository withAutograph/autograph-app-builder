import { defineWorkflowTool } from "eve/tools";
import { sleep } from "workflow";

import { githubPrDeliveryApprovalSchema } from "../../lib/agent/github-pr-delivery-approval";
import {
  approveGitHubPrDelivery,
  continueGitHubPrDelivery,
} from "../../lib/agent/github-pr-delivery-step";

export default defineWorkflowTool({
  approval: approveGitHubPrDelivery,
  availableInSubagents: false,
  description:
    "After explicit approval, mark the reviewed pull request ready and merge that exact revision once its required checks pass. Pass the approval input returned by read_github_pr_delivery. Changes to the reviewed revision or ready cycle stop this operation. Hosted verification has its own result.",
  async execute(input, ctx) {
    "use workflow";
    let result = await continueGitHubPrDelivery(input, ctx);
    while (result.status === "waiting-for-checks") {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while GitHub runs the required checks.
      await sleep("15s");
      // oxlint-disable-next-line eslint/no-await-in-loop -- Resume the same approved intent and ready cycle.
      result = await continueGitHubPrDelivery(input, ctx, result.readyAt);
    }
    return result;
  },
  inputSchema: githubPrDeliveryApprovalSchema,
});
