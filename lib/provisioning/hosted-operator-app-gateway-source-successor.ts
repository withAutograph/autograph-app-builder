import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

type RetainedGatewayOperation = NonNullable<
  NonNullable<HostedRuntimeJournalRecord["operator"]>["retainedGatewayDeliveries"]
>[number];

export type AppGatewayDeliverySource = NonNullable<HostedOperatorPlan["gatewayDelivery"]>;

/** Proposes only an unattempted APP delivery's source change; this metadata grants no authority. */
const proposedSourcePlan = (
  record: HostedRuntimeJournalRecord | undefined,
  source: AppGatewayDeliverySource,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
  const delivery = prior?.plan.gatewayDelivery;
  if (record === undefined || prior === undefined || delivery === undefined) {
    return undefined;
  }
  const invalid = [
    record.status !== "pending",
    record.step !== "reserved",
    record.privateState === undefined,
    prior.plan.action !== "prepare",
    prior.plan.stage !== "app",
    prior.approvalId === undefined,
    record.approvedByCallId === "operator:unapproved-plan",
    prior.planDigest !== operatorPlanDigest(prior.plan),
    delivery.gitSha === source.gitSha,
    delivery.branch !== source.branch,
    delivery.projectId !== source.projectId,
    delivery.repoId !== source.repoId,
  ].some(Boolean);
  if (invalid) {
    return undefined;
  }
  const effect = prior.plan.effects.find((entry) => entry.kind === "gateway-delivery");
  if (
    effect === undefined ||
    prior.pendingEffectId === effect.id ||
    prior.receipts.some((receipt) => receipt.effectId === effect.id) ||
    // Other attempted-delivery states retain their existing retry/reconciliation path.
    // In particular, this proposal never discards an unknown create or alias intent.
    prior.gatewayDeliveryCandidates?.some(
      (candidate) => candidate.operationRef === prior.operationRef,
    ) === true
  ) {
    return undefined;
  }
  const candidate = hostedOperatorPlanSchema.safeParse({
    ...prior.plan,
    gatewayDelivery: { ...delivery, gitSha: source.gitSha },
  });
  return candidate.success ? candidate.data : undefined;
};
const idle = (record: HostedRuntimeJournalRecord, now: number) =>
  record.leaseId === undefined ||
  (record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= now);

/** Called inside the live original execution only after its pending receipt has settled. */
export const hasAppGatewaySourceUpdate = (
  record: HostedRuntimeJournalRecord,
  source: AppGatewayDeliverySource,
): boolean => proposedSourcePlan(record, source) !== undefined;

/** Only a receipt-cleared record can change its approved plan; pending worker context is never moved. */
export const createAppGatewaySourceSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  source: AppGatewayDeliverySource,
  now: number,
): HostedOperatorPlan | undefined => {
  if (
    record === undefined ||
    !idle(record, now) ||
    record.operator?.pendingEffectId !== undefined ||
    record.operator?.pendingEffectAttempt !== undefined
  ) {
    return undefined;
  }
  return proposedSourcePlan(record, source);
};

/** Canonical source-only ancestry is evidence; the caller must read its original approval. */
export const readAppGatewaySourcePredecessor = (
  record: HostedRuntimeJournalRecord,
): RetainedGatewayOperation | undefined => {
  const current = record.operator;
  if (
    current?.plan.gatewayDelivery === undefined ||
    current.planDigest !== operatorPlanDigest(current.plan)
  ) {
    return undefined;
  }
  const source = current.plan.gatewayDelivery;
  return current.retainedGatewayDeliveries?.findLast((entry) => {
    if (
      entry.operator.operationRef !== current.operationRef ||
      entry.operator.pendingEffectId !== undefined ||
      entry.operator.pendingEffectAttempt !== undefined
    ) {
      return false;
    }
    const proposed = proposedSourcePlan(
      { ...record, approvedByCallId: entry.approvedByCallId, operator: entry.operator },
      source,
    );
    return proposed !== undefined && operatorPlanDigest(proposed) === current.planDigest;
  });
};

/** Re-expose one already reserved source proposal, including after a lost planning response. */
export const readSavedAppGatewaySourcePlan = (
  record: HostedRuntimeJournalRecord | undefined,
  now: number,
  source?: AppGatewayDeliverySource,
): HostedOperatorPlan | undefined => {
  if (
    record === undefined ||
    !idle(record, now) ||
    [
      record.status !== "pending",
      record.step !== "reserved",
      readAppGatewaySourcePredecessor(record) === undefined,
    ].some(Boolean)
  ) {
    return undefined;
  }
  const plan = record.operator?.plan;
  if (
    source !== undefined &&
    [
      plan?.gatewayDelivery?.branch !== source.branch,
      plan?.gatewayDelivery?.projectId !== source.projectId,
      plan?.gatewayDelivery?.repoId !== source.repoId,
    ].some(Boolean)
  ) {
    return undefined;
  }
  return plan;
};

/** Pending work keeps its exact original plan, including its original completed Auth provenance. */
export const readAppGatewaySourceContinuationPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  source: AppGatewayDeliverySource,
  now: number,
): HostedOperatorPlan | undefined => {
  const saved = readSavedAppGatewaySourcePlan(record, now, source);
  if (
    saved !== undefined &&
    (record?.approvedByCallId === "operator:unapproved-plan" ||
      saved.gatewayDelivery?.gitSha === source.gitSha)
  ) {
    return saved;
  }
  if (
    record === undefined ||
    !idle(record, now) ||
    proposedSourcePlan(record, source) === undefined
  ) {
    return undefined;
  }
  const pending = record.operator?.pendingEffectId;
  if (pending !== undefined) {
    return record.operator?.plan.effects.some((effect) => effect.id === pending) === true
      ? record.operator.plan
      : undefined;
  }
  return createAppGatewaySourceSuccessorPlan(record, source, now);
};

export const isAppGatewaySourceSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
  if (plan.gatewayDelivery === undefined) {
    return false;
  }
  const candidate = createAppGatewaySourceSuccessorPlan(record, plan.gatewayDelivery, now);
  return candidate !== undefined && operatorPlanDigest(candidate) === operatorPlanDigest(plan);
};
