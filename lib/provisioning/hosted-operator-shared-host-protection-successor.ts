import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorPlanExceptExpiry,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { matchesExternalTrustedSources } from "./hosted-operator-host-protection";
import type { ExternallyManagedTrustedSources } from "./hosted-operator-host-protection";
import { withExternallyManagedHostProtection } from "./hosted-operator-native-preview-recovery";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const AUTH_BOOTSTRAP = "auth-bootstrap";
const GATEWAY_BINDINGS = "gateway-bindings";
const GATEWAY_DELIVERY = "gateway-delivery";
const UNAPPROVED = "operator:unapproved-plan";
type OperatorRecord = NonNullable<HostedRuntimeJournalRecord["operator"]>;

const sameAppNarrowedPlan = (prior: HostedOperatorPlan, next: HostedOperatorPlan): boolean => {
  const policy = next.hostProtection;
  const boundary = prior.deploymentBoundary;
  if (
    prior.stage !== "app" ||
    next.stage !== "app" ||
    prior.action !== "prepare" ||
    policy === undefined ||
    boundary === undefined ||
    prior.publicGateway === undefined ||
    prior.gatewayBindings === undefined ||
    (prior.appTrustedSources === undefined && prior.gatewayBindings.trustedSources === undefined) ||
    !matchesExternalTrustedSources(
      policy,
      boundary.teamId,
      prior.selection.projectId,
      prior.publicGateway.projectId,
    )
  ) {
    return false;
  }
  return sameOperatorPlanExceptExpiry(withExternallyManagedHostProtection(prior, policy), next);
};

const sameNarrowedPlan = (prior: HostedOperatorPlan, next: HostedOperatorPlan): boolean => {
  if (prior.stage === "app") {
    return sameAppNarrowedPlan(prior, next);
  }
  const binding = prior.effects.find((effect) => effect.kind === GATEWAY_BINDINGS);
  if (
    prior.stage !== AUTH_BOOTSTRAP ||
    next.stage !== AUTH_BOOTSTRAP ||
    binding === undefined ||
    prior.gatewayBindings?.trustedSources === undefined ||
    next.gatewayBindings === undefined
  ) {
    return false;
  }
  if (
    next.gatewayBindings.trustedSources !== undefined ||
    prior.gatewayDelivery === undefined ||
    next.gatewayDelivery === undefined
  ) {
    return false;
  }
  return sameOperatorPlanExceptExpiry(prior, {
    ...next,
    gatewayBindings: {
      ...next.gatewayBindings,
      trustedSources: prior.gatewayBindings.trustedSources,
    },
    effects: next.effects.map((effect) =>
      effect.id === binding.id ? { ...effect, description: binding.description } : effect,
    ),
  });
};

const prerequisitesObserved = (prior: OperatorRecord, bindingId: string): boolean =>
  prior.plan.effects.every(
    (effect) =>
      effect.id === bindingId ||
      effect.kind === GATEWAY_DELIVERY ||
      prior.receipts.some((receipt) => receipt.effectId === effect.id),
  );

const isPendingAppBindingNarrowing = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
  const prior = record.operator;
  if (prior === undefined || !sameAppNarrowedPlan(prior.plan, plan)) {
    return false;
  }
  const bindingIndex = prior.plan.effects.findIndex((effect) => effect.kind === "bindings");
  const binding = prior.plan.effects[bindingIndex];
  if (binding === undefined) {
    return false;
  }
  return [
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    prior.approvalId !== undefined,
    record.approvedByCallId !== UNAPPROVED,
    prior.planDigest === operatorPlanDigest(prior.plan),
    record.leaseId === undefined ||
      (record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= now),
    prior.pendingEffectId === binding.id,
    prior.plan.effects.every((effect, index) => {
      const observed = prior.receipts.some((receipt) => receipt.effectId === effect.id);
      return index < bindingIndex ? observed : !observed;
    }),
    prior.deliveredDeploymentId === undefined,
    prior.deliveryCandidates?.some((candidate) => candidate.readyState === "READY") !== true,
  ].every(Boolean);
};

/** Exact authority narrowing retains the delivery intent and every unresolved attempt. */
export const isSharedHostProtectionSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
  if (record.operator?.plan.stage === "app") {
    return isPendingAppBindingNarrowing(record, plan, now);
  }
  const prior = record.operator;
  const binding = prior?.plan.effects.find((effect) => effect.kind === GATEWAY_BINDINGS);
  if (prior === undefined || binding === undefined || !sameNarrowedPlan(prior.plan, plan)) {
    return false;
  }
  return [
    record.status === "pending",
    record.step === "reserved",
    record.privateState !== undefined,
    prior.plan.stage === AUTH_BOOTSTRAP,
    prior.approvalId !== undefined,
    record.approvedByCallId !== UNAPPROVED,
    record.leaseId === undefined ||
      (record.leaseExpiresAt !== undefined && Date.parse(record.leaseExpiresAt) <= now),
    prior.pendingEffectId === binding.id,
    prerequisitesObserved(prior, binding.id),
  ].every(Boolean);
};

/** Resolve only the outstanding, already-owned bootstrap prerequisite before fresh app planning. */
export const createSharedHostProtectionSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  now: number,
  policy?: ExternallyManagedTrustedSources,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
  if (record !== undefined && prior?.plan.stage === "app") {
    if (policy === undefined) {
      return undefined;
    }
    const candidate = withExternallyManagedHostProtection(
      {
        ...prior.plan,
        retention: {
          ...prior.plan.retention,
          expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
        },
      },
      policy,
    );
    return isSharedHostProtectionSuccessor(record, candidate, now) ? candidate : undefined;
  }
  if (record === undefined || prior?.plan.gatewayBindings?.trustedSources === undefined) {
    return undefined;
  }
  const gatewayBindings = { ...prior.plan.gatewayBindings };
  delete gatewayBindings.trustedSources;
  const candidate = hostedOperatorPlanSchema.parse({
    ...prior.plan,
    gatewayBindings,
    retention: {
      ...prior.plan.retention,
      expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
    },
  });
  return isSharedHostProtectionSuccessor(record, candidate, now) ? candidate : undefined;
};

/** A consumed owner proof keeps its original approved digest through this exact authority narrowing. */
export const hasRetainedSharedHostProtectionIdentity = (
  record: HostedRuntimeJournalRecord,
): boolean => {
  const current = record.operator;
  const link = current?.identityLink;
  if (current === undefined || link === undefined) {
    return false;
  }
  if (current.approvalId === undefined || current.planDigest !== operatorPlanDigest(current.plan)) {
    return false;
  }
  if (
    link.consumedAt === undefined ||
    link.proofRef === undefined ||
    link.proofSha256 === undefined
  ) {
    return false;
  }
  return (current.retainedGatewayDeliveries ?? []).some((retained) => {
    const original = retained.operator;
    if (!sameNarrowedPlan(original.plan, current.plan)) {
      return false;
    }
    return [
      original.operationRef === current.operationRef,
      original.plan.stage === AUTH_BOOTSTRAP,
      original.planDigest === link.bootstrapPlanDigest,
      original.planDigest === operatorPlanDigest(original.plan),
      original.approvalId !== undefined,
      retained.approvedByCallId !== UNAPPROVED,
      JSON.stringify(original.identityLink) === JSON.stringify(link),
    ].every(Boolean);
  });
};

/** Private approved ancestry used only to observe the unchanged Gateway delivery intent. */
export interface SharedHostProtectionDeliveryProvenance {
  operationRef: string;
  plan: HostedOperatorPlan;
  planDigest: string;
  approvalId: string;
  approvedByCallId: string;
}

export const isSharedHostProtectionDeliveryProvenance = (
  provenance: SharedHostProtectionDeliveryProvenance,
  currentPlan: HostedOperatorPlan,
  operationRef: string,
): boolean => {
  if (
    provenance.operationRef !== operationRef ||
    ![AUTH_BOOTSTRAP, "app"].includes(provenance.plan.stage ?? "") ||
    provenance.planDigest !== operatorPlanDigest(provenance.plan)
  ) {
    return false;
  }
  if (
    provenance.approvalId.length === 0 ||
    provenance.approvedByCallId.length === 0 ||
    provenance.approvedByCallId === UNAPPROVED
  ) {
    return false;
  }
  return sameNarrowedPlan(provenance.plan, currentPlan);
};

export const sharedHostProtectionDeliveryProvenance = (
  record: HostedRuntimeJournalRecord,
): readonly SharedHostProtectionDeliveryProvenance[] => {
  const current = record.operator;
  if (
    current === undefined ||
    current.approvalId === undefined ||
    record.approvedByCallId === UNAPPROVED
  ) {
    return [];
  }
  if (current.planDigest !== operatorPlanDigest(current.plan)) {
    return [];
  }
  return (current.retainedGatewayDeliveries ?? []).flatMap((retained) => {
    const original = retained.operator;
    if (original.approvalId === undefined) {
      return [];
    }
    const provenance = {
      operationRef: original.operationRef,
      plan: original.plan,
      planDigest: original.planDigest,
      approvalId: original.approvalId,
      approvedByCallId: retained.approvedByCallId,
    };
    return isSharedHostProtectionDeliveryProvenance(provenance, current.plan, current.operationRef)
      ? [provenance]
      : [];
  });
};
