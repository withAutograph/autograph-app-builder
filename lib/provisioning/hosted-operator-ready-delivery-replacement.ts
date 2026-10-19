import { isDeepStrictEqual } from "node:util";
import type {
  HostedOperatorPlan,
  HostedOperatorRecordBase,
  OperatorDeploymentCandidate,
} from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  readyDeliveryReplacementIntentSchema,
  type ReadyDeliveryReplacementIntent,
} from "./hosted-operator-ready-delivery-replacement-intent";
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

const hasApproval = (operator: HostedOperatorRecordBase, approvedByCallId: string) =>
  approvedByCallId.length > 0 &&
  approvedByCallId !== "operator:unapproved-plan" &&
  operator.approvalId !== undefined &&
  operator.approvalId.length > 0 &&
  hostedOperatorPlanSchema.safeParse(operator.plan).success &&
  operator.planDigest === operatorPlanDigest(operator.plan);

const resourceIdentity = (plan: HostedOperatorPlan) => ({
  appDatabase: plan.appDatabase,
  authDatabase: plan.authDatabase,
  contextId: plan.contextId,
  neon: plan.neon,
});

const isAppPreview = (plan: HostedOperatorPlan) => {
  const boundary = plan.deploymentBoundary;
  return [
    plan.action === "prepare",
    plan.stage === "app",
    plan.selection.environment === "preview",
    boundary !== undefined,
    boundary?.app.environment === "preview",
    boundary?.gateway.environment === "preview",
    boundary?.app.projectId === plan.selection.projectId,
    plan.delivery !== undefined,
    plan.delivery?.projectId === boundary?.app.projectId,
    plan.delivery?.branch === boundary?.app.branch,
    plan.publicGateway !== undefined,
    plan.publicGateway?.projectId === boundary?.gateway.projectId,
    plan.publicGateway?.branch === boundary?.gateway.branch,
    plan.gatewayDelivery === undefined ||
      (plan.gatewayDelivery.projectId === boundary?.gateway.projectId &&
        plan.gatewayDelivery.branch === boundary?.gateway.branch),
    plan.gatewayBindings === undefined ||
      (plan.gatewayBindings.sourceWorkload.environment === "preview" &&
        plan.gatewayBindings.sourceWorkload.ownerId === boundary?.teamId &&
        plan.gatewayBindings.sourceWorkload.projectId === boundary?.gateway.projectId),
  ].every(Boolean);
};

/** Compare authorization/resource ownership, allowing ordinary source and product changes. */
const sameOwnership = (prior: HostedOperatorPlan, next: HostedOperatorPlan) => {
  const previous = prior.deploymentBoundary;
  const candidate = next.deploymentBoundary;
  return [
    isAppPreview(prior),
    isAppPreview(next),
    prior.selection.sessionId === next.selection.sessionId,
    prior.selection.appId === next.selection.appId,
    prior.selection.projectId === next.selection.projectId,
    isDeepStrictEqual(resourceIdentity(prior), resourceIdentity(next)),
    isDeepStrictEqual(previous?.authority, candidate?.authority),
    previous?.teamId === candidate?.teamId,
    previous?.operator.projectId === candidate?.operator.projectId,
    previous?.operator.environment === candidate?.operator.environment,
    previous?.app.projectId === candidate?.app.projectId,
    previous?.gateway.projectId === candidate?.gateway.projectId,
    prior.publicGateway?.projectId === next.publicGateway?.projectId,
    prior.publicGateway?.origin === next.publicGateway?.origin,
    isDeepStrictEqual(previous?.verification, candidate?.verification),
  ].every(Boolean);
};

const matchesRequest = (record: HostedRuntimeJournalRecord, plan: HostedOperatorPlan) =>
  record.request.environment === "preview" &&
  record.request.sessionId === plan.selection.sessionId &&
  record.request.appId === plan.selection.appId &&
  record.request.projectId === plan.selection.projectId &&
  record.request.scopeType === "team" &&
  record.request.scopeId === plan.deploymentBoundary?.teamId;

const ownedReadyCandidate = (
  candidates: readonly OperatorDeploymentCandidate[] | undefined,
  deploymentId: string,
  operator: HostedOperatorRecordBase,
  delivery: HostedOperatorPlan["delivery"],
) => {
  const matches = candidates?.filter((candidate) => candidate.deploymentId === deploymentId);
  const candidate = matches?.length === 1 ? matches[0] : undefined;
  return candidate !== undefined &&
    delivery !== undefined &&
    candidate.readyState === "READY" &&
    candidate.operationRef === operator.operationRef &&
    candidate.projectId === delivery.projectId &&
    candidate.branch === delivery.branch &&
    candidate.repoId === delivery.repoId
    ? candidate
    : undefined;
};

/** Resolve only current or approved renewal ancestry, retaining the whole protected journal. */
export const resolveReadyDeliveryReplacementPredecessor = (
  record: HostedRuntimeJournalRecord | undefined,
  intent: ReadyDeliveryReplacementIntent,
): ReadyDeliveryReplacementPredecessor | undefined => {
  const parsedIntent = readyDeliveryReplacementIntentSchema.safeParse(intent);
  const current = record?.operator;
  if (
    record === undefined ||
    current === undefined ||
    !parsedIntent.success ||
    !hasApproval(current, record.approvedByCallId) ||
    !matchesRequest(record, current.plan)
  ) {
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
  for (const origin of origins) {
    const operator = origin.operator;
    if (
      operator.operationRef !== named.operationRef ||
      operator.planDigest !== named.planDigest ||
      !sameOwnership(operator.plan, current.plan)
    ) {
      continue;
    }
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
    if (
      appCandidate === undefined ||
      (named.gatewayDeploymentId !== undefined && gatewayCandidate === undefined)
    ) {
      continue;
    }
    return structuredClone({
      snapshot: record,
      originatingOperator: operator,
      approvedByCallId: origin.approvedByCallId,
      appCandidate,
      ...(gatewayCandidate === undefined ? {} : { gatewayCandidate }),
    });
  }
  return undefined;
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
