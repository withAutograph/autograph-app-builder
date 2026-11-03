import { readContinuityApprovalWithRecovery } from "./continuity-approval-recovery";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { WorkflowStepToolContext } from "eve/tools";

import type { ContinuityApprovalToolInput } from "../eve/private-continuity-approval";

type ContinuityContext = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;

/** Resolve through the existing owner-authenticated client on every step. */
const readSavedContinuityApproval = async (
  input: ContinuityApprovalToolInput,
  ctx: ContinuityContext,
) => {
  const [
    { continuityApprovalIntentId, verifySavedContinuityIntent },
    { hostedOperatorClientForSession },
  ] = await Promise.all([
    import("../eve/private-continuity-approval"),
    import("../provisioning/hosted-operator-client"),
  ]);
  ctx.abortSignal.throwIfAborted();
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  // readContinuity verifies the canonical owner and request/plan digest before returning.
  const saved = await operator.readContinuity(continuityApprovalIntentId(input), ctx.abortSignal);
  const request = verifySavedContinuityIntent(input, saved);
  if (saved.plan.target.sessionId !== operator.sessionId) {
    throw new Error("Continuity session differs.");
  }
  if (saved.status.supersededBy !== undefined) {
    throw new Error("Continuity intent was superseded; use its saved successor.");
  }
  return { operator, saved, request };
};

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function runHostedContinuityStep(
  input: ContinuityApprovalToolInput,
  ctx: ContinuityContext,
) {
  "use step";
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
  const { operator, saved, request } = await readSavedContinuityApproval(input, ctx);
  // Planned intents still ask for fresh native consent. Execution independently verifies its settlement.
  return saved.status.state === "planned"
    ? { approved: false }
    : await operator.continuityApproval(request, ctx.abortSignal);
}
