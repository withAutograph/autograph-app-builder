import { defineState } from "eve/context";
/** Diagnostic provenance of an actual completed private reconciliation; never provider or publication approval. */
export interface LocalPlanningSourceReceipt {
  appId: string;
  workspaceId: string;
  sourceReceiptDigest: string;
  previousSourceReceiptDigest: string;
  workspaceDigest: string;
  previousWorkspaceDigest: string;
  recognizedSourceOverlay?: { sourceSha: string; workspaceDigest: string };
  sourceSnapshotTree: string;
  privateSourceCommit: string;
  checkpointRef: string;
  previousApplyDigest?: string;
  previousProposalDigest?: string;
  acceptedAppSpecDigest: string;
  reconciledByCallId: string;
}
export const localPlanningSourceHistory = defineState<readonly LocalPlanningSourceReceipt[]>(
  "autograph-app-builder.local-planning-source.v1",
  () => [],
);
