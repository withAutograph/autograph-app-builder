import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
} from "@/lib/agent/workflow-state";
import {
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  fixtureValidationCommandExecutor,
  sandboxValidationCommandExecutor,
} from "@/lib/repository/target-validation";
import { hasTestCapability } from "@/lib/testing/test-capability";

export default defineTool({
  description:
    "Run the repository's normal validation commands against the current applied app. Command exit status is the validation result. This does not publish or otherwise change an external repository.",
  inputSchema: z.object({}),
  async execute(_input, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "applied" &&
      current.phase !== "validation_pending" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated"
    )
      throw new Error(
        "Apply the requested changes before running the repository checks.",
      );
    if (current.phase === "validated") {
      return {
        status: "validated" as const,
        commandCount: current.validationReceipt.commands.length,
        reused: true,
      };
    }
    const sandbox = await ctx.getSandbox();
    const fixture = hasTestCapability("simulated-target");
    const attempt = createTargetValidationAttempt(
      current.applyReceipt,
      ctx.callId,
    );
    const base = {
      version: APP_BUILDER_WORKFLOW_VERSION,
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
      applyReceipt: current.applyReceipt,
    } as const;
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validation_pending",
      validationAttempt: attempt,
    }));
    const result = await executeProposalBoundValidation({
      sandbox,
      executor: fixture
        ? fixtureValidationCommandExecutor()
        : sandboxValidationCommandExecutor(),
      apply: current.applyReceipt,
      attempt,
      dependencyLayout: current.dependencyReceipt.dependencyLayout,
      appId: current.appSpec.appId,
    });
    if (!result.ok) {
      appBuilderWorkflowState.update(() => ({
        ...base,
        phase: "validation_failed",
        validationFailure: result.receipt,
      }));
      throw new Error(
        "The repository validation command failed. Fix the reported command error and try again.",
      );
    }
    appBuilderWorkflowState.update(() => ({
      ...base,
      phase: "validated",
      validationReceipt: result.receipt,
    }));
    return {
      status: "validated" as const,
      commandCount: result.receipt.commands.length,
      reused: false,
    };
  },
});
