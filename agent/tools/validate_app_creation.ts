import { defineTool } from "eve/tools";
import { always } from "eve/tools/approval";
import { z } from "zod";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import { inspectTargetExecutionReadiness } from "@/lib/agent/target-execution";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
} from "@/lib/agent/workflow-state";
import {
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "@/lib/repository/target-apply";
import { planningOverlayRoot } from "@/lib/repository/dependency-cache";
import {
  appliedOverlayDriftFailure,
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  fixtureValidationCommandExecutor,
  sandboxValidationCommandExecutor,
} from "@/lib/repository/target-validation";

export default defineTool({
  description:
    "Run only the two fixed target validation commands against independent copies of the exact applied tree. This separately approved operation records a durable pass or recovery-required failure receipt; it does not review or publish, and it detects drift in protected source, cache, planning, and applied bindings.",
  inputSchema: z.object({
    expectedApplyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ expectedApplyDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "applied" &&
      current.phase !== "validation_pending" &&
      current.phase !== "validation_failed" &&
      current.phase !== "validated"
    )
      throw new Error(
        "Apply an exact canonical proposal before requesting target validation.",
      );
    if (current.applyReceipt.digest !== expectedApplyDigest)
      throw new Error("The target apply receipt changed before validation.");
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    const fixture =
      process.env.APP_BUILDER_TEST_MODEL === "1" &&
      process.env.APP_BUILDER_REAL_SANDBOX !== "1";
    const attempt =
      current.phase === "applied"
        ? createTargetValidationAttempt(current.applyReceipt, ctx.callId)
        : undefined;
    const base = {
      version: APP_BUILDER_WORKFLOW_VERSION,
      preparedByCallId: current.preparedByCallId,
      workspace: current.workspace,
      artifacts: current.artifacts,
      appSpec: current.appSpec,
      dependencyReceipt: current.dependencyReceipt,
      identityReceipt: current.identityReceipt,
      proposal: current.proposal,
      applyReceipt: current.applyReceipt,
    } as const;
    if (attempt !== undefined)
      appBuilderWorkflowState.update((latest) => {
        if (
          latest.phase !== "applied" ||
          latest.applyReceipt.digest !== current.applyReceipt.digest ||
          latest.proposal.digest !== current.proposal.digest ||
          latest.appSpec.artifactRevision !== current.appSpec.artifactRevision
        )
          throw new Error(
            "The workflow changed concurrently before target validation started.",
          );
        return {
          ...base,
          phase: "validation_pending",
          validationAttempt: attempt,
        };
      });
    const sandbox = await ctx.getSandbox();
    if (current.phase === "validation_pending")
      throw new Error(
        `Target validation has an incomplete pending attempt ${current.validationAttempt.digest}; it is recovery-required and will not be redispatched automatically.`,
      );
    if (current.phase === "validation_failed") {
      const applied = fixture
        ? await inspectFixtureApplyOverlay(
            sandbox,
            current.applyReceipt.applyRoot,
            current.appSpec.appId,
          )
        : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
      if (applied.treeDigest !== current.applyReceipt.postTreeDigest)
        throw new Error(
          "The applied overlay changed after failed target validation.",
        );
      throw new Error(
        `Target validation is recovery-required after failed receipt ${current.validationFailure.digest}; it will not be rerun automatically.`,
      );
    }
    if (current.phase === "validated") {
      const applied = fixture
        ? await inspectFixtureApplyOverlay(
            sandbox,
            current.applyReceipt.applyRoot,
            current.appSpec.appId,
          )
        : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
      if (applied.treeDigest !== current.applyReceipt.postTreeDigest)
        throw new Error(
          "The applied overlay changed after its target-validation receipt.",
        );
      return { ...current.validationReceipt, reused: true };
    }
    const readiness = await inspectTargetExecutionReadiness({
      state: current,
      sandbox,
      expectedProposalDigest: current.proposal.digest,
    });
    if (!readiness.targetCommandReady)
      throw new Error(
        `Target validation is not ready: ${readiness.blockers.join(" ")}`,
      );
    const applied = fixture
      ? await inspectFixtureApplyOverlay(
          sandbox,
          current.applyReceipt.applyRoot,
          current.appSpec.appId,
        )
      : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
    if (applied.treeDigest !== current.applyReceipt.postTreeDigest)
      throw new Error("The applied overlay changed before target validation.");
    if (attempt === undefined)
      throw new Error("Target validation did not acquire its durable attempt.");
    const planningRoot = `/workspace/${planningOverlayRoot(current.appSpec.artifactRevision)}`;
    const planning = fixture
      ? await inspectFixtureApplyOverlay(
          sandbox,
          planningRoot,
          current.appSpec.appId,
        )
      : await inspectApplyOverlay(sandbox, planningRoot);
    if (planning.treeDigest !== current.applyReceipt.preTreeDigest)
      throw new Error("The planning overlay changed before target validation.");
    const prepared = fixture
      ? undefined
      : await inspectApplyOverlay(sandbox, current.workspace.workspacePath);
    if (fixture && current.appSpec.appId === "validation-interruption")
      throw new Error(
        "Fixture validation interruption after the durable pending receipt.",
      );
    let result = await executeProposalBoundValidation({
      sandbox,
      executor: fixture
        ? fixtureValidationCommandExecutor()
        : sandboxValidationCommandExecutor(),
      ...(fixture
        ? {
            snapshotter: (fixtureSandbox, root) =>
              inspectFixtureApplyOverlay(
                fixtureSandbox,
                root,
                current.appSpec.appId,
              ),
          }
        : {}),
      apply: current.applyReceipt,
      attempt,
      appId: current.appSpec.appId,
      verifyProtectedState: async () => {
        const latest = appBuilderWorkflowState.get();
        if (
          latest.phase !== "validation_pending" ||
          latest.validationAttempt.digest !== attempt.digest
        )
          throw new Error("The workflow changed during target validation.");
        const readinessAfter = await inspectTargetExecutionReadiness({
          state: latest,
          sandbox,
          expectedProposalDigest: latest.proposal.digest,
        });
        if (!readinessAfter.targetCommandReady)
          throw new Error(
            "Target execution readiness drifted during validation.",
          );
        if (prepared !== undefined) {
          const preparedAfter = await inspectApplyOverlay(
            sandbox,
            current.workspace.workspacePath,
          );
          if (preparedAfter.treeDigest !== prepared.treeDigest)
            throw new Error("The prepared source changed during validation.");
        }
        const planningAfter = fixture
          ? await inspectFixtureApplyOverlay(
              sandbox,
              planningRoot,
              current.appSpec.appId,
            )
          : await inspectApplyOverlay(sandbox, planningRoot);
        if (planningAfter.treeDigest !== current.applyReceipt.preTreeDigest)
          throw new Error("The planning overlay changed during validation.");
        const appliedDuring = fixture
          ? await inspectFixtureApplyOverlay(
              sandbox,
              current.applyReceipt.applyRoot,
              current.appSpec.appId,
            )
          : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
        if (appliedDuring.treeDigest !== current.applyReceipt.postTreeDigest)
          throw new Error("The applied overlay changed during validation.");
      },
    });
    const appliedAfter = fixture
      ? await inspectFixtureApplyOverlay(
          sandbox,
          current.applyReceipt.applyRoot,
          current.appSpec.appId,
        )
      : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
    if (appliedAfter.treeDigest !== current.applyReceipt.postTreeDigest)
      result = {
        ok: false,
        receipt: appliedOverlayDriftFailure({
          attempt,
          receipt: result.receipt,
        }),
      };
    if (!result.ok) {
      appBuilderWorkflowState.update((latest) => {
        if (
          latest.phase !== "validation_pending" ||
          latest.validationAttempt.digest !== attempt.digest
        )
          throw new Error(
            "The workflow changed before target-validation failure could be recorded.",
          );
        return {
          ...base,
          phase: "validation_failed",
          validationFailure: result.receipt,
        };
      });
      throw new Error(
        `Target validation entered recovery-required failure ${result.receipt.digest}.`,
      );
    }
    appBuilderWorkflowState.update((latest) => {
      if (
        latest.phase !== "validation_pending" ||
        latest.validationAttempt.digest !== attempt.digest
      )
        throw new Error(
          "The workflow changed before target-validation success could be recorded.",
        );
      return {
        ...base,
        phase: "validated",
        validationReceipt: result.receipt,
      };
    });
    return { ...result.receipt, reused: false };
  },
});
