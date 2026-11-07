/* oxlint-disable sonarjs/cognitive-complexity -- Keep cancellation, advancing history, preflight settlement and typed read failures in one sequential recovery boundary. */
import { HostedOperatorError } from "../provisioning/hosted-operator-contract";
import { HostedSessionReadTimeoutError } from "../eve/hosted-session-read-timeout-error";

/** Deferred read failures must never be mistaken for a missing native approval. */
export const isContinuityApprovalReadRetryable = (error: unknown): error is Error =>
  error instanceof Error && error.name === "RetryableError";

const deferApprovalRead = async (code: string, recoveryStage?: string): Promise<never> => {
  const { RetryableError } = await import("workflow");
  const stage = recoveryStage === undefined ? "" : ` at ${recoveryStage}`;
  throw new RetryableError(
    `Continuity approval reconciliation must retry${stage}: ${code}. Preserve the same intent and native approval.`,
    { retryAfter: "5s" },
  );
};

/** The existing workflow step retry policy handles unavailable reads without a false approval result. */
export const readContinuityApprovalWithRecovery = async (
  read: () => Promise<{ approved: boolean; pending?: boolean }>,
  signal: AbortSignal,
  options: { deferPendingSettlement?: true } = {},
) => {
  let deferredRead: [code: string, recoveryStage: string | undefined] | undefined;
  while (deferredRead === undefined) {
    signal.throwIfAborted();
    try {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Continue only after server-confirmed durable native history progress.
      const result = await read();
      signal.throwIfAborted();
      if (result.pending === true && options.deferPendingSettlement === true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- An original unsettled request must defer preflight rather than prompt for duplicate consent.
        return await deferApprovalRead("approval_settlement_pending", "native_history");
      }
      return result;
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof HostedSessionReadTimeoutError) {
        if (error.progressPersisted) {
          // Continue after confirmed durable native history progress.
        } else {
          deferredRead = ["approval_history_incomplete", "native_history"];
        }
      } else if (
        error instanceof HostedOperatorError &&
        ["operator_unavailable", "operation_in_progress"].includes(error.code)
      ) {
        if (error.recoveryProgressAdvanced === true) {
          // Continue after confirmed durable native history progress.
        } else {
          deferredRead = [error.code, error.recoveryStage];
        }
      } else {
        throw error;
      }
    }
  }
  return await deferApprovalRead(...deferredRead);
};
