import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
/** Fresh private planning provenance; this is not a provider, app-data or publication approval. */
export const localSourceReconciliationSchema = z.strictObject({
  appId: z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u),
  appSpecDigest: digest,
  checkpointRef: z
    .string()
    .regex(
      /^refs\/app-builder\/local-source-checkpoints\/[a-f0-9]{64}\/[a-f0-9]{40}\/[a-f0-9]{40}$/u,
    ),
  kind: z.literal("local-source-reconciliation-v1"),
  previousApplyDigest: digest,
  previousProposalDigest: digest,
  previousSourceReceiptDigest: digest,
  previousWorkspaceDigest: digest,
  reconciledByCallId: z.string().min(1),
  sourceReceiptDigest: digest,
  sourceSnapshotTree: z.string().regex(/^[a-f0-9]{40}$/u),
  workspaceDigest: digest,
  workspaceId: z.string().min(1),
});
export type LocalSourceReconciliation = z.infer<typeof localSourceReconciliationSchema>;
