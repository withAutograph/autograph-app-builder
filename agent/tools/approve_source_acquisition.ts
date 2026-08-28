import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";

export default defineTool({
  description:
    "Automatically bind an exact eligible fresh-template local checkout as the internal acquisition source. This does not clone, copy, or materialize anything.",
  inputSchema: z.object({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedSourceReceiptDigest }, ctx) {
    const current = sourceWorkflowState.get();
    if (current.phase === "empty") throw new Error("No source was reviewed.");
    if (current.receipt.sourceKind !== "fresh-template")
      throw new Error("Acquisition approval only applies to fresh templates.");
    if (current.receipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source receipt does not match the reviewed source.");
    const currentReceipt = await inspectSourceReceipt(
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
