import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorDeploymentCandidate } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

type RetainedGatewayOperation = NonNullable<
  NonNullable<HostedRuntimeJournalRecord["operator"]>["retainedGatewayDeliveries"]
>[number];

export type AppGatewayDeliverySource = NonNullable<HostedOperatorPlan["gatewayDelivery"]>;

type Operator = NonNullable<HostedRuntimeJournalRecord["operator"]>;

const hasApprovedPlan = (operator: Operator, approvedByCallId: string) =>
  operator.approvalId !== undefined &&
  approvedByCallId !== "operator:unapproved-plan" &&
  operator.planDigest === operatorPlanDigest(operator.plan);

const hasUnattemptedGateway = (operator: Operator) => {
  const effect = operator.plan.effects.find((entry) => entry.kind === "gateway-delivery");
  return (
    effect !== undefined &&
    operator.pendingEffectId !== effect.id &&
    !operator.receipts.some((receipt) => receipt.effectId === effect.id) &&
    operator.gatewayDeliveryCandidates?.some(
      (candidate) => candidate.operationRef === operator.operationRef,
    ) !== true
  );
};

const isOwnedReadyCandidate = (
  operator: Operator,
  candidate: OperatorDeploymentCandidate | undefined,
  delivery: HostedOperatorPlan["delivery"],
) =>
  [
    candidate?.readyState === "READY",
    candidate?.operationRef === operator.operationRef,
    candidate?.projectId === delivery?.projectId,
    candidate?.repoId === delivery?.repoId,
    candidate?.branch === delivery?.branch,
  ].every(Boolean);

const hasUncertainGatewayCandidate = (operator: Operator) =>
  operator.gatewayDeliveryCandidates?.some((candidate) => {
    const pending = ["BUILDING", "QUEUED", "INITIALIZING"].includes(candidate.readyState);
    const uncertainAlias =
      candidate.gatewayAliasAttempted === true &&
      candidate.deploymentId !== operator.deliveredGatewayDeploymentId;
    return candidate.operationRef === operator.operationRef && (pending || uncertainAlias);
  }) === true;

/** Completed delivery remains evidence; an uncertain create or alias is never replaced. */
const hasCompletedGateway = (operator: Operator) => {
  const app = operator.deliveryCandidates?.find(
    (candidate) => candidate.deploymentId === operator.deliveredDeploymentId,
  );
  const gateway = operator.gatewayDeliveryCandidates?.find(
    (candidate) => candidate.deploymentId === operator.deliveredGatewayDeploymentId,
  );
  return [
    operator.pendingEffectId === undefined,
    operator.pendingEffectAttempt === undefined,
    operator.plan.effects.every(
      (effect) =>
        operator.receipts.filter((receipt) => receipt.effectId === effect.id).length === 1,
    ),
    isOwnedReadyCandidate(operator, app, operator.plan.delivery),
    isOwnedReadyCandidate(operator, gateway, operator.plan.gatewayDelivery),
    !hasUncertainGatewayCandidate(operator),
  ].every(Boolean);
};

/** Pure comparison of approved source ancestry; no historical journal status is invented. */
const sourceOnlyPlan = (
  prior: Operator,
  source: AppGatewayDeliverySource,
): HostedOperatorPlan | undefined => {
  const delivery = prior.plan.gatewayDelivery;
  if (delivery === undefined) {
    return undefined;
  }
  if (
    [
      prior.plan.action !== "prepare",
      prior.plan.stage !== "app",
      delivery.gitSha === source.gitSha,
      delivery.branch !== source.branch,
      delivery.projectId !== source.projectId,
      delivery.repoId !== source.repoId,
    ].some(Boolean)
  ) {
    return undefined;
  }
  const candidate = hostedOperatorPlanSchema.safeParse({
    ...prior.plan,
    gatewayDelivery: { ...delivery, gitSha: source.gitSha },
  });
  return candidate.success ? candidate.data : undefined;
};

/** Only an unattempted or completely settled APP Gateway can propose a source change. */
const proposedSourcePlan = (
  record: HostedRuntimeJournalRecord | undefined,
  source: AppGatewayDeliverySource,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
  if (
    record === undefined ||
    prior === undefined ||
    record.privateState === undefined ||
    !hasApprovedPlan(prior, record.approvedByCallId)
  ) {
    return undefined;
  }
  const unattempted =
    record.status === "pending" && record.step === "reserved" && hasUnattemptedGateway(prior);
  const completed =
    record.status === "prepared" && record.step === "bound" && hasCompletedGateway(prior);
  const eligible = unattempted || completed;
  return eligible ? sourceOnlyPlan(prior, source) : undefined;
};
const idle = (record: HostedRuntimeJournalRecord, now: number) =>
  record.leaseId === undefined ||
  (record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= now);

/** Called inside the live original execution only after its pending receipt has settled. */
export const hasAppGatewaySourceUpdate = (
  record: HostedRuntimeJournalRecord,
  source: AppGatewayDeliverySource,
): boolean => proposedSourcePlan(record, source) !== undefined;

/** Only a settled boundary can change its approved plan; pending worker context is never moved. */
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
    record.privateState === undefined ||
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
    if (
      !hasApprovedPlan(entry.operator, entry.approvedByCallId) ||
      (!hasUnattemptedGateway(entry.operator) && !hasCompletedGateway(entry.operator))
    ) {
      return false;
    }
    const proposed = sourceOnlyPlan(entry.operator, source);
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
