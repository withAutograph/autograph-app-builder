import { HostedOperatorError } from "../provisioning/hosted-operator-contract";

/** Defer only transient reads; execution still requires the exact native approval. */
export const readContinuityApprovalWithRecovery = async (
  read: () => Promise<{ approved: boolean }>,
  signal: AbortSignal,
) => {
  signal.throwIfAborted();
  try {
    return await read();
  } catch (error) {
    signal.throwIfAborted();
    if (
      !(error instanceof HostedOperatorError) ||
      !["operator_unavailable", "operation_in_progress"].includes(error.code)
    ) {
      throw error;
    }
    return { approved: false };
  }
};
