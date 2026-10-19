import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorPlan, HostedOperatorRecordBase } from "./hosted-operator-contract";
import type { ExternallyManagedTrustedSources } from "./hosted-operator-host-protection";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import {
  isReadyDeliveryReplacementSuccessor,
  resolveReadyDeliveryReplacementPredecessor,
} from "./hosted-operator-ready-delivery-replacement";

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
    hostProtection: policy,
    gatewayBindings: gateway,
    effects: plan.effects.map((effect) =>
      effect.kind === "bindings" || effect.kind === "gateway-bindings"
        ? {
            ...effect,
            description:
              "Bind and read back only owned Preview environment rows; consume the explicitly configured administrator-managed Trusted Sources policy without setting or claiming fresh policy proof.",
          }
        : effect,
    ),
  });
};

/** Recovery owns a pending legacy READY transition or its saved proposal/attempt, never ordinary revisions. */
export const hasPendingNativePreviewRecovery = (record: HostedRuntimeJournalRecord | undefined) => {
  const current = record?.operator;
  if (
    record === undefined ||
    current === undefined ||
    !["pending", "failed"].includes(record.status) ||
    current.plan.stage !== "app" ||
    current.plan.action !== "prepare"
  ) {
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
  if (
    current.plan.appDeliveryReplacement &&
    isDeepStrictEqual(current.plan.hostProtection, policy) &&
    Date.parse(current.plan.retention.expiresAt) > now
  ) {
    return current.plan;
  }
  const previous = current.plan;
  const { appTrustedSources, gatewayBindings, appDeliveryReplacement, ...base } = previous;
  void appTrustedSources;
  void appDeliveryReplacement;
  if (!gatewayBindings || !previous.delivery || !previous.gatewayDelivery) {
    return undefined;
  }
  const { trustedSources, ...bindings } = gatewayBindings;
  void trustedSources;
  for (const origin of [
    { operator: current },
    ...(current.retainedRenewalOperations ?? []).toReversed(),
  ]) {
    const operator = origin.operator;
    const candidates = (operator.deliveryCandidates ?? []).filter(
      (value) => value.readyState === "READY",
    );
    const app =
      candidates.find((value) => value.deploymentId === operator.deliveredDeploymentId) ??
      (candidates.length === 1 ? candidates[0] : undefined);
    if (!app) {
      continue;
    }
    const gatewayCandidates = (operator.gatewayDeliveryCandidates ?? []).filter(
      (value) => value.readyState === "READY",
    );
    const gateway =
      gatewayCandidates.find(
        (value) =>
          value.deploymentId === (gatewayDeploymentId ?? operator.deliveredGatewayDeploymentId),
      ) ??
      (gatewayDeploymentId === undefined && gatewayCandidates.length === 1
        ? gatewayCandidates[0]
        : undefined);
    if (gatewayDeploymentId !== undefined && !gateway) {
      continue;
    }
    const intent = {
      version: 1 as const,
      predecessor: {
        operationRef: operator.operationRef,
        planDigest: operator.planDigest,
        appDeploymentId: app.deploymentId,
        ...(gateway ? { gatewayDeploymentId: gateway.deploymentId } : {}),
      },
    };
    if (!resolveReadyDeliveryReplacementPredecessor(record, intent)) {
      continue;
    }
    const proposed = hostedOperatorPlanSchema.parse({
      ...base,
      hostProtection: policy,
      gatewayBindings: bindings,
      appDeliveryReplacement: intent,
      retention: {
        ...previous.retention,
        expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      },
      effects: previous.effects.map((effect) =>
        effect.kind === "bindings" || effect.kind === "gateway-bindings"
          ? {
              ...effect,
              description:
                "Bind and read back only owned Preview environment rows; consume the explicitly configured administrator-managed Trusted Sources policy without setting or claiming fresh policy proof.",
            }
          : effect.kind === "delivery" || effect.kind === "gateway-delivery"
            ? {
                ...effect,
                description:
                  "Create and verify a fresh native Preview under this new approval, replacing the named READY predecessor. This may create duplicate deployment usage charges.",
              }
            : effect,
      ),
    });
    if (
      isReadyDeliveryReplacementSuccessor(
        record,
        { ...proposed, appDeliveryReplacement: intent },
        now,
      )
    ) {
      return proposed;
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
  if (!current) {
    return undefined;
  }
  if (current.plan.appDeliveryReplacement !== undefined) {
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
  if (!plan.appDeliveryReplacement) {
    return undefined;
  }
  for (const archived of record.operator?.retainedReadyDeliveryOperations?.toReversed() ?? []) {
    const snapshot: HostedRuntimeJournalRecord = {
      ...record,
      approvedByCallId: archived.approvedByCallId,
      operator: archived.operator,
    };
    const predecessor = resolveReadyDeliveryReplacementPredecessor(
      snapshot,
      plan.appDeliveryReplacement,
    );
    if (
      predecessor &&
      isReadyDeliveryReplacementSuccessor(
        { ...snapshot, leaseId: undefined, leaseExpiresAt: undefined },
        { ...plan, appDeliveryReplacement: plan.appDeliveryReplacement },
        now,
      )
    ) {
      return predecessor;
    }
  }
  return undefined;
};

export const readyReplacementPriorOperators = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now = Date.now(),
): { approvedByCallId: string; operator: HostedOperatorRecordBase }[] => {
  const predecessor = readyReplacementHistory(record, plan, now);
  if (predecessor === undefined || predecessor.snapshot.operator === undefined) {
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
