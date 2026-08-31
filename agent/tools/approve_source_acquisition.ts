import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_SOURCE_VERSION,
  sourceWorkflowState,
} from "@/lib/agent/source-state";
import { existingRepositoryAcquisitionReceipt } from "@/lib/agent/existing-app-sequencing";
import {
  SOURCE_RECEIPT_VERSION,
  inspectSourceReceipt,
} from "@/lib/repository/source-receipt";
import { inspectCanonicalArrustedSandboxWorkspace } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "Automatically bind the exact eligible canonical Arrusted workspace clone as the internal fresh-template source. This does not clone, fetch, or materialize another workspace.",
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
    let currentReceipt = current.receipt;
    if (current.receipt.version === SOURCE_RECEIPT_VERSION) {
      await inspectCanonicalArrustedSandboxWorkspace({
        sandbox: await ctx.getSandbox(),
        receipt: current.receipt,
      });
    } else {
      currentReceipt = await inspectSourceReceipt(
        current.receipt.sourceKind,
        current.receipt.sourcePath,
      );
    }
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
