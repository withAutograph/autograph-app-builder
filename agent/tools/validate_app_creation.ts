import { reviewAppliedProductSource } from "@/lib/agent/review-applied-product-source";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import { defineTool } from "eve/tools";
import { z } from "zod";

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
    const sandbox = await ctx.getSandbox();
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
    const base = {
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      artifacts: current.artifacts,
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
      await writeImplementationFiles(0);
    }
    const result = await executeProposalBoundValidation({
      appId: current.appSpec.appId,
      apply: current.applyReceipt,
      attempt,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      executor: fixture ? fixtureValidationCommandExecutor() : sandboxValidationCommandExecutor(),
      sandbox,
    });
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
    const sourceAssessment = await reviewAppliedProductSource({
      abortSignal: ctx.abortSignal,
      appSpec: current.appSpec,
      applyReceipt: current.applyReceipt,
      getSandbox: async () => await ctx.getSandbox(),
    });
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
