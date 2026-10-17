import { isDeepStrictEqual } from "node:util";
import type { HostedOperatorAppProjectSettings } from "./hosted-operator-app-project-settings";
import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const hasOnlyProjectSettingsChanged = (
  prior: HostedOperatorPlan,
  candidate: HostedOperatorPlan,
) => {
  if (
    ![prior, candidate].every((plan) => plan.action === "prepare" && plan.stage === "app") ||
    prior.delivery === undefined ||
    candidate.delivery?.projectSettings === undefined
  ) {
    return false;
  }
  if (isDeepStrictEqual(prior.delivery.projectSettings, candidate.delivery.projectSettings)) {
    return false;
  }
  const restoredDelivery = { ...candidate.delivery };
  if (prior.delivery.projectSettings === undefined) {
    delete restoredDelivery.projectSettings;
  } else {
    restoredDelivery.projectSettings = prior.delivery.projectSettings;
  }
  const restored = hostedOperatorPlanSchema.safeParse({ ...candidate, delivery: restoredDelivery });
  return restored.success && operatorPlanDigest(restored.data) === operatorPlanDigest(prior);
};

/** Structural eligibility; the service separately rechecks live ownership and prior approval. */
export const isProjectSettingsSuccessor = (
  record: HostedRuntimeJournalRecord,
  candidate: HostedOperatorPlan,
  now: number,
): boolean => {
  const prior = record.operator;
  if (prior === undefined || !hasOnlyProjectSettingsChanged(prior.plan, candidate)) {
    return false;
  }
  const pendingIndex = prior.plan.effects.findIndex(
    (effect) => effect.id === prior.pendingEffectId,
  );
  const pending = prior.plan.effects[pendingIndex];
  const receiptIds = new Set(prior.receipts.map((receipt) => receipt.effectId));
  const prerequisiteIds = new Set(
    prior.plan.effects.slice(0, pendingIndex).map((effect) => effect.id),
  );
  const pendingBindings = pending?.kind === "bindings";
  const pendingDelivery = pending?.kind === "delivery";
  const deliveryCandidates = prior.deliveryCandidates ?? [];
  const candidatesAreOnlyTerminalAttempts = deliveryCandidates.every((deliveryCandidate) =>
    [
      deliveryCandidate.operationRef === prior.operationRef,
      deliveryCandidate.projectId === prior.plan.delivery?.projectId,
      deliveryCandidate.branch === prior.plan.delivery?.branch,
      deliveryCandidate.repoId === prior.plan.delivery?.repoId,
      ["BLOCKED", "ERROR"].includes(deliveryCandidate.readyState),
    ].every(Boolean),
  );
  const recoverableBindings = pendingBindings && deliveryCandidates.length === 0;
  const recoverableDelivery = pendingDelivery && candidatesAreOnlyTerminalAttempts;
  const recoverablePendingEffect =
    (recoverableBindings || recoverableDelivery) && prior.deliveredDeploymentId === undefined;
  const expiry = Date.parse(prior.plan.retention.expiresAt);
  const leaseExpiry =
    record.leaseExpiresAt === undefined ? Number.NaN : Date.parse(record.leaseExpiresAt);
  return [
    Number.isFinite(now),
    Number.isFinite(expiry) && expiry > now,
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    prior.approvalId !== undefined && prior.approvalId.length > 0,
    record.approvedByCallId.length > 0 && record.approvedByCallId !== "operator:unapproved-plan",
    record.leaseId === undefined || (Number.isFinite(leaseExpiry) && leaseExpiry <= now),
    prior.planDigest === operatorPlanDigest(prior.plan),
    recoverablePendingEffect,
    new Set(prior.plan.effects.map((effect) => effect.id)).size === prior.plan.effects.length,
    prior.receipts.every((receipt) => prerequisiteIds.has(receipt.effectId)),
    [...prerequisiteIds].every((effectId) => receiptIds.has(effectId)),
  ].every(Boolean);
};

/** Exact old-plan provenance for a profile successor; the adapter must reconcile it before POST. */
export const projectSettingsDeliveryProvenance = (
  operator: HostedOperatorRecord,
  currentPlan: HostedOperatorPlan,
):
  | {
      approvedByCallId: string;
      approvalId: string;
      plan: HostedOperatorPlan;
      planDigest: string;
      operationRef: string;
      deliveryCandidates: readonly OperatorDeploymentCandidate[];
    }
  | undefined => {
  if (currentPlan.delivery?.projectSettings === undefined) {
    return undefined;
  }
  for (const retained of (operator.retainedProjectSettingsOperations ?? []).toReversed()) {
    const prior = retained.operator;
    const deliveryIndex = prior.plan.effects.findIndex(
      (effect) => effect.id === prior.pendingEffectId && effect.kind === "delivery",
    );
    const priorEffectIds = new Set(
      prior.plan.effects.slice(0, deliveryIndex).map((effect) => effect.id),
    );
    const priorReceiptIds = new Set(prior.receipts.map((receipt) => receipt.effectId));
    if (prior.approvalId === undefined) {
      continue;
    }
    const exactRetainedDelivery = [
      operator.planDigest === operatorPlanDigest(operator.plan),
      prior.planDigest === operatorPlanDigest(prior.plan),
      prior.operationRef === operator.operationRef,
      operator.pendingEffectId === prior.pendingEffectId,
      deliveryIndex !== -1,
      prior.receipts.every((receipt) => receipt.effectId !== prior.pendingEffectId),
      prior.receipts.every((receipt) => priorEffectIds.has(receipt.effectId)),
      [...priorEffectIds].every((effectId) => priorReceiptIds.has(effectId)),
      hasOnlyProjectSettingsChanged(prior.plan, currentPlan),
    ].every(Boolean);
    if (exactRetainedDelivery) {
      return {
        approvedByCallId: retained.approvedByCallId,
        approvalId: prior.approvalId,
        deliveryCandidates: prior.deliveryCandidates ?? [],
        operationRef: prior.operationRef,
        plan: prior.plan,
        planDigest: prior.planDigest,
      };
    }
  }
  return undefined;
};

/** Propose the same retained operation with only explicitly configured delivery settings changed. */
export const createProjectSettingsSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  projectSettings: HostedOperatorAppProjectSettings | undefined,
  now: number,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
  if (record === undefined || prior?.plan.delivery === undefined || projectSettings === undefined) {
    return undefined;
  }
  const candidate = hostedOperatorPlanSchema.safeParse({
    ...prior.plan,
    delivery: { ...prior.plan.delivery, projectSettings },
  });
  return candidate.success && isProjectSettingsSuccessor(record, candidate.data, now)
    ? candidate.data
    : undefined;
};

/** Re-expose a saved proposal for ordinary approval without granting its predecessor's authority. */
export const readPendingProjectSettingsSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  projectSettings: HostedOperatorAppProjectSettings | undefined,
  now: number,
): HostedOperatorPlan | undefined => {
  const current = record?.operator;
  if (record === undefined || current === undefined || projectSettings === undefined) {
    return undefined;
  }
  const exactProposal = [
    record.approvedByCallId === "operator:unapproved-plan",
    current.approvalId === undefined,
    isDeepStrictEqual(current.plan.delivery?.projectSettings, projectSettings),
    current.planDigest === operatorPlanDigest(current.plan),
  ].every(Boolean);
  if (!exactProposal) {
    return undefined;
  }
  const retained = current.retainedProjectSettingsOperations ?? [];
  return retained.some(
    (prior) =>
      prior.operator.operationRef === current.operationRef &&
      prior.operator.pendingEffectId === current.pendingEffectId &&
      isProjectSettingsSuccessor(
        { ...record, approvedByCallId: prior.approvedByCallId, operator: prior.operator },
        current.plan,
        now,
      ),
  )
    ? current.plan
    : undefined;
};
