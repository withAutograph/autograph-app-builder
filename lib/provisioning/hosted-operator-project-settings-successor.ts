import { isDeepStrictEqual } from "node:util";
import type { HostedOperatorAppProjectSettings } from "./hosted-operator-app-project-settings";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
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
  const bindingIndex = prior.plan.effects.findIndex(
    (effect) => effect.id === prior.pendingEffectId,
  );
  const binding = prior.plan.effects[bindingIndex];
  const receiptIds = new Set(prior.receipts.map((receipt) => receipt.effectId));
  const prerequisiteIds = new Set(
    prior.plan.effects.slice(0, bindingIndex).map((effect) => effect.id),
  );
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
    binding?.kind === "bindings",
    new Set(prior.plan.effects.map((effect) => effect.id)).size === prior.plan.effects.length,
    prior.receipts.every((receipt) => prerequisiteIds.has(receipt.effectId)),
    [...prerequisiteIds].every((effectId) => receiptIds.has(effectId)),
    (prior.deliveryCandidates?.length ?? 0) === 0,
    prior.deliveredDeploymentId === undefined,
  ].every(Boolean);
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
