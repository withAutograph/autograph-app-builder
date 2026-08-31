import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
  workflowWorkspace,
} from "@/lib/agent/workflow-state";
import { sourceWorkflowState } from "@/lib/agent/source-state";
import {
  SOURCE_RECEIPT_VERSION,
  inspectSourceReceipt,
} from "@/lib/repository/source-receipt";
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import { prepareSupportedSandboxWorkspace } from "@/lib/repository/supported-template";
import { inspectCanonicalArrustedSandboxWorkspace } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "Materialize an eligible exact source tree inside the current app build's isolated workspace. This is automatic, read-only with respect to the source, and remains bound to the canonical source receipt.",
  inputSchema: z.object({
    expectedSourceReceiptDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedSourceReceiptDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "workspace preparation");
    const source = sourceWorkflowState.get();
    if (source.phase === "empty") throw new Error("No source was reviewed.");
    if (source.receipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source receipt does not match the reviewed source.");
    if (source.githubSource !== undefined) {
      assertExactImmutableGitHubSourceReceipt(source.githubSource);
      if (
        source.receipt.sourceKind !== "existing-repository" ||
        source.githubSource.resolvedSha !== source.receipt.sourceSha ||
        source.githubSource.resolvedTree !== source.receipt.sourceTree
      )
        throw new Error(
          "The immutable GitHub receipt is not bound to the reviewed source.",
        );
    }
    if (
      source.receipt.sourceKind === "fresh-template" &&
      source.phase !== "acquisition_approved"
    )
      throw new Error("Fresh-template acquisition was not approved.");
    const sandbox = await ctx.getSandbox();
    const canonicalWorkspace =
      source.receipt.version === SOURCE_RECEIPT_VERSION
        ? await inspectCanonicalArrustedSandboxWorkspace({
            sandbox,
            receipt: source.receipt,
          })
        : undefined;
    const currentReceipt =
      source.receipt.version === SOURCE_RECEIPT_VERSION
        ? source.receipt
        : await inspectSourceReceipt(
            source.receipt.sourceKind,
            source.receipt.sourcePath,
          );
    if (currentReceipt.digest !== expectedSourceReceiptDigest)
      throw new Error("The source changed after review or approval.");
    const {
      sourcePath: path,
      sourceSha: expectedSha,
      sourceTree: expectedTree,
      eligibilityDigest: expectedEligibilityDigest,
    } = currentReceipt;
    const currentWorkspace = workflowWorkspace(current);
    if (
      current.phase !== "empty" &&
      current.githubSource?.digest !== source.githubSource?.digest
    )
      throw new Error(
        "This app build already owns a different GitHub source binding.",
      );
    if (
      currentWorkspace !== undefined &&
      (currentWorkspace.sourceSha !== expectedSha ||
        currentWorkspace.sourceTree !== expectedTree ||
        currentWorkspace.eligibilityDigest !== expectedEligibilityDigest)
    )
      throw new Error("This app build already owns a different workspace.");
    let workspace;
    if (currentReceipt.version === SOURCE_RECEIPT_VERSION) {
      if (canonicalWorkspace === undefined)
        throw new Error("The canonical Arrusted workspace is missing.");
      workspace = canonicalWorkspace;
    } else {
      workspace = await prepareSupportedSandboxWorkspace(
        path,
        expectedSha,
        expectedEligibilityDigest,
        sandbox,
        ctx.callId,
      );
    }
    if (workspace.sourceTree !== expectedTree)
      throw new Error("The prepared source tree changed after review.");
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "workspace preparation");
      return current.phase === "empty" || current.phase === "prepared"
        ? {
            version: APP_BUILDER_WORKFLOW_VERSION,
            phase: "prepared",
            preparedByCallId: ctx.callId,
            workspace,
            sourceReceipt: currentReceipt,
            ...(source.githubSource === undefined
              ? {}
              : { githubSource: source.githubSource }),
            artifacts: [],
          }
        : current;
    });
    return workspace;
  },
});
