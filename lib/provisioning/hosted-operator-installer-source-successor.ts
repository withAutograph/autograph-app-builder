import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const UNAPPROVED_PLAN = "operator:unapproved-plan";

const isAppPreparePlan = (plan: HostedOperatorPlan): boolean =>
  plan.action === "prepare" && plan.stage === "app";

export interface RepairedInstallerSource {
  id: string;
  sha256: string;
}

const hasOnlyInstallerDigestChanged = (
  prior: HostedOperatorPlan,
  candidate: HostedOperatorPlan,
): boolean => {
  if (!isAppPreparePlan(prior) || !isAppPreparePlan(candidate)) {
    return false;
  }
  if (prior.installer.reference !== candidate.installer.reference) {
    return false;
  }
  if (prior.installer.sha256 === candidate.installer.sha256) {
    return false;
  }

  const restored = hostedOperatorPlanSchema.safeParse({
    ...candidate,
    installer: { ...candidate.installer, sha256: prior.installer.sha256 },
  });
  return restored.success && operatorPlanDigest(restored.data) === operatorPlanDigest(prior);
};

const hasObservedInstallPrerequisites = (
  prior: NonNullable<HostedRuntimeJournalRecord["operator"]>,
  installEffectId: string,
): boolean => {
  const effectIndexes = new Map(prior.plan.effects.map((effect, index) => [effect.id, index]));
  const installIndex = effectIndexes.get(installEffectId);
  if (installIndex === undefined) {
    return false;
  }

  const receiptIds = new Set(prior.receipts.map((receipt) => receipt.effectId));
  return (
    prior.receipts.every((receipt) => {
      const index = effectIndexes.get(receipt.effectId);
      return index !== undefined && index < installIndex;
    }) &&
    prior.plan.effects.slice(0, installIndex).every((effect) => receiptIds.has(effect.id)) &&
    !receiptIds.has(installEffectId)
  );
};

/** Structural eligibility only. The caller must recheck canonical ownership and old approval. */
export const isInstallerSourceSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
  const prior = record.operator;
  if (prior === undefined || !hasOnlyInstallerDigestChanged(prior.plan, plan)) {
    return false;
  }

  const install = prior.plan.effects.find((effect) => effect.id === prior.pendingEffectId);
  if (install === undefined || install.kind !== "install") {
    return false;
  }
  // The existing router assigns this reserved effect to the separate Auth worker.
  if (install.id === "auth-schema") {
    return false;
  }
  if (
    install.resourceId !== undefined &&
    install.resourceId !== prior.plan.appDatabase.resourceId
  ) {
    return false;
  }
  if (new Set(prior.plan.effects.map((effect) => effect.id)).size !== prior.plan.effects.length) {
    return false;
  }
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
    record.approvedByCallId.length > 0 && record.approvedByCallId !== UNAPPROVED_PLAN,
    record.leaseId === undefined || (Number.isFinite(leaseExpiry) && leaseExpiry <= now),
    prior.planDigest === operatorPlanDigest(prior.plan),
    prior.pendingEffectId === install.id,
    hasObservedInstallPrerequisites(prior, install.id),
  ].every(Boolean);
};

/** Build only the proposed digest replacement; it carries no approval authority. */
export const createInstallerSourceSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  worker: RepairedInstallerSource,
  now: number,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
  if (
    record === undefined ||
    prior === undefined ||
    worker.id !== prior.plan.installer.reference ||
    worker.sha256 === prior.plan.installer.sha256
  ) {
    return undefined;
  }

  const candidate = hostedOperatorPlanSchema.safeParse({
    ...prior.plan,
    installer: { ...prior.plan.installer, sha256: worker.sha256 },
  });
  if (!candidate.success || !isInstallerSourceSuccessor(record, candidate.data, now)) {
    return undefined;
  }
  return candidate.data;
};
