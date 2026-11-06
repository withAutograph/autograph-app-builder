import { isDeepStrictEqual } from "node:util";
import type {
  HostedOperatorPlan,
  HostedOperatorRecordBase,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import { readyDeliveryReplacementIntentSchema } from "./hosted-operator-ready-delivery-replacement-intent";
import type { ReadyDeliveryReplacementIntent } from "./hosted-operator-ready-delivery-replacement-intent";
import { retentionRenewalDeliveryProvenance } from "./hosted-operator-retention-renewal";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

export interface ReadyDeliveryReplacementPredecessor {
  /** Temporary protected server-only transition input, never a public projection. Durable
   * integration archives exact predecessor operator/approval/receipts/attempt/candidates/rows
   * and existing history references, not this whole journal or privateState recursively.
   * Resource credentials retain their existing single custody contract. */
  snapshot: HostedRuntimeJournalRecord;
  originatingOperator: HostedOperatorRecordBase;
  approvedByCallId: string;
  appCandidate: OperatorDeploymentCandidate;
  gatewayCandidate?: OperatorDeploymentCandidate;
}

const hasValidApprovalId = (approvedByCallId: string) =>
  approvedByCallId.length > 0 && approvedByCallId !== "operator:unapproved-plan";

const hasApproval = (operator: HostedOperatorRecordBase, approvedByCallId: string) => {
  const approvalExists = operator.approvalId !== undefined && operator.approvalId.length > 0;
  const planIsValid = hostedOperatorPlanSchema.safeParse(operator.plan).success;
  const digestMatches = operator.planDigest === operatorPlanDigest(operator.plan);
  return hasValidApprovalId(approvedByCallId) && approvalExists && planIsValid && digestMatches;
};

const resourceIdentity = (plan: HostedOperatorPlan) => ({
  appDatabase: plan.appDatabase,
  authDatabase: plan.authDatabase,
  neon: plan.neon,
});

const isPreviewSelection = (plan: HostedOperatorPlan) =>
  [plan.action === "prepare", plan.stage === "app", plan.selection.environment === "preview"].every(
    Boolean,
  );

const hasPreviewAppBoundary = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return (
    boundary !== undefined &&
    boundary.app.environment === "preview" &&
    boundary.gateway.environment === "preview" &&
    boundary.app.projectId === plan.selection.projectId
  );
};

const matchesAppDelivery = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return (
    plan.delivery !== undefined &&
    plan.delivery.projectId === boundary?.app.projectId &&
    plan.delivery.branch === boundary?.app.branch
  );
};

const matchesGatewayDelivery = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return (
    plan.publicGateway !== undefined &&
    plan.publicGateway.projectId === boundary?.gateway.projectId &&
    plan.publicGateway.branch === boundary?.gateway.branch
  );
};

const matchesOptionalGatewayDelivery = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return (
    plan.gatewayDelivery === undefined ||
    (plan.gatewayDelivery.projectId === boundary?.gateway.projectId &&
      plan.gatewayDelivery.branch === boundary?.gateway.branch)
  );
};

const matchesOptionalGatewayBindings = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return (
    plan.gatewayBindings === undefined ||
    (plan.gatewayBindings.sourceWorkload.environment === "preview" &&
      plan.gatewayBindings.sourceWorkload.ownerId === boundary?.teamId &&
      plan.gatewayBindings.sourceWorkload.projectId === boundary?.gateway.projectId)
  );
};

const matchesOptionalGatewayDetails = (plan: HostedOperatorPlan) =>
  matchesOptionalGatewayDelivery(plan) && matchesOptionalGatewayBindings(plan);

const isAppPreview = (plan: HostedOperatorPlan) =>
  [
    isPreviewSelection(plan),
    hasPreviewAppBoundary(plan),
    matchesAppDelivery(plan),
    matchesGatewayDelivery(plan),
    matchesOptionalGatewayDetails(plan),
  ].every(Boolean);

const sameSelection = (prior: HostedOperatorPlan, next: HostedOperatorPlan) =>
  prior.selection.sessionId === next.selection.sessionId &&
  prior.selection.appId === next.selection.appId &&
  prior.selection.projectId === next.selection.projectId;

const sameBoundaryIdentity = (
  previous: HostedOperatorPlan["deploymentBoundary"],
  candidate: HostedOperatorPlan["deploymentBoundary"],
) =>
  [
    previous?.teamId === candidate?.teamId,
    previous?.operator.projectId === candidate?.operator.projectId,
    previous?.operator.environment === candidate?.operator.environment,
  ].every(Boolean) &&
  previous?.app.projectId === candidate?.app.projectId &&
  previous?.gateway.projectId === candidate?.gateway.projectId;

const sameBoundaryPolicy = (
  previous: HostedOperatorPlan["deploymentBoundary"],
  candidate: HostedOperatorPlan["deploymentBoundary"],
) =>
  isDeepStrictEqual(previous?.authority, candidate?.authority) &&
  isDeepStrictEqual(previous?.verification, candidate?.verification);

const sameBoundaryOwnership = (
  previous: HostedOperatorPlan["deploymentBoundary"],
  candidate: HostedOperatorPlan["deploymentBoundary"],
) => sameBoundaryIdentity(previous, candidate) && sameBoundaryPolicy(previous, candidate);

const samePublicGateway = (prior: HostedOperatorPlan, next: HostedOperatorPlan) =>
  prior.publicGateway?.projectId === next.publicGateway?.projectId &&
  prior.publicGateway?.origin === next.publicGateway?.origin;

/** Compare authorization/resource ownership, allowing ordinary source and product changes. */
const sameOwnership = (prior: HostedOperatorPlan, next: HostedOperatorPlan) => {
  const previous = prior.deploymentBoundary;
  const candidate = next.deploymentBoundary;
  return [
    isAppPreview(prior),
    isAppPreview(next),
    sameSelection(prior, next),
    isDeepStrictEqual(resourceIdentity(prior), resourceIdentity(next)),
    sameBoundaryOwnership(previous, candidate),
    samePublicGateway(prior, next),
  ].every(Boolean);
};

const matchesRequest = (record: HostedRuntimeJournalRecord, plan: HostedOperatorPlan) => {
  const { request } = record;
  const selectionMatches =
    request.sessionId === plan.selection.sessionId &&
    request.appId === plan.selection.appId &&
    request.projectId === plan.selection.projectId;
  return (
    request.environment === "preview" &&
    request.scopeType === "team" &&
    selectionMatches &&
    request.scopeId === plan.deploymentBoundary?.teamId
  );
};

const ownedReadyCandidate = (
  candidates: readonly OperatorDeploymentCandidate[] | undefined,
  deploymentId: string,
  operator: HostedOperatorRecordBase,
  delivery: HostedOperatorPlan["delivery"],
) => {
  const matches = candidates?.filter((candidate) => candidate.deploymentId === deploymentId);
  const candidate = matches?.length === 1 ? matches[0] : null;
  const isOwnedReadyDelivery =
    candidate !== null &&
    delivery !== undefined &&
    [
      candidate.readyState === "READY",
      candidate.operationRef === operator.operationRef,
      candidate.projectId === delivery.projectId,
      candidate.branch === delivery.branch,
      candidate.repoId === delivery.repoId,
    ].every(Boolean);
  return isOwnedReadyDelivery ? candidate : undefined;
};

const hasCurrentRecord = (
  record: HostedRuntimeJournalRecord | undefined,
  current: HostedOperatorRecordBase | undefined,
): record is HostedRuntimeJournalRecord & { operator: HostedOperatorRecordBase } =>
  record !== undefined && current !== undefined;

const isMatchingOrigin = (
  operator: HostedOperatorRecordBase,
  named: ReadyDeliveryReplacementIntent["predecessor"],
  current: HostedOperatorRecordBase,
) =>
  operator.operationRef === named.operationRef &&
  operator.planDigest === named.planDigest &&
  sameOwnership(operator.plan, current.plan);

const hasRequiredCandidates = (
  appCandidate: OperatorDeploymentCandidate | undefined,
  gatewayCandidate: OperatorDeploymentCandidate | undefined,
  gatewayDeploymentId: string | undefined,
) =>
  appCandidate !== undefined &&
  (gatewayDeploymentId === undefined || gatewayCandidate !== undefined);

const makePredecessorSnapshot = (
  record: HostedRuntimeJournalRecord,
  origin: { approvedByCallId: string; operator: HostedOperatorRecordBase },
  appCandidate: OperatorDeploymentCandidate,
  gatewayCandidate: OperatorDeploymentCandidate | undefined,
): ReadyDeliveryReplacementPredecessor => {
  const result: ReadyDeliveryReplacementPredecessor = {
    appCandidate,
    approvedByCallId: origin.approvedByCallId,
    originatingOperator: origin.operator,
    snapshot: record,
  };
  if (gatewayCandidate !== undefined) {
    result.gatewayCandidate = gatewayCandidate;
  }
  return structuredClone(result);
};

/** Resolve only current or approved renewal ancestry, retaining the whole protected journal. */
export const resolveReadyDeliveryReplacementPredecessor = (
  record: HostedRuntimeJournalRecord | undefined,
  intent: ReadyDeliveryReplacementIntent,
): ReadyDeliveryReplacementPredecessor | undefined => {
  const parsedIntent = readyDeliveryReplacementIntentSchema.safeParse(intent);
  const current = record?.operator;
  if (!hasCurrentRecord(record, current) || !parsedIntent.success) {
    return undefined;
  }
  if (!hasApproval(current, record.approvedByCallId) || !matchesRequest(record, current.plan)) {
    return undefined;
  }
  const named = parsedIntent.data.predecessor;
  const retained = (current.retainedRenewalOperations ?? []).filter((entry) =>
    hasApproval(entry.operator, entry.approvedByCallId),
  );
  const ancestry = retentionRenewalDeliveryProvenance({
    ...record,
    operator: { ...current, retainedRenewalOperations: retained },
  });
  const origins = [
    { approvedByCallId: record.approvedByCallId, operator: current },
    ...retained.filter((entry) =>
      ancestry.some(
        (value) =>
          value.operationRef === entry.operator.operationRef &&
          value.planDigest === entry.operator.planDigest &&
          value.approvalId === entry.operator.approvalId &&
          value.approvedByCallId === entry.approvedByCallId,
      ),
    ),
  ];
  let resolved: ReadyDeliveryReplacementPredecessor | undefined;
  for (const origin of origins) {
    const { operator } = origin;
    if (isMatchingOrigin(operator, named, current)) {
      const appCandidate = ownedReadyCandidate(
        operator.deliveryCandidates,
        named.appDeploymentId,
        operator,
        operator.plan.delivery,
      );
      const gatewayCandidate =
        named.gatewayDeploymentId === undefined
          ? undefined
          : ownedReadyCandidate(
              operator.gatewayDeliveryCandidates,
              named.gatewayDeploymentId,
              operator,
              operator.plan.gatewayDelivery,
            );
      if (hasRequiredCandidates(appCandidate, gatewayCandidate, named.gatewayDeploymentId)) {
        resolved = makePredecessorSnapshot(record, origin, appCandidate, gatewayCandidate);
        break;
      }
    }
  }
  return resolved;
};

const hasUncertainCreation = (operator: HostedOperatorRecordBase) => {
  const pending = operator.plan.effects.find((effect) => effect.id === operator.pendingEffectId);
  if (
    (pending?.kind === "delivery" || pending?.kind === "gateway-delivery") &&
    !operator.receipts.some((receipt) => receipt.effectId === pending.id)
  ) {
    return true;
  }
  if (operator.pendingEffectId === undefined && operator.pendingEffectAttempt !== undefined) {
    return true;
  }
  return (operator.gatewayDeliveryCandidates ?? []).some(
    (candidate) =>
      candidate.operationRef === operator.operationRef &&
      candidate.gatewayAliasAttempted === true &&
      (candidate.deploymentId !== operator.deliveredGatewayDeploymentId ||
        !operator.plan.effects.some(
          (effect) =>
            effect.kind === "gateway-delivery" &&
            operator.receipts.some((receipt) => receipt.effectId === effect.id),
        )),
  );
};

/** Structural evidence only. Service integration must recheck both approvals, live ownership,
 * native readback and mutation fences before atomically archiving the snapshot. This does not
 * digest or approve the successor, mutate predecessor records, or resolve unknown writes. */
export const isReadyDeliveryReplacementSuccessor = (
  record: HostedRuntimeJournalRecord | undefined,
  candidatePlan: HostedOperatorPlan & { appDeliveryReplacement: ReadyDeliveryReplacementIntent },
  now: number,
): boolean => {
  const current = record?.operator;
  if (record === undefined || current === undefined) {
    return false;
  }
  const predecessor = resolveReadyDeliveryReplacementPredecessor(
    record,
    candidatePlan.appDeliveryReplacement,
  );
  const expiry = Date.parse(candidatePlan.retention.expiresAt);
  const leaseExpiry = Date.parse(record.leaseExpiresAt ?? "");
  return [
    predecessor !== undefined,
    Number.isFinite(now),
    Number.isFinite(expiry) && expiry > now,
    record.privateState !== undefined,
    record.status !== "cleaning" && record.status !== "cleaned",
    record.leaseId === undefined || (Number.isFinite(leaseExpiry) && leaseExpiry <= now),
    sameOwnership(current.plan, candidatePlan),
    !hasUncertainCreation(current),
  ].every(Boolean);
};
