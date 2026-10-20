import { sleep } from "workflow";
import { defineWorkflowTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { ContinuityApprovalInput } from "../../lib/eve/private-continuity-approval";
import { continuityApprovalInputSchema } from "../../lib/eve/private-continuity-approval";
import {
  runHostedContinuityStep,
  readHostedContinuityApprovalStep,
} from "../../lib/agent/run-app-continuity-tests-step";

// eslint-disable-next-line eslint/func-style -- Workflow approval is a top-level Node step.
async function continuityApproval(
  ctx: ApprovalContext<ContinuityApprovalInput>,
): Promise<ApprovalStatus> {
  "use step";
  if (ctx.toolInput === undefined) {
    return "user-approval";
  }
  try {
    const retained = await readHostedContinuityApprovalStep(ctx.toolInput, ctx);
    return retained.approved ? "not-applicable" : "user-approval";
  } catch {
    return {
      type: "denied",
      reason:
        "The current owner and exact saved continuity intent could not be verified. Resume the same intent when access is restored.",
    };
  }
}

export default defineWorkflowTool({
  description:
    "Run one explicitly requested app-authored continuity suite after approval of the exact plan from plan-app-hosted-runtime operation continuity. The operator starts the same owned app environment, publishes a separate capability-protected Gateway target, lets that app suite control process replacement through private IPC, then closes its runtime and removes only its own target rows. It never grants roles or changes app data outside the approved app suite. Preserve the same intent after uncertain outcomes; status never starts work. A suite result does not prove a subsequent native app deployment.",
  inputSchema: continuityApprovalInputSchema,
  approval: continuityApproval,
  async execute(input, ctx) {
    "use workflow";
    let delayMs = 1000;
    let approval = await readHostedContinuityApprovalStep(input, ctx, delayMs);
    while (!approval.approved) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while the human settlement commits.
      await sleep(new Date(approval.checkAfter));
      delayMs = Math.min(delayMs * 2, 30_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Re-read the same exact receipt after durable backoff.
      approval = await readHostedContinuityApprovalStep(input, ctx, delayMs);
    }
    return await runHostedContinuityStep(input, ctx);
  },
});
