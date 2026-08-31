import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import { existingRepositoryAcquisitionReceipt } from "@/lib/agent/existing-app-sequencing";
import {
  SOURCE_RECEIPT_VERSION,
  inspectClonedTemplateSourceReceipt,
  inspectSourceReceipt,
} from "@/lib/repository/source-receipt";

export default defineTool({
  description:
    "Automatically bind the exact eligible canonical Arrusted clone as the internal fresh-template source. This does not materialize the workspace.",
  inputSchema: z.object({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedSourceReceiptDigest }, ctx) {
    const current = sourceWorkflowState.get();
    const existing = existingRepositoryAcquisitionReceipt(
      current,
      expectedSourceReceiptDigest,
    );
    if (existing !== undefined) return existing;
    if (current.phase === "empty") throw new Error("No source was reviewed.");
    const currentReceipt =
      current.receipt.version === SOURCE_RECEIPT_VERSION
        ? await inspectClonedTemplateSourceReceipt({
            path: current.receipt.sourcePath,
            readinessDigest: current.receipt.provenance.readinessDigest,
          })
        : await inspectSourceReceipt(
            current.receipt.sourceKind,
            current.receipt.sourcePath,
          );
    if (currentReceipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source changed after review.");
    sourceWorkflowState.update(() => ({
      version: APP_BUILDER_SOURCE_VERSION,
      phase: "acquisition_approved",
      receipt: currentReceipt,
      approvedByCallId: ctx.callId,
    }));
    return currentReceipt;
  },
});
