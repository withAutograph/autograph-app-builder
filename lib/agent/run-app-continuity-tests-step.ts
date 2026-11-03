import { readContinuityApprovalWithRecovery } from "./continuity-approval-recovery";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import type { WorkflowStepToolContext } from "eve/tools";

import type { ContinuityApprovalInput } from "../eve/private-continuity-approval";

type ContinuityContext = Pick<WorkflowStepToolContext, "session" | "callId" | "abortSignal">;

// eslint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function runHostedContinuityStep(
  input: ContinuityApprovalInput,
  ctx: ContinuityContext,
) {
  "use step";
  const [{ continuityApprovalInputSchema }, { hostedOperatorClientForSession }] = await Promise.all(
    [
      import("../eve/private-continuity-approval"),
      import("../provisioning/hosted-operator-client"),
    ],
  );
  const parsed = continuityApprovalInputSchema.parse(input);
  ctx.abortSignal.throwIfAborted();
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  const { plan, ...request } = parsed;
  if (plan.target.sessionId !== operator.sessionId) {
    throw new Error("Continuity session differs.");
  }
  return await operator.runContinuity(request, ctx.callId, ctx.abortSignal);
}

// eslint-disable-next-line eslint/func-style -- Workflow approval runs in the Node step runtime.
export async function readHostedContinuityApprovalStep(
  input: ContinuityApprovalInput,
  ctx: ContinuityContext,
  delayMs = 1000,
) {
  "use step";
  const [{ continuityApprovalInputSchema }, { hostedOperatorClientForSession }] = await Promise.all(
    [
      import("../eve/private-continuity-approval"),
      import("../provisioning/hosted-operator-client"),
    ],
  );
  const { plan, ...request } = continuityApprovalInputSchema.parse(input);
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  if (plan.target.sessionId !== operator.sessionId) {
    throw new Error("Continuity session differs.");
  }
  const result = await readContinuityApprovalWithRecovery(
    () => operator.continuityApproval(request, ctx.abortSignal),
    ctx.abortSignal,
  );
  return { ...result, checkAfter: new Date(Date.now() + delayMs).toISOString() };
}

/** Verify ownership and exact intent before requesting consent, without scanning historical approvals. */
// eslint-disable-next-line eslint/func-style -- Workflow SDK requires a top-level step declaration.
export async function readHostedContinuityApprovalPreflightStep(
  input: ContinuityApprovalInput,
  ctx: ContinuityContext,
) {
  "use step";
  const [
    { continuityApprovalInputSchema, verifySavedContinuityIntent },
    { hostedOperatorClientForSession },
  ] = await Promise.all([
    import("../eve/private-continuity-approval"),
    import("../provisioning/hosted-operator-client"),
  ]);
  const parsed = continuityApprovalInputSchema.parse(input);
  const operator = await hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
  if (parsed.plan.target.sessionId !== operator.sessionId) {
    throw new Error("Continuity session differs.");
  }
  const saved = await operator.readContinuity(parsed.plan.intentId, ctx.abortSignal);
  const request = verifySavedContinuityIntent(parsed, saved);
  if (saved.status.supersededBy !== undefined) {
    throw new Error("Continuity intent was superseded; use its saved successor.");
  }
  // A planned intent has no durable effect approval. Ask for exact fresh consent;
  // execution still verifies the actual native approval before any outward effect.
  return saved.status.state === "planned"
    ? { approved: false }
    : await operator.continuityApproval(request, ctx.abortSignal);
}
