import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import type { OperatorPublicResult } from "./hosted-operator-contract";

/** Expose only the current operation's closed state, never a lease capability. */
export const readOperatorExecutionObservation = (
  record: HostedRuntimeJournalRecord,
  now: number,
): NonNullable<OperatorPublicResult["execution"]> => {
  const operator = record.operator;
  const saved = record.executionObservation;
  const matching =
    // oxlint-disable-next-line sonarjs/expression-complexity -- Match all original approval identity dimensions before exposing private settlement.
    operator !== undefined &&
    saved !== undefined &&
    saved.operationRef === operator.operationRef &&
    saved.planDigest === operator.planDigest &&
    saved.callId === record.approvedByCallId &&
    saved.approvalId === operator.approvalId;
  if (
    matching &&
    saved.state === "settled" &&
    (record.leaseId === undefined || record.leaseId === saved.attemptRef)
  ) {
    return { state: "settled", outcome: saved.outcome };
  }
  if (
    record.leaseId !== undefined &&
    record.leaseExpiresAt !== undefined &&
    Date.parse(record.leaseExpiresAt) > now
  ) {
    return { state: "running" };
  }
  // Legacy terminal records are authoritative without a new acknowledgement field.
  if (
    record.status === "prepared" ||
    record.status === "cleaned" ||
    record.status === "participants-prepared"
  ) {
    return { state: "settled", outcome: { status: record.status } };
  }
  return { state: "unknown" };
};

/** The caller must hold the matching live operation lease and physical resource fence. */
export const settleOperatorExecution = (
  record: HostedRuntimeJournalRecord,
  attemptRef: string,
  outcome: NonNullable<
    Extract<NonNullable<OperatorPublicResult["execution"]>, { state: "settled" }>["outcome"]
  >,
): HostedRuntimeJournalRecord => {
  const saved = record.executionObservation;
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Every lease and approval dimension must match before settlement.
    record.leaseId !== attemptRef ||
    saved?.state !== "running" ||
    saved.attemptRef !== attemptRef ||
    record.operator?.operationRef !== saved.operationRef ||
    record.operator.planDigest !== saved.planDigest ||
    record.approvedByCallId !== saved.callId ||
    record.operator.approvalId !== saved.approvalId
  ) {
    return record;
  }
  return { ...record, executionObservation: { ...saved, state: "settled", outcome } };
};
