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
  implementationArchitectureDiagnostics,
  implementationFilesSchema,
  withImplementationFiles,
} from "@/lib/agent/apply-implementation-files";
import { clearProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";

export default defineTool({
  approval(ctx) {
    const current = appBuilderWorkflowState.get();
    if (!("proposal" in current) || !("appSpec" in current)) {
      throw new Error(
        `Build approval cannot start in workflow phase ${current.phase}: no canonical implementation proposal is recorded. If the UI preview was revised, accept the current preview, record or reuse its build-ready AppSpec, then call accept_app_spec with existingAppChanges for an existing app. Supply the complete replacement content of each app-owned file to change. Wait for accept_app_spec to return a planned proposal before calling apply_app_creation.`,
      );
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
    // Existing app submissions are deltas; repository checks own validation.
    let architectureDiagnostics: string[] = [];
    if (!("operation" in current.proposal.target)) {
      const schemaKind = implementationFiles.some(
        (file) =>
          file.operation !== "delete" &&
          file.path === `.config/app-specs/${current.appSpec.appId}.cue`,
      )
        ? "kernel"
        : current.proposal.target.plan.source.schema.kind;
      architectureDiagnostics = implementationArchitectureDiagnostics(
        implementationFiles,
        schemaKind,
      );
    }
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
      const command = result.receipt.failedCommand ?? result.receipt.command.name;
      const diagnostics = [result.receipt.output?.stderr, result.receipt.output?.stdout]
        .filter(Boolean)
        .join("\n");
      let repair =
        " Repair the reported command error in the isolated checkout, then retry the private build.";
      if (result.receipt.commandFailureKind === "stale-proposal") {
        repair =
          " Re-observe the current app-owned files, accept a proposal based on their current contents, then retry the private build.";
      } else if (result.receipt.command.exitCode === -1) {
        repair =
          " The execution service did not return a normal command result; check the sandbox provider and retry.";
      } else if (diagnostics === "") {
        repair =
          " No safe command diagnostic was captured; inspect the named command in the isolated checkout before changing app files.";
      }
      throw new Error(
        `Builder failed to run ${command} (exit ${result.receipt.command.exitCode}, ${result.receipt.commandFailureKind ?? "unknown"})${result.receipt.missingDependency === undefined ? "" : ` while resolving ${result.receipt.missingDependency}`}.${diagnostics === "" ? "" : ` Diagnostic:\n${diagnostics}`}${repair}`,
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
      architectureDiagnostics,
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
