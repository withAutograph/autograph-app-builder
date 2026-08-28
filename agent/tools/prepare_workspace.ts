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
import { assertExactImmutableGitHubSourceReceipt } from "@/lib/repository/github-publication";
import { prepareSupportedSandboxWorkspace } from "@/lib/repository/supported-template";
import {
  hostedSourceReceipt,
  prepareHostedSourceWorkspace,
} from "@/lib/repository/hosted-source";

export default defineTool({
  description:
    "Materialize an already-reviewed eligible source tree inside this App Builder run's isolated workspace. This requires its own approval bound to the exact canonical source receipt.",
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
    const hostedReceipt = hostedSourceReceipt(
      source.receipt.sourceKind,
      source.receipt.sourcePath,
    );
    const currentReceipt =
      hostedReceipt ??
      (await inspectSourceReceipt(
        source.receipt.sourceKind,
        source.receipt.sourcePath,
      ));
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
        "This App Builder run already owns a different GitHub source binding.",
      );
    if (
      currentWorkspace !== undefined &&
      (currentWorkspace.sourceSha !== expectedSha ||
        currentWorkspace.sourceTree !== expectedTree ||
        currentWorkspace.eligibilityDigest !== expectedEligibilityDigest)
    )
      throw new Error(
        "This App Builder run already owns a different workspace.",
      );
    const sandbox = await ctx.getSandbox();
    const workspace =
      hostedReceipt === undefined
        ? await prepareSupportedSandboxWorkspace(
            path,
            expectedSha,
            expectedEligibilityDigest,
            sandbox,
            ctx.callId,
          )
        : await prepareHostedSourceWorkspace({
            receipt: currentReceipt,
            sandbox,
            callId: ctx.callId,
          });
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
