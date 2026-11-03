import type { WorkflowStepToolContext } from "eve/tools";

import type { ContinuityApprovalToolInput } from "../eve/private-continuity-approval";

type ContinuityContext = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function runHostedContinuityStep(
  input: ContinuityApprovalToolInput,
  ctx: ContinuityContext,
) {
  "use step";
  const { readSavedContinuityApproval } = await import("./continuity-approval-resolution");
  const { operator, request } = await readSavedContinuityApproval(input, ctx);
  return await operator.runContinuity(request, ctx.callId, ctx.abortSignal);
}

// eslint-disable-next-line eslint/func-style -- Workflow approval runs in the Node step runtime.
export async function readHostedContinuityApprovalStep(
  input: ContinuityApprovalToolInput,
  ctx: ContinuityContext,
  delayMs = 1000,
) {
  "use step";
  const [{ readSavedContinuityApproval }, { readContinuityApprovalWithRecovery }] =
    await Promise.all([
      import("./continuity-approval-resolution"),
      import("./continuity-approval-recovery"),
    ]);
  const result = await readContinuityApprovalWithRecovery(async () => {
    const { operator, request } = await readSavedContinuityApproval(input, ctx);
    return await operator.continuityApproval(request, ctx.abortSignal);
  }, ctx.abortSignal);
  return { ...result, checkAfter: new Date(Date.now() + delayMs).toISOString() };
}

/** Verify ownership and exact intent before requesting consent, without scanning historical approvals. */
// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a top-level step declaration.
export async function readHostedContinuityApprovalPreflightStep(
  input: ContinuityApprovalToolInput,
  ctx: ContinuityContext,
) {
  "use step";
  const { readSavedContinuityApproval } = await import("./continuity-approval-resolution");
  const { operator, saved, request } = await readSavedContinuityApproval(input, ctx);
  // Planned intents still ask for fresh native consent. Execution independently verifies its settlement.
  return saved.status.state === "planned"
    ? { approved: false }
    : await operator.continuityApproval(request, ctx.abortSignal);
}
