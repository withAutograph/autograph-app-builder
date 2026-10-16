import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  sameOperatorPlanExceptExpiry,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const AUTH_BOOTSTRAP = "auth-bootstrap";
const GATEWAY_BINDINGS = "gateway-bindings";
const GATEWAY_DELIVERY = "gateway-delivery";
const UNAPPROVED = "operator:unapproved-plan";
type OperatorRecord = NonNullable<HostedRuntimeJournalRecord["operator"]>;

const sameNarrowedPlan = (prior: HostedOperatorPlan, next: HostedOperatorPlan): boolean => {
  const binding = prior.effects.find((effect) => effect.kind === GATEWAY_BINDINGS);
  if (
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

const aliasOutcomeKnown = (prior: OperatorRecord): boolean =>
  prior.gatewayDeliveryCandidates?.some((candidate) => candidate.gatewayAliasAttempted === true) !==
    true ||
  prior.plan.effects.some(
    (effect) =>
      effect.kind === GATEWAY_DELIVERY &&
      prior.receipts.some((receipt) => receipt.effectId === effect.id),
  );

/** Removing host-owned protection administration cannot discard an uncertain app/environment effect. */
export const isSharedHostProtectionSuccessor = (
  record: HostedRuntimeJournalRecord,
  plan: HostedOperatorPlan,
  now: number,
): boolean => {
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
    aliasOutcomeKnown(prior),
  ].every(Boolean);
};

/** Resolve only the outstanding, already-owned bootstrap prerequisite before fresh app planning. */
export const createSharedHostProtectionSuccessorPlan = (
  record: HostedRuntimeJournalRecord | undefined,
  now: number,
): HostedOperatorPlan | undefined => {
  const prior = record?.operator;
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
