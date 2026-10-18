import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  HostedOperatorRecordBase,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const RENEWED_BINDINGS_DESCRIPTION =
  "Bind app-owned runtime URL and public verification context, and allow the configured Gateway Preview to reach this app Preview.";
const RENEWED_GATEWAY_BINDINGS_DESCRIPTION =
  "Bind shared Gateway runtime and allow this app Preview to read the Gateway's public signing keys.";

export interface RetentionRenewalDeliveryProvenance {
  approvedByCallId: string;
  approvalId: string;
  deliveryCandidates: readonly OperatorDeploymentCandidate[];
  gatewayDeliveryCandidates: readonly OperatorDeploymentCandidate[];
  operationRef: string;
  plan: HostedOperatorPlan;
  planDigest: string;
}

const UNAPPROVED_PLAN_CALL_ID = "operator:unapproved-plan";
const isExpiredAt = (timestamp: number, now: number) =>
  Number.isFinite(timestamp) && timestamp <= now;
const isFutureAt = (timestamp: number, now: number) =>
  Number.isFinite(timestamp) && timestamp > now;
const hasText = (value: string | undefined) => value !== undefined && value.length > 0;
const isRealApprovalCall = (callId: string) =>
  callId.length > 0 && callId !== UNAPPROVED_PLAN_CALL_ID;
const receiptsPrecedePending = (
  operator: HostedOperatorRecord,
  previousEffectIds: Set<string>,
  receiptIds: Set<string>,
) =>
  !operator.receipts.some((receipt) => receipt.effectId === operator.pendingEffectId) &&
  operator.receipts.every((receipt) => previousEffectIds.has(receipt.effectId)) &&
  [...previousEffectIds].every((effectId) => receiptIds.has(effectId));
const hasNoActiveLease = (record: HostedRuntimeJournalRecord, leaseExpiry: number, now: number) =>
  record.leaseId === undefined || (Number.isFinite(leaseExpiry) && leaseExpiry <= now);

const renewalSourceFields = (prior: HostedOperatorPlan) => ({
  appBoundary: prior.deploymentBoundary?.app,
  gatewayBoundary: prior.deploymentBoundary?.gateway,
  sourceWorkload: prior.gatewayBindings?.sourceWorkload,
});

const isSupportedRenewalSource = (prior: HostedOperatorPlan) => {
  const { appBoundary, gatewayBoundary, sourceWorkload } = renewalSourceFields(prior);
  return [
    prior.action === "prepare",
    prior.stage === "app",
    prior.delivery !== undefined,
    sourceWorkload !== undefined,
    appBoundary !== undefined,
    gatewayBoundary !== undefined,
    sourceWorkload?.environment === "preview",
    sourceWorkload?.projectId === gatewayBoundary?.projectId,
    sourceWorkload?.ownerId === prior.deploymentBoundary?.teamId,
    appBoundary?.environment === "preview",
    appBoundary?.projectId === prior.selection.projectId,
    prior.delivery?.projectId === appBoundary?.projectId,
    prior.delivery?.branch === appBoundary?.branch,
  ].every(Boolean);
};

const hasRenewableBindingsEffect = (prior: HostedOperatorPlan) => {
  const { sourceWorkload } = renewalSourceFields(prior);
  const bindingCount = prior.effects.filter((effect) => effect.kind === "bindings").length;
  const trustedSource = prior.appTrustedSources?.gatewayPreview;
  return [
    bindingCount === 1,
    trustedSource === undefined || trustedSource.from === "preview",
    trustedSource === undefined || trustedSource.projectId === sourceWorkload?.projectId,
    trustedSource === undefined || trustedSource.to === "preview",
  ].every(Boolean);
};

const renewalPlanFrom = (prior: HostedOperatorPlan, expiresAt: string) => {
  if (!isSupportedRenewalSource(prior) || !hasRenewableBindingsEffect(prior)) {
    return null;
  }
  const { sourceWorkload } = renewalSourceFields(prior);
  const { gatewayBindings } = prior;
  if (sourceWorkload === undefined || gatewayBindings === undefined) {
    return null;
  }
  return hostedOperatorPlanSchema.safeParse({
    ...prior,
    appTrustedSources: {
      gatewayPreview: {
        from: "preview",
        projectId: sourceWorkload.projectId,
        to: "preview",
      },
    },
    gatewayBindings: {
      ...gatewayBindings,
      trustedSources: {
        ...gatewayBindings.trustedSources,
        appPreview: { projectId: prior.selection.projectId, from: "preview", to: "preview" },
      },
    },
    effects: prior.effects.map((effect) => {
      if (effect.kind === "bindings") {
        return { ...effect, description: RENEWED_BINDINGS_DESCRIPTION };
      }
      if (effect.kind === "gateway-bindings") {
        return { ...effect, description: RENEWED_GATEWAY_BINDINGS_DESCRIPTION };
      }
      return effect;
    }),
    retention: { ...prior.retention, expiresAt },
  });
};

const isExactRenewalPlan = (prior: HostedOperatorPlan, candidate: HostedOperatorPlan) => {
  const expected = renewalPlanFrom(prior, candidate.retention.expiresAt);
  return (
    expected?.success === true &&
    operatorPlanDigest(expected.data) === operatorPlanDigest(candidate)
  );
};

/** Structural eligibility only. The service must recheck owner and both approvals before CAS. */
export const isRetentionRenewalSuccessor = (
  record: HostedRuntimeJournalRecord | undefined,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
  const operator = record?.operator;
  if (record === undefined || operator === undefined || !isExactRenewalPlan(operator.plan, plan)) {
    return false;
  }
  const pendingIndex = operator.plan.effects.findIndex(
    (effect) => effect.id === operator.pendingEffectId,
  );
  const pending = operator.plan.effects[pendingIndex];
  const previousEffectIds = new Set(
    operator.plan.effects.slice(0, pendingIndex).map((effect) => effect.id),
  );
  const receiptIds = new Set(operator.receipts.map((receipt) => receipt.effectId));
  const oldExpiry = Date.parse(operator.plan.retention.expiresAt);
  const newExpiry = Date.parse(plan.retention.expiresAt);
  const leaseExpiry =
    record.leaseExpiresAt === undefined ? Number.NaN : Date.parse(record.leaseExpiresAt);
  return [
    Number.isFinite(now),
    isExpiredAt(oldExpiry, now),
    isFutureAt(newExpiry, now),
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    hasText(operator.approvalId),
    isRealApprovalCall(record.approvedByCallId),
    operator.planDigest === operatorPlanDigest(operator.plan),
    operator.pendingEffectId !== undefined && pending?.kind === "gateway-delivery",
    receiptsPrecedePending(operator, previousEffectIds, receiptIds),
    hasNoActiveLease(record, leaseExpiry, now),
  ].every(Boolean);
};

/** Build the one expiry/trusted-source renewal from the exact existing approved app plan. */
export const createRetentionRenewalPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  now: number,
): HostedOperatorPlan | undefined => {
  const operator = record?.operator;
  if (operator === undefined || !Number.isFinite(now)) {
    return undefined;
  }
  const candidate = renewalPlanFrom(operator.plan, new Date(now + RENEWAL_WINDOW_MS).toISOString());
  return candidate?.success === true && isRetentionRenewalSuccessor(record, candidate.data, now)
    ? candidate.data
    : undefined;
};

const isValidRenewalProvenance = (
  retained: { approvedByCallId: string; operator: HostedOperatorRecordBase },
  currentPlan: HostedOperatorPlan,
  operationRef: string,
): retained is {
  approvedByCallId: string;
  operator: HostedOperatorRecord & { approvalId: string };
} => {
  const prior = retained.operator;
  return [
    isRealApprovalCall(retained.approvedByCallId),
    hasText(prior.approvalId),
    prior.operationRef === operationRef,
    prior.planDigest === operatorPlanDigest(prior.plan),
    isExactRenewalPlan(prior.plan, currentPlan),
  ].every(Boolean);
};

const isPendingSavedRenewal = (
  record: HostedRuntimeJournalRecord | undefined,
  operator: HostedRuntimeJournalRecord["operator"],
  now: number,
) => {
  if (record === undefined || operator === undefined) {
    return false;
  }
  const expiry = Date.parse(operator.plan.retention.expiresAt);
  const leaseExpiry = Date.parse(record.leaseExpiresAt ?? "");
  return [
    Number.isFinite(now),
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    record.approvedByCallId === UNAPPROVED_PLAN_CALL_ID,
    operator.approvalId === undefined,
    operator.planDigest === operatorPlanDigest(operator.plan),
    isFutureAt(expiry, now),
    hasNoActiveLease(record, leaseExpiry, now),
  ].every(Boolean);
};

const hasReadableSavedRenewalState = (
  operator: HostedOperatorRecord,
  predecessor: HostedOperatorRecord,
) => {
  const immutableKinds = new Set(["resources", "install", "auth-membership"]);
  const effectsById = new Map(operator.plan.effects.map((effect) => [effect.id, effect]));
  const predecessorReceipts = new Set(
    predecessor.receipts.map((receipt) => JSON.stringify(receipt)),
  );
  return [
    operator.pendingEffectId === undefined,
    operator.pendingEffectAttempt === undefined,
    (operator.deliveryCandidates ?? []).length === 0,
    (operator.gatewayDeliveryCandidates ?? []).length === 0,
    operator.receipts.every((receipt) => {
      const effect = effectsById.get(receipt.effectId);
      return (
        effect !== undefined &&
        immutableKinds.has(effect.kind) &&
        predecessorReceipts.has(JSON.stringify(receipt))
      );
    }),
  ].every(Boolean);
};

/** Re-expose the exact saved successor on repeated ordinary planning requests. */
export const readPendingRetentionRenewalPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  now: number,
): HostedOperatorPlan | undefined => {
  const operator = record?.operator;
  if (operator === undefined || !isPendingSavedRenewal(record, operator, now)) {
    return undefined;
  }
  const predecessor = (operator.retainedRenewalOperations ?? []).find((retained) =>
    isValidRenewalProvenance(retained, operator.plan, operator.operationRef),
  );
  return predecessor !== undefined && hasReadableSavedRenewalState(operator, predecessor.operator)
    ? operator.plan
    : undefined;
};

/** Historical app/Gateway candidates remain paired with their original approved source metadata. */
export const retentionRenewalDeliveryProvenance = (
  record: HostedRuntimeJournalRecord | undefined,
): readonly RetentionRenewalDeliveryProvenance[] => {
  const current = record?.operator;
  if (current === undefined) {
    return [];
  }
  const provenance: RetentionRenewalDeliveryProvenance[] = [];
  for (const retained of (current.retainedRenewalOperations ?? []).toReversed()) {
    if (!isValidRenewalProvenance(retained, current.plan, current.operationRef)) {
      continue;
    }
    const { approvedByCallId, operator: prior } = retained;
    provenance.push({
      approvedByCallId,
      approvalId: prior.approvalId,
      deliveryCandidates: (prior.deliveryCandidates ?? []).filter(
        (candidate) => candidate.operationRef === prior.operationRef,
      ),
      gatewayDeliveryCandidates: (prior.gatewayDeliveryCandidates ?? []).filter(
        (candidate) => candidate.operationRef === prior.operationRef,
      ),
      operationRef: prior.operationRef,
      plan: prior.plan,
      planDigest: prior.planDigest,
    });
  }
  return provenance;
};

/** Validate one archived predecessor before a provider adapter reads its candidate metadata. */
export const isRetentionRenewalDeliveryProvenance = (
  provenance: RetentionRenewalDeliveryProvenance,
  currentPlan: HostedOperatorPlan,
  operationRef: string,
): boolean => {
  const parsed = hostedOperatorPlanSchema.safeParse(provenance.plan);
  return [
    isRealApprovalCall(provenance.approvedByCallId),
    hasText(provenance.approvalId),
    provenance.operationRef === operationRef,
    parsed.success,
    provenance.planDigest === operatorPlanDigest(provenance.plan),
    isExactRenewalPlan(provenance.plan, currentPlan),
    provenance.deliveryCandidates.every((candidate) => candidate.operationRef === operationRef),
    provenance.gatewayDeliveryCandidates.every(
      (candidate) => candidate.operationRef === operationRef,
    ),
  ].every(Boolean);
};
