import type { SourceWorkflowState } from "./source-state";
import type { AppBuilderWorkflowState } from "./workflow-state";

export function canInspectExistingApplication(
  state: AppBuilderWorkflowState,
): boolean {
  return state.phase !== "empty";
}

export function existingRepositoryAcquisitionReceipt(
  state: SourceWorkflowState,
  expectedDigest: string,
) {
  if (state.phase === "empty") throw new Error("No source was reviewed.");
  if (state.receipt.digest !== expectedDigest)
    throw new Error("The source receipt does not match the reviewed source.");
  return state.receipt.sourceKind === "existing-repository"
    ? state.receipt
    : undefined;
}
