import { isDeepStrictEqual } from "node:util";
import { HostedOperatorError, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord, HostedRuntimeJournalRow } from "./hosted-runtime-journal";

interface ResourceBindingReadInput {
  plan: HostedOperatorPlan;
  privateState?: HostedRuntimeJournalRecord["privateState"];
}

const completedIdleAuthRead = (
  record: HostedRuntimeJournalRecord,
  operator: NonNullable<HostedRuntimeJournalRecord["operator"]>,
) =>
  [
    record.step === "reserved",
    record.leaseId === undefined,
    record.leaseExpiresAt === undefined,
    operator.authPreparation !== undefined,
    operator.authPreparation?.targetDigest === operator.plan.authSchema?.targetDigest,
    operator.authPreparation?.database === operator.plan.authDatabase.database,
    operator.authPreparation?.runtimeRole === operator.plan.authDatabase.runtimeRole,
    (operator.plan.stage === "auth-bootstrap" && record.status === "pending") ||
      (operator.plan.stage === "auth-participants" && record.status === "participants-prepared"),
  ].every(Boolean);

/** Read-only phase selection. The caller also checks live owner, durable approval and journal revision around decryption. */
export const requireFinalResourceBindingPhase = (
  row: HostedRuntimeJournalRow | undefined,
  input: ResourceBindingReadInput,
) => {
  if (row === undefined || row.record.operator === undefined) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const { record } = row;
  const { operator } = row.record;
  if (
    operator.plan.action !== "prepare" ||
    input.plan.action !== "prepare" ||
    operator.approvalId === undefined
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  if (
    operator.fenceGeneration === undefined ||
    operator.pendingEffectId !== undefined ||
    operator.pendingEffectAttempt !== undefined
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  if (
    operator.planDigest !== operatorPlanDigest(input.plan) ||
    operator.planDigest !== operatorPlanDigest(operator.plan)
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const complete = operator.plan.effects.every((effect) =>
    operator.receipts.some(
      (receipt) =>
        receipt.effectId === effect.id &&
        (effect.kind !== "access" || receipt.fenceGeneration === operator.fenceGeneration),
    ),
  );
  if (
    !complete ||
    record.privateState === undefined ||
    !isDeepStrictEqual(input.privateState, record.privateState)
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  const leasedFinalVerification =
    record.status === "pending" &&
    record.leaseId !== undefined &&
    record.leaseExpiresAt !== undefined &&
    Date.parse(record.leaseExpiresAt) > Date.now();
  const preparedRead =
    record.status === "prepared" && record.step === "bound" && record.leaseId === undefined;
  const idleAuthRead = completedIdleAuthRead(record, operator);
  if (![leasedFinalVerification, preparedRead, idleAuthRead].some(Boolean)) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return row;
};
