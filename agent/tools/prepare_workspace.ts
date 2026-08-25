import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import { inspectSourceReceipt } from "@/lib/repository/source-receipt";
import { prepareSupportedSandboxWorkspace } from "@/lib/repository/supported-template";

export default defineTool({
  description:
    "Materialize an already-reviewed eligible source tree inside this Eve session's isolated workspace. This requires its own approval bound to the exact canonical source receipt.",
  inputSchema: z.object({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ expectedSourceReceiptDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace preparation");
    const source = sourceWorkflowState.get();
    if (source.phase === "empty") throw new Error("No source was reviewed.");
    if (source.receipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source receipt does not match the reviewed source.");
    if (
      source.receipt.sourceKind === "fresh-template" &&
      source.phase !== "acquisition_approved"
    )
      throw new Error("Fresh-template acquisition was not approved.");
    const currentReceipt = await inspectSourceReceipt(
      source.receipt.sourceKind,
      source.receipt.sourcePath,
    );
    if (currentReceipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source changed after review or approval.");
    const {
      sourcePath: path,
      sourceSha: expectedSha,
      eligibilityDigest: expectedEligibilityDigest,
    } = currentReceipt;
    const currentWorkspace = workflowWorkspace(current);
    if (
      currentWorkspace !== undefined &&
      (currentWorkspace.sourceSha !== expectedSha ||
        currentWorkspace.eligibilityDigest !== expectedEligibilityDigest)
    )
      throw new Error("This Eve session already owns a different workspace.");
    const workspace = await prepareSupportedSandboxWorkspace(
      path,
      expectedSha,
      expectedEligibilityDigest,
      await ctx.getSandbox(),
      ctx.callId,
    );
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "workspace preparation");
      return current.phase === "empty" || current.phase === "prepared"
        ? {
            version: APP_BUILDER_WORKFLOW_VERSION,
            phase: "prepared",
            preparedByCallId: ctx.callId,
            workspace,
            sourceReceipt: currentReceipt,
            artifacts: [],
          }
        : current;
    });
    return workspace;
  },
});
