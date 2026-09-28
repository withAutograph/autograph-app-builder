import { reviewAppliedProductSource } from "@/lib/agent/review-applied-product-source";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";
import { prepareValidationLocalData } from "./prepare-app-local-preview";

import {
  assertExistingAppImplementationFiles,
  implementationFilesSchema,
} from "@/lib/agent/apply-implementation-files";
import { APP_BUILDER_WORKFLOW_VERSION, appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import {
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  fixtureValidationCommandExecutor,
  sandboxValidationCommandExecutor,
} from "@/lib/repository/target-validation";
import { hasTestCapability } from "@/lib/testing/test-capability";
import {
  clearProductBehaviorEvidence,
  currentProductBehaviorEvidence,
} from "@/lib/agent/product-behavior-state";

const validationPhase = (callId: string, phase: string, detail?: string | boolean): void => {
  console.info(
    JSON.stringify({
      callId,
      event: "app_builder.validation_phase",
      phase,
      ...(detail === undefined ? {} : { detail }),
    }),
  );
};

export default defineTool({
  description:
    "Run the repository's normal validation commands against the current applied app. Command exit status is the technical validation result; successful checks also return an independent source assessment against the original product request. Neither proves runtime behavior. This does not publish or otherwise change an external repository.",
  async execute(input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "applied" &&
      current.phase !== "validation_pending" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated" &&
      current.phase !== "reviewed"
    ) {
      throw new Error("Apply the requested changes before running the repository checks.");
    }
    assertExistingAppImplementationFiles(input.implementationFiles, current.proposal.target);
    if (
      (current.phase === "validated" || current.phase === "reviewed") &&
      input.implementationFiles.length === 0
    ) {
      const evidence = currentProductBehaviorEvidence(
        current.appSpec.digest,
        current.applyReceipt.digest,
      );
      const sourceAssessment = await reviewAppliedProductSource({
        abortSignal: ctx.abortSignal,
        appSpec: current.appSpec,
        applyReceipt: current.applyReceipt,
        callId: ctx.callId,
        getSandbox: async () => await ctx.getSandbox(),
      });
      ctx.abortSignal?.throwIfAborted();
      return {
        commandCount: current.validationReceipt.commands.length,
        productAcceptance: productAcceptanceObligations(
          current.appSpec,
          evidence,
          sourceAssessment,
        ),
        productBehaviorEvidence: evidence,
        reused: true,
        sourceAssessment,
        status: "validated" as const,
        technicalStatus: "passed" as const,
      };
    }
    validationPhase(ctx.callId, "resolving_sandbox");
    const sandbox = await ctx.getSandbox();
    validationPhase(ctx.callId, "sandbox_ready");
    const relativeApplyRoot = current.applyReceipt.applyRoot.replace(/^\/workspace\//u, "");
    const writeImplementationFiles = async (index: number): Promise<void> => {
      const file = input.implementationFiles[index];
      if (file === undefined) {
        return;
      }
      await sandbox.writeTextFile({
        content: file.content,
        path: `${relativeApplyRoot}/${file.path}`,
      });
      await writeImplementationFiles(index + 1);
    };
    const fixture = hasTestCapability("simulated-target");
    const attempt = createTargetValidationAttempt(current.applyReceipt, ctx.callId);
    const priorPublishedGitHubDraftProposalDigest =
      current.publishedGitHubDraftProposalDigest ??
      (current.phase === "reviewed" ? current.githubDraftProposal?.proposal.digest : undefined);
    const base = {
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      artifacts: current.artifacts,
      ...(priorPublishedGitHubDraftProposalDigest === undefined
        ? {}
        : { publishedGitHubDraftProposalDigest: priorPublishedGitHubDraftProposalDigest }),
      dependencyReceipt: current.dependencyReceipt,
      ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
      identityReceipt: current.identityReceipt,
      preparedByCallId: current.preparedByCallId,
      proposal: current.proposal,
      sourceReceipt: current.sourceReceipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
      workspace: current.workspace,
    } as const;
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validation_pending",
      validationAttempt: attempt,
    }));
    if (input.implementationFiles.length > 0) {
      clearProductBehaviorEvidence();
      validationPhase(ctx.callId, "writing_implementation_files");
      await writeImplementationFiles(0);
      validationPhase(ctx.callId, "implementation_files_written");
    }
    // Some repository test tasks start local services. Prepare the declared
    // local data task first so its server inherits the setup log file rather
    // than Turbo's captured test pipe, which would keep Turbo waiting after
    // the tests themselves have finished.
    if (!fixture) {
      validationPhase(ctx.callId, "preparing_declared_local_data");
      await prepareValidationLocalData({
        appId: current.appSpec.appId,
        root: current.applyReceipt.applyRoot,
        sandbox,
        signal: ctx.abortSignal,
      });
      validationPhase(ctx.callId, "declared_local_data_ready");
    }
    validationPhase(ctx.callId, "running_repository_commands");
    const result = await executeProposalBoundValidation({
      appId: current.appSpec.appId,
      apply: current.applyReceipt,
      attempt,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      executor: fixture ? fixtureValidationCommandExecutor() : sandboxValidationCommandExecutor(),
      sandbox,
    });
    validationPhase(ctx.callId, "repository_commands_finished", result.ok);
    if (!result.ok) {
      appBuilderWorkflowState.update(() => ({
        ...base,
        phase: "validation_failed",
        validationFailure: result.receipt,
      }));
      return {
        commandFailure: result.receipt.commandFailure,
        diagnostics: result.receipt.diagnostics ?? [],
        output: result.receipt.output,
        reason: result.receipt.reason,
        reused: false,
        status: "needs_repair" as const,
      };
    }
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validated",
      validationReceipt: result.receipt,
    }));
    const evidence = currentProductBehaviorEvidence(
      current.appSpec.digest,
      current.applyReceipt.digest,
    );
    validationPhase(ctx.callId, "reviewing_applied_source");
    const sourceAssessment = await reviewAppliedProductSource({
      abortSignal: ctx.abortSignal,
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      callId: ctx.callId,
      getSandbox: async () => await ctx.getSandbox(),
    });
    validationPhase(ctx.callId, "applied_source_review_finished", sourceAssessment.status);
    return {
      commandCount: result.receipt.commands.length,
      productAcceptance: productAcceptanceObligations(current.appSpec, evidence, sourceAssessment),
      productBehaviorEvidence: evidence,
      reused: false,
      sourceAssessment,
      status: "validated" as const,
      technicalStatus: "passed" as const,
    };
  },
  inputSchema: z.object({
    implementationFiles: implementationFilesSchema.default([]),
  }),
});
