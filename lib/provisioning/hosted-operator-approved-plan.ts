/* oxlint-disable eslint/no-await-in-loop -- Journal CAS retries must freshly reread canonical approval and ownership sequentially. */
import {
  HostedOperatorError,
  sameOperatorPlanExceptExpiry,
  sameOperatorSelection,
  operatorPlanDigest,
  operatorPublicResultSchema,
} from "./hosted-operator-contract";
import type {
  OperatorRequest,
  HostedOperatorPlan,
  OperatorPublicResult,
} from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";

const assertOriginalPlan = (
  original: { plan: HostedOperatorPlan; planDigest: string },
  proposed: HostedOperatorPlan,
  selection: HostedOperatorPlan["selection"],
  now: number,
) => {
  if (
    !sameOperatorPlanExceptExpiry(original.plan, proposed) ||
    original.planDigest !== operatorPlanDigest(original.plan) ||
    !sameOperatorSelection(original.plan.selection, selection)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (Date.parse(original.plan.retention.expiresAt) <= now) {
    throw new HostedOperatorError("authorization_required");
  }
};

export const recoverOriginalApprovedPlan = async (
  deps: Pick<ProtectedHostedOperatorDependencies, "readApprovedPlan" | "assertAuthorized"> & {
    store: Pick<ProtectedHostedOperatorDependencies["store"], "read" | "compareAndSet">;
  },
  context: HostedOperatorContext,
  input: Extract<OperatorRequest, { action: "plan" }>,
  appId: string,
  plan: HostedOperatorPlan,
  now: () => number,
): Promise<OperatorPublicResult | null> => {
  if (deps.readApprovedPlan === undefined || plan.action !== "prepare") {
    return null;
  }
  for (;;) {
    // Each CAS retry rechecks current canonical ownership and actual approval.
    const current = await deps.store.read(context);
    const saved = current?.record.operator;
    const original = await deps.readApprovedPlan({
      ...context,
      plan,
      now: now(),
      ...(saved === undefined ? {} : { currentOperation: saved }),
    });
    if (original === null) {
      return null;
    }
    assertOriginalPlan(original, plan, input.selection, now());
    await deps.assertAuthorized({ ...context, plan: original.plan });
    if (current === undefined || saved === undefined) {
      return null;
    }
    if (!sameOperatorPlanExceptExpiry(original.plan, saved.plan)) {
      throw new HostedOperatorError("resource_mismatch");
    }
    if (
      saved.operationRef !== original.operationRef &&
      [
        current.record.status !== "pending",
        current.record.step !== "reserved",
        current.record.approvedByCallId !== "operator:unapproved-plan",
        current.record.leaseId !== undefined,
        saved.pendingEffectId !== undefined,
        saved.pendingEffectAttempt !== undefined,
        saved.receipts.length > 0,
        (saved.workerCheckpoints?.length ?? 0) > 0,
      ].some(Boolean)
    ) {
      throw new HostedOperatorError("operation_in_progress");
    }
    if (saved.operationRef === original.operationRef) {
      if (saved.planDigest !== original.planDigest) {
        throw new HostedOperatorError("resource_mismatch");
      }
      return operatorPublicResultSchema.parse({
        appId,
        authenticatedBehavior: "unassessed",
        status: "planned",
        ...original,
      });
    }
    const record = { ...current.record, operator: { ...saved, ...original } };
    const restored = await deps.store.compareAndSet({
      ...context,
      record,
      expectedRevision: current.revision,
      now: new Date(now()),
    });
    if (restored === undefined) {
      continue;
    }
    return operatorPublicResultSchema.parse({
      appId,
      authenticatedBehavior: "unassessed",
      status: "planned",
      ...original,
    });
  }
};
