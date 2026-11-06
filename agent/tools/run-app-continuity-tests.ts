import { sleep } from "workflow";
import { isContinuityApprovalReadRetryable } from "../../lib/agent/continuity-approval-recovery";
import { defineWorkflowTool } from "eve/tools";
import type { ApprovalContext, ApprovalStatus } from "eve/tools/approval";
import type { ContinuityApprovalToolInput } from "../../lib/eve/private-continuity-approval";
import { continuityApprovalToolInputSchema } from "../../lib/eve/private-continuity-approval";
import {
  runHostedContinuityStep,
  readHostedContinuityApprovalStep,
  readHostedContinuityApprovalPreflightStep,
} from "../../lib/agent/run-app-continuity-tests-step";

// eslint-disable-next-line eslint/func-style -- Workflow approval is a top-level Node step.
async function continuityApproval(
  ctx: ApprovalContext<ContinuityApprovalToolInput>,
): Promise<ApprovalStatus> {
  "use step";
  if (ctx.toolInput === undefined) {
    return "user-approval";
  }
  try {
    const retained = await readHostedContinuityApprovalPreflightStep(ctx.toolInput, ctx);
    return retained.approved ? "not-applicable" : "user-approval";
  } catch (error) {
    if (isContinuityApprovalReadRetryable(error)) {
      throw error;
    }
    return {
      reason:
        "The current owner and exact saved continuity intent could not be verified. Resume the same intent when access is restored.",
      type: "denied",
    };
  }
}

export default defineWorkflowTool({
  approval: continuityApproval,
  description:
    "Run one explicitly requested app-authored continuity suite after approval of the exact saved plan. Prefer the exact compact request returned by get-app-hosted-runtime operation continuity: action, planRef, planDigest and idempotencyKey. Builder reloads and verifies the owner-scoped canonical plan before approval and execution, so do not copy or reconstruct its nested resource payload. Legacy full request plus plan remains supported. Review the canonical read before this normal approval. The operator starts the same owned app environment, publishes a separate capability-protected Gateway target, lets that app suite control process replacement through private IPC, then closes its runtime and removes only its own target rows. It never grants roles or changes app data outside the approved app suite. Preserve the same intent after uncertain outcomes; status never starts work. A suite result does not prove a subsequent native app deployment.",
  async execute(input, ctx) {
    "use workflow";
    let delayMs = 1000;
    let approval = await readHostedContinuityApprovalStep(input, ctx, delayMs);
    while (!approval.approved) {
      // A complete negative observation is legitimate while native human consent is pending.
      // oxlint-disable-next-line eslint/no-await-in-loop -- Durable sleep releases compute while consent or retained history advances.
      await sleep(new Date(approval.checkAfter));
      delayMs = Math.min(delayMs * 2, 30_000);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Reconcile the exact same native request without issuing duplicate consent.
      approval = await readHostedContinuityApprovalStep(input, ctx, delayMs);
    }
    return await runHostedContinuityStep(input, ctx);
  },
  inputSchema: continuityApprovalToolInputSchema,
});
