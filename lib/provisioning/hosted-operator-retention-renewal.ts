import type {
  HostedOperatorPlan,
  HostedOperatorRecord,
  HostedOperatorRecordBase,
  ManagedOperatorEnvironmentRow,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const RENEWAL_WINDOW_MS = 24 * 60 * 60 * 1000;
const GATEWAY_BINDINGS_KIND = "gateway-bindings";
const RENEWED_BINDINGS_DESCRIPTION =
  "Bind app-owned runtime URL and public verification context, and allow the configured Gateway Preview to reach this app Preview.";
const RENEWED_GATEWAY_BINDINGS_DESCRIPTION =
  "Bind shared Gateway runtime and allow this app Preview to read the Gateway's public signing keys.";
const PREVIEW_ENVIRONMENT = `preview`;
const PROTECTED_OPERATOR_COMMENT_PREFIX = "App Builder protected operator ";

export interface RetentionRenewalDeliveryProvenance {
  approvedByCallId: string;
  approvalId: string;
  deliveryCandidates: readonly OperatorDeploymentCandidate[];
  gatewayDeliveryCandidates: readonly OperatorDeploymentCandidate[];
  operationRef: string;
  pendingEffectId?: string;
  pendingEffectAttempt?: HostedOperatorRecordBase["pendingEffectAttempt"];
  plan: HostedOperatorPlan;
  planDigest: string;
}

const BINDINGS_KIND = "bindings";
type BindingKind = typeof BINDINGS_KIND | typeof GATEWAY_BINDINGS_KIND;
export interface RetentionRenewalBindingProvenance {
  approvedByCallId: string;
  approvalId: string;
  effectId: string;
  kind: BindingKind;
  operationRef: string;
  pendingEffectAttempt: NonNullable<HostedOperatorRecordBase["pendingEffectAttempt"]>;
  plan: HostedOperatorPlan;
  planDigest: string;
  rows: readonly ManagedOperatorEnvironmentRow[];
}

const UNAPPROVED_PLAN_CALL_ID = "operator:unapproved-plan";
const isExpiredAt = (timestamp: number, now: number) =>
  Number.isFinite(timestamp) && timestamp <= now;
const isFutureAt = (timestamp: number, now: number) =>
  Number.isFinite(timestamp) && timestamp > now;
const hasText = (value: string | undefined) => value !== undefined && value.length > 0;
const isRealApprovalCall = (callId: string) =>
  callId.length > 0 && callId !== UNAPPROVED_PLAN_CALL_ID;
const isBindingKind = (kind: string): kind is BindingKind =>
  kind === BINDINGS_KIND || kind === GATEWAY_BINDINGS_KIND;
const receiptsPrecedePending = (
  operator: HostedOperatorRecord,
  previousEffectIds: Set<string>,
  receiptIds: Set<string>,
  pendingEffectId: string | undefined,
) =>
  !operator.receipts.some((receipt) => receipt.effectId === pendingEffectId) &&
  operator.receipts.every((receipt) => previousEffectIds.has(receipt.effectId)) &&
  [...previousEffectIds].every((effectId) => receiptIds.has(effectId));
const hasNoActiveLease = (record: HostedRuntimeJournalRecord, leaseExpiry: number, now: number) =>
  record.leaseId === undefined || (Number.isFinite(leaseExpiry) && leaseExpiry <= now);

interface RenewalSourceFields {
  appBoundary?: NonNullable<HostedOperatorPlan["deploymentBoundary"]>["app"];
  gatewayBoundary?: NonNullable<HostedOperatorPlan["deploymentBoundary"]>["gateway"];
  sourceWorkload?: NonNullable<HostedOperatorPlan["gatewayBindings"]>["sourceWorkload"];
}

const renewalSourceFields = (prior: HostedOperatorPlan): RenewalSourceFields => {
  const fields: RenewalSourceFields = {};
  if (prior.deploymentBoundary?.app !== undefined) {
    fields.appBoundary = prior.deploymentBoundary.app;
  }
  if (prior.deploymentBoundary?.gateway !== undefined) {
    fields.gatewayBoundary = prior.deploymentBoundary.gateway;
  }
  if (prior.gatewayBindings?.sourceWorkload !== undefined) {
    fields.sourceWorkload = prior.gatewayBindings.sourceWorkload;
  }
  return fields;
};

const isSupportedGatewaySource = (
  sourceWorkload: NonNullable<HostedOperatorPlan["gatewayBindings"]>["sourceWorkload"],
  gatewayBoundary: NonNullable<HostedOperatorPlan["deploymentBoundary"]>["gateway"],
  prior: HostedOperatorPlan,
) =>
  sourceWorkload.environment === PREVIEW_ENVIRONMENT &&
  sourceWorkload.projectId === gatewayBoundary.projectId &&
  sourceWorkload.ownerId === prior.deploymentBoundary?.teamId;

const isSupportedAppBoundary = (
  appBoundary: NonNullable<HostedOperatorPlan["deploymentBoundary"]>["app"],
  prior: HostedOperatorPlan,
) =>
  appBoundary.environment === PREVIEW_ENVIRONMENT &&
  appBoundary.projectId === prior.selection.projectId &&
  prior.delivery?.projectId === appBoundary.projectId &&
  prior.delivery.branch === appBoundary.branch;

const isTrustedSourceForRenewal = (
  trustedSource: NonNullable<HostedOperatorPlan["appTrustedSources"]>["gatewayPreview"] | undefined,
  projectId: string | undefined,
) =>
  trustedSource === undefined ||
  (trustedSource.from === PREVIEW_ENVIRONMENT &&
    trustedSource.projectId === projectId &&
    trustedSource.to === PREVIEW_ENVIRONMENT);

const isSupportedRenewalSource = (prior: HostedOperatorPlan) => {
  const { appBoundary, gatewayBoundary, sourceWorkload } = renewalSourceFields(prior);
  if (prior.action !== "prepare" || prior.stage !== "app") {
    return false;
  }
  if (prior.delivery === undefined || sourceWorkload === undefined) {
    return false;
  }
  if (appBoundary === undefined || gatewayBoundary === undefined) {
    return false;
  }
  return (
    isSupportedGatewaySource(sourceWorkload, gatewayBoundary, prior) &&
    isSupportedAppBoundary(appBoundary, prior)
  );
};

const hasRenewableBindingsEffect = (prior: HostedOperatorPlan) => {
  const { sourceWorkload } = renewalSourceFields(prior);
  const bindingCount = prior.effects.filter((effect) => effect.kind === BINDINGS_KIND).length;
  const trustedSource = prior.appTrustedSources?.gatewayPreview;
  return bindingCount === 1 && isTrustedSourceForRenewal(trustedSource, sourceWorkload?.projectId);
};

const isRenewablePendingEffect = (
  pendingEffectId: string | undefined,
  pending: HostedOperatorPlan["effects"][number] | undefined,
  plan: HostedOperatorPlan,
) => {
  if (pendingEffectId === undefined || pending === undefined) {
    return false;
  }
  if (isBindingKind(pending.kind) || pending.kind === "gateway-delivery") {
    return true;
  }
  return (
    pending.kind === "delivery" &&
    plan.hostProtection !== undefined &&
    plan.appDeliveryReplacement !== undefined
  );
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
  const renewedPlan: HostedOperatorPlan = {
    ...prior,
    effects: prior.effects.map((effect) => {
      if (prior.hostProtection !== undefined) {
        return effect;
      }
      if (effect.kind === BINDINGS_KIND) {
        return { ...effect, description: RENEWED_BINDINGS_DESCRIPTION };
      }
      if (effect.kind === GATEWAY_BINDINGS_KIND) {
        return { ...effect, description: RENEWED_GATEWAY_BINDINGS_DESCRIPTION };
      }
      return effect;
    }),
    gatewayBindings: {
      ...gatewayBindings,
    },
    retention: { ...prior.retention, expiresAt },
  };
  if (prior.hostProtection === undefined) {
    renewedPlan.appTrustedSources = {
      gatewayPreview: {
        from: PREVIEW_ENVIRONMENT,
        projectId: sourceWorkload.projectId,
        to: PREVIEW_ENVIRONMENT,
      },
    };
    renewedPlan.gatewayBindings.trustedSources = {
      ...gatewayBindings.trustedSources,
      appPreview: {
        from: PREVIEW_ENVIRONMENT,
        projectId: prior.selection.projectId,
        to: PREVIEW_ENVIRONMENT,
      },
    };
  }
  return hostedOperatorPlanSchema.safeParse(renewedPlan);
};

const isExactRenewalPlan = (prior: HostedOperatorPlan, candidate: HostedOperatorPlan) => {
  const expected = renewalPlanFrom(prior, candidate.retention.expiresAt);
  return (
    expected?.success === true &&
    operatorPlanDigest(expected.data) === operatorPlanDigest(candidate)
  );
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

/** Uncertain native writes remain tied to the exact predecessor, never inferred from empty reads. */
export const isRetentionRenewalBindingProvenance = (
  provenance: RetentionRenewalBindingProvenance,
  currentPlan: HostedOperatorPlan,
  operationRef: string,
  effectId: string,
  kind: BindingKind,
): boolean => {
  const priorEffect = provenance.plan.effects.find((effect) => effect.id === effectId);
  const target =
    kind === BINDINGS_KIND
      ? provenance.plan.deploymentBoundary?.app
      : provenance.plan.deploymentBoundary?.gateway;
  return [
    isRealApprovalCall(provenance.approvedByCallId),
    hasText(provenance.approvalId),
    provenance.operationRef === operationRef,
    provenance.effectId === effectId,
    provenance.kind === kind,
    priorEffect?.kind === kind,
    provenance.planDigest === operatorPlanDigest(provenance.plan),
    isExactRenewalPlan(provenance.plan, currentPlan),
    target !== undefined,
    provenance.rows.every(
      (row) =>
        row.projectId === target?.projectId &&
        row.branch === target?.branch &&
        row.comment === `${PROTECTED_OPERATOR_COMMENT_PREFIX}${row.operationRef}`,
    ),
  ].every(Boolean);
};

/** Recover the most recent unresolved binding attempt without making its old approval current. */
export const retentionRenewalBindingProvenance = (
  record: HostedRuntimeJournalRecord | undefined,
  effectId: string,
): RetentionRenewalBindingProvenance | undefined => {
  const current = record?.operator;
  if (current === undefined) {
    return undefined;
  }
  const match = (current.retainedRenewalOperations ?? []).toReversed().find((retained) => {
    if (!isValidRenewalProvenance(retained, current.plan, current.operationRef)) {
      return false;
    }
    const prior = retained.operator;
    const effect = prior.plan.effects.find((candidate) => candidate.id === effectId);
    return (
      prior.pendingEffectId === effectId &&
      prior.pendingEffectAttempt !== undefined &&
      (effect?.kind === BINDINGS_KIND || effect?.kind === GATEWAY_BINDINGS_KIND)
    );
  });
  if (match !== undefined) {
    const prior = match.operator;
    const effect = prior.plan.effects.find((candidate) => candidate.id === effectId);
    if (effect === undefined || prior.pendingEffectAttempt === undefined) {
      return undefined;
    }
    return {
      approvalId: prior.approvalId,
      approvedByCallId: match.approvedByCallId,
      effectId,
      kind: effect.kind,
      operationRef: prior.operationRef,
      pendingEffectAttempt: structuredClone(prior.pendingEffectAttempt),
      plan: prior.plan,
      planDigest: prior.planDigest,
      rows: structuredClone(
        (effect.kind === BINDINGS_KIND ? prior.managedEnvironment : prior.gatewayEnvironment) ?? [],
      ),
    };
  }
  return undefined;
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
  let { pendingEffectId, pendingEffectAttempt } = operator;
  if (pendingEffectId === undefined) {
    const firstUnreceipted = operator.plan.effects.find(
      (effect) => !operator.receipts.some((receipt) => receipt.effectId === effect.id),
    );
    if (firstUnreceipted !== undefined) {
      const inherited: RetentionRenewalBindingProvenance | undefined =
        retentionRenewalBindingProvenance(record, firstUnreceipted.id);
      if (inherited !== undefined) {
        const { effectId: inheritedEffectId, pendingEffectAttempt: inheritedAttempt } = inherited;
        pendingEffectId = inheritedEffectId;
        pendingEffectAttempt = inheritedAttempt;
      }
    }
  }
  const pendingIndex = operator.plan.effects.findIndex((effect) => effect.id === pendingEffectId);
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
    isRenewablePendingEffect(pendingEffectId, pending, operator.plan),
    pending?.kind === "gateway-delivery" || pendingEffectAttempt !== undefined,
    receiptsPrecedePending(operator, previousEffectIds, receiptIds, pendingEffectId),
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
    const deliveryProvenance: RetentionRenewalDeliveryProvenance = {
      approvalId: prior.approvalId,
      approvedByCallId,
      deliveryCandidates: (prior.deliveryCandidates ?? []).filter(
        (candidate) => candidate.operationRef === prior.operationRef,
      ),
      gatewayDeliveryCandidates: (prior.gatewayDeliveryCandidates ?? []).filter(
        (candidate) => candidate.operationRef === prior.operationRef,
      ),
      operationRef: prior.operationRef,
      plan: prior.plan,
      planDigest: prior.planDigest,
    };
    if (prior.pendingEffectId !== undefined) {
      deliveryProvenance.pendingEffectId = prior.pendingEffectId;
    }
    if (prior.pendingEffectAttempt !== undefined) {
      deliveryProvenance.pendingEffectAttempt = structuredClone(prior.pendingEffectAttempt);
    }
    provenance.push(deliveryProvenance);
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
