import { internalCorrectionRequiresSuccessor } from "@/lib/agent/preapproval-authoring-runtime";
import { applyApprovedPrivateComputeProfile } from "@/lib/sandbox/private-compute-activation";
import { PRIVATE_COMPUTE_PROFILE_ID } from "@/lib/sandbox/private-compute-profile";
import { completionGuidance } from "@/lib/agent/completion-guidance";
import { stageImplementationFiles } from "@/lib/agent/staged-implementation";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import {
  discardPendingPrivateApplyApproval,
  hasPendingPrivateApplyApproval,
  recordApprovedPrivateApply,
  requestPrivateApplyApproval,
} from "@/lib/agent/private-apply-authority";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  updateExactWorkflow,
  assertExactWorkflowState,
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
import { invalidateProductBehaviorEvidence } from "@/lib/agent/product-behavior-state";

const APPROVAL_NOT_APPLICABLE = "not-applicable";

export default defineTool({
  approval(ctx) {
    if (internalCorrectionRequiresSuccessor(ctx)) {
      discardPendingPrivateApplyApproval(ctx.callId);
      return APPROVAL_NOT_APPLICABLE;
    }
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied"
    ) {
      discardPendingPrivateApplyApproval(ctx.callId);
      // Only the read-only prerequisite report can execute in this phase.
      return APPROVAL_NOT_APPLICABLE;
    }
    if (ctx.toolInput?.privateCompute !== current.proposal.target.privateCompute?.id) {
      discardPendingPrivateApplyApproval(ctx.callId);
      return APPROVAL_NOT_APPLICABLE;
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
    "Build this app in the build workspace, then validate it for review. When the user asks to prepare a planned private build for review, draft the implementation files in the tool input and submit this call to present the normal Build approval. Preparing that input does not write to the workspace. Wait for the approval decision before any implementation write. For a retry of the same proposal, send only repaired files. Omitted paths retain their staged contents, and supplied paths replace them. A new proposal starts a fresh submission. When the plan selects privateCompute, send its exact profile ID so the user can approve the compute footprint before resizing the private execution session. This does not publish, deploy, provision application resources, or change the user's repository.",
  // oxlint-disable-next-line eslint/complexity, sonarjs/cognitive-complexity -- Keep exact current proposal, internal correction, approval, workspace and implementation scope checks ordered at the effect boundary.
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (internalCorrectionRequiresSuccessor(ctx)) {
      return {
        status: "corrected_proposal_required" as const,
        guidance:
          "Correct the declined draft through prepare_app_creation with explicit existingAppChanges and freeze a successor proposal before continuing the build. Do not retry the unchanged declined proposal.",
        workflowPhase: current.phase,
      };
    }
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied"
    ) {
      return {
        guidance: completionGuidance(current),
        status: "implementation_plan_required" as const,
        workflowPhase: current.phase,
      };
    }
    if (input.privateCompute !== current.proposal.target.privateCompute?.id) {
      return {
        status: "compute_profile_required" as const,
        privateCompute: current.proposal.target.privateCompute?.id,
        guidance:
          "Use the exact private compute profile from the current plan so the user can approve the resize footprint.",
      };
    }
    const scope = {
      appId: current.proposal.target.contract.appId,
      appSpecDigest: current.appSpec.digest,
      proposalDigest: current.proposal.digest,
      sessionId: ctx.session.id,
      workspaceId: current.workspace.workspaceId,
    };
    if (!hasPendingPrivateApplyApproval(scope, ctx.callId)) {
      return {
        guidance:
          "This tool call has no matching approval policy decision for the current proposal and private target. Retry apply_app_creation to present the Build decision or reuse the existing approval for this scope.",
        status: "build_approval_required" as const,
        workflowPhase: current.phase,
      };
    }
    recordApprovedPrivateApply(scope, ctx.callId);
    if (current.proposal.target.privateCompute !== undefined) {
      await applyApprovedPrivateComputeProfile({
        profile: current.proposal.target.privateCompute,
        proposalDigest: current.proposal.digest,
        callId: ctx.callId,
        sessionId: ctx.session.id,
        appId: scope.appId,
        assertCurrent: () => {
          ctx.abortSignal.throwIfAborted();
          assertExactWorkflowState(
            appBuilderWorkflowState.get(),
            current,
            "activate the reviewed private compute profile",
          );
        },
      });
    }

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
    invalidateProductBehaviorEvidence("source-apply");
    const applyInput: Parameters<typeof executeProposalBoundApply>[0] = {
      appliedByCallId: ctx.callId,
      artifactRevision: current.appSpec.artifactRevision,
      binding,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      executor: withImplementationFiles(
        fixture ? fixtureApplyCommandExecutor() : sandboxApplyCommandExecutor(),
        implementationFiles,
        { reconcileNewWorkspace: !fixture },
      ),
      proposal: current.proposal.target,
      sandbox,
    };
    if (fixture) {
      applyInput.snapshotter = (fixtureSandbox, applyRoot) =>
        inspectFixtureApplyOverlay(fixtureSandbox, applyRoot, current.appSpec.appId);
    }
    const result = await executeProposalBoundApply(applyInput);
    if (!result.ok) {
      updateExactWorkflow({
        expected: current,
        operation: "target apply failure recording",
        transition: () => {
          type AppliedState = Extract<
            ReturnType<typeof appBuilderWorkflowState.get>,
            { phase: "apply_failed" }
          >;
          const applied = {
            appSpec: current.appSpec,
            applyFailure: result.receipt,
            artifacts: current.artifacts,
            dependencyReceipt: current.dependencyReceipt,
          };
          const source: Pick<AppliedState, "githubSource" | "publishedGitHubDraftProposalDigest"> =
            {};
          if (current.githubSource !== undefined) {
            source.githubSource = current.githubSource;
          }
          if (current.publishedGitHubDraftProposalDigest !== undefined) {
            source.publishedGitHubDraftProposalDigest = current.publishedGitHubDraftProposalDigest;
          }
          return {
            ...applied,
            ...source,
            identityReceipt: current.identityReceipt,
            phase: "apply_failed",
            preparedByCallId: current.preparedByCallId,
            proposal: current.proposal,
            sourceReceipt: current.sourceReceipt,
            version: APP_BUILDER_WORKFLOW_VERSION,
            workspace: current.workspace,
          };
        },
      });
      const command = result.receipt.failedCommand ?? result.receipt.command.name;
      const diagnostics = [result.receipt.output?.stderr, result.receipt.output?.stdout]
        .filter(Boolean)
        .join("\n");
      let repair =
        " Repair the reported command error in the isolated checkout, then retry the build.";
      if (result.receipt.commandFailureKind === "stale-proposal") {
        repair =
          " Re-observe the current app-owned files, accept a proposal based on their current contents, then retry the build.";
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
      transition: () => {
        type AppliedState = Extract<
          ReturnType<typeof appBuilderWorkflowState.get>,
          { phase: "applied" }
        >;
        const applied = {
          appSpec: current.appSpec,
          applyReceipt: result.receipt,
          artifacts: current.artifacts,
          dependencyReceipt: current.dependencyReceipt,
        };
        const source: Pick<AppliedState, "githubSource" | "publishedGitHubDraftProposalDigest"> =
          {};
        if (current.githubSource !== undefined) {
          source.githubSource = current.githubSource;
        }
        if (current.publishedGitHubDraftProposalDigest !== undefined) {
          source.publishedGitHubDraftProposalDigest = current.publishedGitHubDraftProposalDigest;
        }
        return {
          ...applied,
          ...source,
          identityReceipt: current.identityReceipt,
          phase: "applied",
          preparedByCallId: current.preparedByCallId,
          proposal: current.proposal,
          sourceReceipt: current.sourceReceipt,
          version: APP_BUILDER_WORKFLOW_VERSION,
          workspace: current.workspace,
        };
      },
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
    productSummary: z.string().trim().optional(),
    privateCompute: z.literal(PRIVATE_COMPUTE_PROFILE_ID).optional(),
  }),
});
