import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorPlan, HostedOperatorRecordBase } from "./hosted-operator-contract";
import type { ExternallyManagedTrustedSources } from "./hosted-operator-host-protection";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import {
  isReadyDeliveryReplacementSuccessor,
  resolveReadyDeliveryReplacementPredecessor,
} from "./hosted-operator-ready-delivery-replacement";
import { readyDeliveryReplacementIntentSchema } from "./hosted-operator-ready-delivery-replacement-intent";
import type { ReadyDeliveryReplacementIntent } from "./hosted-operator-ready-delivery-replacement-intent";

const appDeliveryReplacementOf = (
  plan: HostedOperatorPlan,
): ReadyDeliveryReplacementIntent | undefined =>
  "appDeliveryReplacement" in plan
    ? (() => {
        const parsed = readyDeliveryReplacementIntentSchema.safeParse(plan.appDeliveryReplacement);
        return parsed.success ? parsed.data : undefined;
      })()
    : undefined;

export const withExternallyManagedHostProtection = (
  plan: HostedOperatorPlan,
  policy: ExternallyManagedTrustedSources | undefined,
): HostedOperatorPlan => {
  if (policy === undefined || plan.stage !== "app" || plan.action !== "prepare") {
    return plan;
  }
  const { appTrustedSources, gatewayBindings, ...base } = plan;
  void appTrustedSources;
  if (!gatewayBindings) {
    throw new Error("External host configuration requires the owned Gateway bindings.");
  }
  const { trustedSources, ...gateway } = gatewayBindings;
  void trustedSources;
  return hostedOperatorPlanSchema.parse({
    ...base,
    effects: plan.effects.map((effect) =>
      effect.kind === "bindings" || effect.kind === "gateway-bindings"
        ? {
            ...effect,
            description:
              "Bind and read back only owned Preview environment rows; consume the explicitly configured administrator-managed Trusted Sources policy without setting or claiming fresh policy proof.",
          }
        : effect,
    ),
    gatewayBindings: gateway,
    hostProtection: policy,
  });
};

/** Recovery owns a pending legacy READY transition or its saved proposal/attempt, never ordinary revisions. */
export const hasPendingNativePreviewRecovery = (record: HostedRuntimeJournalRecord | undefined) => {
  const current = record?.operator;
  if (record === undefined || current === undefined) {
    return false;
  }
  const statusCanRecover = ["pending", "failed"].includes(record.status);
  if (!statusCanRecover || current.plan.stage !== "app" || current.plan.action !== "prepare") {
    return false;
  }
  if (current.plan.appDeliveryReplacement !== undefined) {
    return true;
  }
  if (
    record.approvedByCallId === "operator:unapproved-plan" ||
    current.plan.hostProtection !== undefined
  ) {
    return false;
  }
  return [
    current,
    ...(current.retainedRenewalOperations ?? []).map((entry) => entry.operator),
  ].some(
    (operator) =>
      operator.deliveryCandidates?.some((candidate) => candidate.readyState === "READY") === true,
  );
};

const readyCandidates = <T extends { readyState: string }>(values: T[] | undefined) =>
  (values ?? []).filter((value) => value.readyState === "READY");

const selectAppCandidate = <T extends { deploymentId: string }>(
  candidates: T[],
  deliveredDeploymentId: string | undefined,
) => {
  const delivered = candidates.find((value) => value.deploymentId === deliveredDeploymentId);
  if (delivered !== undefined) {
    return delivered;
  }
  return candidates.length === 1 ? candidates[0] : undefined;
};

const selectGatewayCandidate = <T extends { deploymentId: string }>(
  candidates: T[],
  requestedDeploymentId: string | undefined,
  deliveredDeploymentId: string | undefined,
) => {
  const target = requestedDeploymentId ?? deliveredDeploymentId;
  const matching = candidates.find((value) => value.deploymentId === target);
  if (matching !== undefined) {
    return matching;
  }
  if (requestedDeploymentId === undefined && candidates.length === 1) {
    return candidates[0] ?? null;
  }
  return null;
};

const describeRecoveryEffect = (effect: HostedOperatorPlan["effects"][number]) => {
  if (effect.kind === "bindings" || effect.kind === "gateway-bindings") {
    return {
      ...effect,
      description:
        "Bind and read back only owned Preview environment rows; consume the explicitly configured administrator-managed Trusted Sources policy without setting or claiming fresh policy proof.",
    };
  }
  if (effect.kind === "delivery" || effect.kind === "gateway-delivery") {
    return {
      ...effect,
      description:
        "Create and verify a fresh native Preview under this new approval, replacing the named READY predecessor. This may create duplicate deployment usage charges.",
    };
  }
  return effect;
};

const createReplacementProposal = (
  record: HostedRuntimeJournalRecord,
  base: Omit<
    HostedOperatorPlan,
    "appDeliveryReplacement" | "gatewayBindings" | "hostProtection" | "retention" | "effects"
  >,
  previous: HostedOperatorPlan,
  bindings: NonNullable<HostedOperatorPlan["gatewayBindings"]>,
  policy: ExternallyManagedTrustedSources,
  intent: ReadyDeliveryReplacementIntent,
  now: number,
): HostedOperatorPlan | undefined => {
  if (resolveReadyDeliveryReplacementPredecessor(record, intent) === undefined) {
    return undefined;
  }
  const proposed = hostedOperatorPlanSchema.parse({
    ...base,
    appDeliveryReplacement: intent,
    effects: previous.effects.map(describeRecoveryEffect),
    gatewayBindings: bindings,
    hostProtection: policy,
    retention: {
      ...previous.retention,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  return isReadyDeliveryReplacementSuccessor(record, proposed, now) ? proposed : undefined;
};

/** A fresh explicit delivery proposal uses the approved source and ownership. No old receipt becomes new success. */
export const createNativePreviewRecoveryPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  policy: ExternallyManagedTrustedSources,
  now: number,
  gatewayDeploymentId?: string,
): HostedOperatorPlan | undefined => {
  const current = record?.operator;
  if (!record || !current || !hasPendingNativePreviewRecovery(record)) {
    return undefined;
  }
  const currentPlan = current.plan;
  const currentReplacement = appDeliveryReplacementOf(currentPlan);
  if (
    currentReplacement !== undefined &&
    isDeepStrictEqual(current.plan.hostProtection, policy) &&
    Date.parse(current.plan.retention.expiresAt) > now
  ) {
    return currentPlan;
  }
  const previous = current.plan;
  const { appTrustedSources, gatewayBindings, ...base } = previous;
  const appDeliveryReplacement = appDeliveryReplacementOf(previous);
  void appTrustedSources;
  void appDeliveryReplacement;
  if (
    gatewayBindings === undefined ||
    previous.delivery === undefined ||
    previous.gatewayDelivery === undefined
  ) {
    return undefined;
  }
  const { trustedSources, ...bindings } = gatewayBindings;
  void trustedSources;
  const origins = [
    { operator: current },
    ...(current.retainedRenewalOperations ?? []).toReversed(),
  ];
  for (const origin of origins) {
    const { operator } = origin;
    const app = selectAppCandidate(
      readyCandidates(operator.deliveryCandidates),
      operator.deliveredDeploymentId,
    );
    const gateway = selectGatewayCandidate(
      readyCandidates(operator.gatewayDeliveryCandidates),
      gatewayDeploymentId,
      operator.deliveredGatewayDeploymentId,
    );
    const gatewayRequired = gatewayDeploymentId !== undefined;
    if (app !== undefined && (!gatewayRequired || (gateway !== undefined && gateway !== null))) {
      const predecessor: ReadyDeliveryReplacementIntent["predecessor"] = {
        appDeploymentId: app.deploymentId,
        operationRef: operator.operationRef,
        planDigest: operator.planDigest,
      };
      if (gateway !== undefined && gateway !== null) {
        predecessor.gatewayDeploymentId = gateway.deploymentId;
      }
      const intent: ReadyDeliveryReplacementIntent = { predecessor, version: 1 };
      const proposed = createReplacementProposal(
        record,
        base,
        previous,
        bindings,
        policy,
        intent,
        now,
      );
      if (proposed !== undefined) {
        return proposed;
      }
    }
  }
  return undefined;
};

/** Read only the pending recovery proposal; ordinary planning keeps ownership of new work. */
export const readNativePreviewRecoveryPlan = async (input: {
  record: HostedRuntimeJournalRecord | undefined;
  policy: ExternallyManagedTrustedSources | undefined;
  now: number;
  readGatewayAlias: (plan: HostedOperatorPlan) => Promise<string>;
}): Promise<HostedOperatorPlan | undefined> => {
  const { record, policy, now } = input;
  if (policy === undefined || !hasPendingNativePreviewRecovery(record)) {
    return undefined;
  }
  const current = record?.operator;
  if (current === undefined) {
    return undefined;
  }
  if (appDeliveryReplacementOf(current.plan) !== undefined) {
    // Expired saved authority belongs to ordinary renewal/proposal planning, never fresh predecessor discovery.
    if (Date.parse(current.plan.retention.expiresAt) <= now) {
      return undefined;
    }
    const saved = createNativePreviewRecoveryPlan(record, policy, now);
    if (saved !== undefined) {
      return saved;
    }
  }
  const alias = await input.readGatewayAlias(current.plan);
  const proposed = createNativePreviewRecoveryPlan(record, policy, now, alias);
  if (proposed === undefined) {
    throw new HostedOperatorError("reconciliation_required");
  }
  return proposed;
};

/** Resolve the exact archived transition source; old unknown markers remain evidence only. */
export const readyReplacementHistory = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now = Date.now(),
) => {
  const appDeliveryReplacement = appDeliveryReplacementOf(plan);
  if (appDeliveryReplacement === undefined) {
    return null;
  }
  for (const archived of record.operator?.retainedReadyDeliveryOperations?.toReversed() ?? []) {
    const snapshot: HostedRuntimeJournalRecord = {
      ...record,
      approvedByCallId: archived.approvedByCallId,
      operator: archived.operator,
    };
    delete snapshot.leaseExpiresAt;
    delete snapshot.leaseId;
    const predecessor = resolveReadyDeliveryReplacementPredecessor(
      snapshot,
      appDeliveryReplacement,
    );
    if (
      predecessor !== undefined &&
      isReadyDeliveryReplacementSuccessor(snapshot, { ...plan, appDeliveryReplacement }, now)
    ) {
      return predecessor;
    }
  }
  return null;
};

export const readyReplacementPriorOperators = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now = Date.now(),
): { approvedByCallId: string; operator: HostedOperatorRecordBase }[] => {
  const predecessor = readyReplacementHistory(record, plan, now);
  if (predecessor === null || predecessor.snapshot.operator === undefined) {
    return [];
  }
  return [
    {
      approvedByCallId: predecessor.snapshot.approvedByCallId,
      operator: predecessor.snapshot.operator,
    },
    { approvedByCallId: predecessor.approvedByCallId, operator: predecessor.originatingOperator },
  ].filter(
    (value, index, all) =>
      all.findIndex(
        (item) =>
          item.operator.planDigest === value.operator.planDigest &&
          item.operator.operationRef === value.operator.operationRef,
      ) === index,
  );
};
