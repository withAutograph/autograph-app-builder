import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import {
  executeProposalBoundApply,
  fixtureApplyCommandExecutor,
  inspectFixtureApplyOverlay,
  sandboxApplyCommandExecutor,
} from "@/lib/repository/target-apply";
import { hasTestCapability } from "@/lib/testing/test-capability";

export default defineTool({
  description:
    "Build this app in the private preview checkout, then validate it for review. This does not publish, deploy, provision resources, or change the user's repository.",
  approval: always(),
  inputSchema: z.object({
    productSummary: z.string().trim().min(1).max(600).optional(),
  }),
  async execute(_input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied"
    )
      throw new Error(
        "Derive an exact canonical proposal before requesting target apply.",
      );
    const sandbox = await ctx.getSandbox();
    const fixture = hasTestCapability("simulated-target");
    if (current.phase === "applied") {
      return { ...current.applyReceipt, reused: true };
    }

    const binding = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      appSpecDigest: current.appSpec.digest,
      appSpecPath: current.appSpec.artifactPath,
      artifactRevision: current.appSpec.artifactRevision,
      dependencyReceiptDigest: current.dependencyReceipt.digest,
      identityDigest: current.identityReceipt.digest,
      imageDigest: current.dependencyReceipt.imageDigest,
      dependencyCacheDigest: current.dependencyReceipt.dependencyCacheDigest,
      dependencyCacheContentDigest:
        current.dependencyReceipt.cacheContentDigest,
      proposalDigest: current.proposal.digest,
    };
    const result = await executeProposalBoundApply({
      sandbox,
      executor: fixture
        ? fixtureApplyCommandExecutor()
        : sandboxApplyCommandExecutor(),
      ...(fixture
        ? {
            snapshotter: (fixtureSandbox, applyRoot) =>
              inspectFixtureApplyOverlay(
                fixtureSandbox,
                applyRoot,
                current.appSpec.appId,
              ),
          }
        : {}),
      binding,
      artifactRevision: current.appSpec.artifactRevision,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      proposal: current.proposal.target,
      appliedByCallId: ctx.callId,
    });
    if (!result.ok) {
      updateExactWorkflow({
        expected: current,
        operation: "target apply failure recording",
        transition: () => ({
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "apply_failed",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: current.artifacts,
          appSpec: current.appSpec,
          dependencyReceipt: current.dependencyReceipt,
          identityReceipt: current.identityReceipt,
          proposal: current.proposal,
          applyFailure: result.receipt,
        }),
      });
      throw new Error(
        `The repository build command exited with code ${result.receipt.command.exitCode} (${result.receipt.commandFailureKind ?? "unknown"}).${result.receipt.command.exitCode === -1 ? " The execution service did not return a normal command result." : ""}`,
      );
    }
    updateExactWorkflow({
      expected: current,
      operation: "target apply success recording",
      transition: () => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "applied",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        ...(current.githubSource === undefined
          ? {}
          : { githubSource: current.githubSource }),
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: current.identityReceipt,
        proposal: current.proposal,
        applyReceipt: result.receipt,
      }),
    });
    return { ...result.receipt, reused: false };
  },
});
