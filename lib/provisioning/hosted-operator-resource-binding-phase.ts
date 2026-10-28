import { isDeepStrictEqual } from "node:util";
import {
  HostedOperatorError,
  operatorPlanDigest,
  retainedOperatorAuthSchema,
} from "./hosted-operator-contract";
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

/** Select only the original retained prepare evidence for a read-only binding request.
 * Approval, owner, completion, sealed checkpoint and second-read checks remain with the caller.
 */
export const selectAuthPlanningResourceBindingRow = (
  row: HostedRuntimeJournalRow | undefined,
  plan: HostedOperatorPlan,
): HostedRuntimeJournalRow | undefined => {
  if (row === undefined || row.record.operator?.planDigest === operatorPlanDigest(plan)) {
    return row;
  }
  const parsed = retainedOperatorAuthSchema.safeParse(row.record.retainedAuth);
  if (!parsed.success) {
    return row;
  }
  const retained = parsed.data;
  if (retained.planDigest !== operatorPlanDigest(plan)) {
    return row;
  }
  const current = row.record.operator;
  // An idle app delivery cannot mutate the completed retained Auth credentials.
  // Keep unknown Auth/resource effects and cleanup behind the existing phase guard.
  const pendingAppDelivery =
    current?.plan.action === "prepare" &&
    current.plan.stage === "app" &&
    current.plan.effects.some(
      (effect) => effect.kind === "delivery" && effect.id === current.pendingEffectId,
    );
  const pendingMutation =
    !pendingAppDelivery &&
    (current?.pendingEffectId !== undefined || current?.pendingEffectAttempt !== undefined);
  if (
    row.record.leaseId !== undefined ||
    row.record.leaseExpiresAt !== undefined ||
    pendingMutation
  ) {
    throw new HostedOperatorError("operation_in_progress");
  }
  return {
    ...row,
    record: {
      ...row.record,
      approvedByCallId: retained.approvedByCallId,
      operator: {
        approvalId: retained.approvalId,
        authPreparation: retained.authPreparation,
        fenceGeneration: retained.fenceGeneration,
        gatewayEnvironment: retained.gatewayEnvironment,
        mode: "protected-operator-v1",
        operationRef: retained.operationRef,
        plan: retained.plan,
        planDigest: retained.planDigest,
        receipts: retained.receipts,
      },
      status: "prepared",
      step: "bound",
    },
  };
};
