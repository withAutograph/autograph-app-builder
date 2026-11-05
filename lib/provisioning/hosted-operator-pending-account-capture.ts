import { operatorPlanDigest } from "./hosted-operator-contract";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

/** Only the exact approved, interrupted account effect may reconnect while no worker owns the journal. */
export const isIdlePendingAccountCapture = (record: HostedRuntimeJournalRecord): boolean => {
  const { operator, accountPreparation: preparation } = record;
  if (
    operator === undefined ||
    preparation === undefined ||
    operator.plan.normalActorProgram === undefined
  ) {
    return false;
  }
  return [
    record.leaseId === undefined,
    record.leaseExpiresAt === undefined,
    operator.plan.stage === "auth-participants",
    operator.pendingEffectAttempt !== undefined,
    operator.plan.effects.some(
      (effect) => effect.id === operator.pendingEffectId && effect.kind === "normal-accounts",
    ),
    operator.operationRef === preparation.accountOperationRef,
    operator.planDigest === preparation.accountPlanDigest,
    operatorPlanDigest(operator.plan) === preparation.accountPlanDigest,
    operatorPlanDigest(preparation.accountPlan) === preparation.accountPlanDigest,
    normalActorProgramDigest(operator.plan.normalActorProgram) === preparation.programDigest,
    normalActorProgramDigest(preparation.program) === preparation.programDigest,
    operator.approvalId === preparation.accountApprovalId,
    record.approvedByCallId === preparation.accountApprovedByCallId,
  ].every(Boolean);
};

/** Recheck the exact operator inside the identity-link reservation CAS. */
export const canReserveIdentityLink = (
  record: HostedRuntimeJournalRecord,
  expected: { operationRef: string; planDigest: string; participantCapture: boolean },
): boolean =>
  [
    record.operator?.planDigest === expected.planDigest,
    record.operator?.operationRef === expected.operationRef,
    record.leaseId === undefined,
    (record.operator?.pendingEffectId === undefined &&
      record.operator?.pendingEffectAttempt === undefined) ||
      (expected.participantCapture && isIdlePendingAccountCapture(record)),
  ].every(Boolean);
