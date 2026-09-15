import { stageImplementationFiles } from "@/lib/agent/staged-implementation";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import {
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
} from "@/lib/agent/private-apply-authority";
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
import {
  assertImplementationArchitecture,
  implementationFilesSchema,
  withImplementationFiles,
} from "@/lib/agent/apply-implementation-files";
import { clearProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";

export default defineTool({
  approval(ctx) {
    const current = appBuilderWorkflowState.get();
    if (!("proposal" in current) || !("appSpec" in current)) {
      throw new Error("Derive a canonical proposal before requesting build approval.");
    }
    return requestPrivateApplyApproval(
      {
        appId: current.proposal.target.contract.appId,
        appSpecDigest: current.appSpec.digest,
        proposalDigest: current.proposal.digest,
        sessionId: ctx.session.id,
        workspaceId: current.workspace.workspaceId,
      },
      ctx.callId,
    );
  },
  description:
    "Build this app in the private preview checkout, then validate it for review. For a retry of the same proposal, send only repaired files: paths omitted from the retry retain their previously approved contents, and supplied paths replace them. A new proposal starts a fresh submission and requires its own approval. Repairing the same approved private build does not ask for the same approval again. This does not publish, deploy, provision resources, or change the user's repository.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied"
    ) {
      throw new Error("Derive an exact canonical proposal before requesting target apply.");
    }
    recordApprovedPrivateApply(
      {
        appId: current.proposal.target.contract.appId,
        appSpecDigest: current.appSpec.digest,
        proposalDigest: current.proposal.digest,
        sessionId: ctx.session.id,
        workspaceId: current.workspace.workspaceId,
      },
      ctx.callId,
    );
    if (current.phase === "applied") {
      return {
        appId: current.proposal.target.contract.appId,
        changedFileCount: current.applyReceipt.changes.length,
        productAcceptance: productAcceptanceObligations(current.appSpec),
        reused: true,
        status: "applied" as const,
      };
    }

    const implementationFiles = stageImplementationFiles({
      appSpecDigest: current.appSpec.digest,
      files: input.implementationFiles,
      proposalDigest: current.proposal.digest,
    });
    assertImplementationArchitecture(
      implementationFiles,
      current.proposal.target.plan.source.schema.kind,
    );
    const sandbox = await ctx.getSandbox();
    const fixture = hasTestCapability("simulated-target");
    const binding = {
      appSpecDigest: current.appSpec.digest,
      appSpecPath: current.appSpec.artifactPath,
      artifactRevision: current.appSpec.artifactRevision,
      dependencyCacheContentDigest: current.dependencyReceipt.cacheContentDigest,
      dependencyCacheDigest: current.dependencyReceipt.dependencyCacheDigest,
      dependencyReceiptDigest: current.dependencyReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      identityDigest: current.identityReceipt.digest,
      imageDigest: current.dependencyReceipt.imageDigest,
      proposalDigest: current.proposal.digest,
      sourceReceiptDigest: current.sourceReceipt.digest,
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      workspaceDigest: current.workspace.workspaceDigest,
    };
    clearProductBehaviorEvidence();
    const result = await executeProposalBoundApply({
      appliedByCallId: ctx.callId,
      artifactRevision: current.appSpec.artifactRevision,
      binding,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      executor: withImplementationFiles(
        fixture ? fixtureApplyCommandExecutor() : sandboxApplyCommandExecutor(),
        implementationFiles,
      ),
      proposal: current.proposal.target,
      sandbox,
      ...(fixture
        ? {
            snapshotter: (fixtureSandbox, applyRoot) =>
              inspectFixtureApplyOverlay(fixtureSandbox, applyRoot, current.appSpec.appId),
          }
        : {}),
    });
    if (!result.ok) {
      updateExactWorkflow({
        expected: current,
        operation: "target apply failure recording",
        transition: () => ({
          appSpec: current.appSpec,
          applyFailure: result.receipt,
          artifacts: current.artifacts,
          dependencyReceipt: current.dependencyReceipt,
          ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
          identityReceipt: current.identityReceipt,
          phase: "apply_failed",
          preparedByCallId: current.preparedByCallId,
          proposal: current.proposal,
          sourceReceipt: current.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: current.workspace,
        }),
      });
      throw new Error(
        `The repository build command exited with code ${result.receipt.command.exitCode} (${result.receipt.commandFailureKind ?? "unknown"})${result.receipt.missingDependency === undefined ? "" : ` while resolving ${result.receipt.missingDependency}`}.${result.receipt.command.exitCode === -1 ? " The execution service did not return a normal command result." : ""}`,
      );
    }
    updateExactWorkflow({
      expected: current,
      operation: "target apply success recording",
      transition: () => ({
        appSpec: current.appSpec,
        applyReceipt: result.receipt,
        artifacts: current.artifacts,
        dependencyReceipt: current.dependencyReceipt,
        ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
        identityReceipt: current.identityReceipt,
        phase: "applied",
        preparedByCallId: current.preparedByCallId,
        proposal: current.proposal,
        sourceReceipt: current.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
      }),
    });
    return {
      appId: current.proposal.target.contract.appId,
      changedFileCount: result.receipt.changes.length,
      productAcceptance: productAcceptanceObligations(current.appSpec),
      reused: false,
      status: "applied" as const,
    };
  },
  inputSchema: z.object({
    implementationFiles: implementationFilesSchema.default([]),
    productSummary: z.string().trim().min(1).max(600).optional(),
  }),
});
