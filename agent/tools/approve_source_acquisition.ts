import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { sourceWorkflowState } from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";

export default defineTool({
  description:
    "Approve use of an exact reviewed fresh-template local checkout as an acquisition source. This approval does not clone, copy, or materialize anything.",
  inputSchema: z.object({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
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
      version: 1,
      phase: "acquisition_approved",
      receipt: currentReceipt,
      approvedByCallId: ctx.callId,
    }));
    return currentReceipt;
  },
});
