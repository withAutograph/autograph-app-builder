import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { WorkflowStepToolContext } from "eve/tools";
import type { ContinuityApprovalToolInput } from "../eve/private-continuity-approval";

type ContinuityContext = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;

/** Resolve through the existing owner-authenticated client on every step. */
export const readSavedContinuityApproval = async (
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
  return { operator, request, saved };
};
