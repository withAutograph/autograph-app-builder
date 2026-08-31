import { defineTool } from "eve/tools";
import { z } from "zod";

import { exactPrototypeArtifact } from "@/lib/agent/prototype-artifacts";
import { inspectTargetExecutionReadiness } from "@/lib/agent/target-execution";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  assertExactWorkflowState,
  assertUpstreamMutationAllowed,
} from "@/lib/agent/workflow-state";
import {
  assertCurrentTargetApplyReceipt,
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
} from "@/lib/repository/target-apply";
import { planningOverlayRoot } from "@/lib/repository/dependency-cache";
import {
  appliedOverlayDriftFailure,
  assertReusableTargetValidationReceipt,
  assertTargetValidationSourceBindings,
  createTargetValidationAttempt,
  executeProposalBoundValidation,
  fixtureValidationCommandExecutor,
  sandboxValidationCommandExecutor,
  verifyTargetValidationProtectedTrees,
} from "@/lib/repository/target-validation";
import { hasTestCapability } from "@/lib/testing/test-capability";
import { inspectSourceBoundSandboxWorkspace } from "@/lib/repository/arrusted-template";

export default defineTool({
  description:
    "Automatically run only the two fixed target validation commands against independent copies of the exact applied tree. This internal operation records a durable pass or recovery-required failure receipt; it does not review or publish, and it detects drift in protected source, cache, planning, and applied bindings.",
  inputSchema: z.object({
    expectedApplyDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  async execute({ expectedApplyDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    assertUpstreamMutationAllowed(current, "target proposal validation");
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
    assertCurrentTargetApplyReceipt(current.applyReceipt);
    if (
      current.applyReceipt.sourceReceiptDigest !== current.sourceReceipt.digest
    )
      throw new Error(
        "The target apply receipt no longer matches its durable source receipt.",
      );
    if (current.applyReceipt.appSpecPath !== current.appSpec.artifactPath)
      throw new Error(
        "The accepted AppSpec path changed before target validation.",
      );
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    const sandbox = await ctx.getSandbox();
    await inspectSourceBoundSandboxWorkspace({
      sandbox,
      receipt: current.sourceReceipt,
      expectedWorkspace: current.workspace,
    });
    const fixture = hasTestCapability("simulated-target");
    const attempt =
      current.phase === "applied"
        ? createTargetValidationAttempt(current.applyReceipt, ctx.callId)
        : undefined;
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
    if (attempt !== undefined)
      appBuilderWorkflowState.update((latest) => {
        assertExactWorkflowState(
          latest,
          current,
          "target validation attempt recording",
        );
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
      const inspect = (root: string) =>
        fixture
          ? inspectFixtureApplyOverlay(sandbox, root, current.appSpec.appId)
          : inspectApplyOverlay(sandbox, root);
      const [applied, planning, prepared] = await Promise.all([
        inspect(current.applyReceipt.applyRoot),
        inspect(
          `/workspace/${planningOverlayRoot(current.appSpec.artifactRevision)}`,
        ),
        inspect(current.workspace.workspacePath),
      ]);
      assertReusableTargetValidationReceipt({
        apply: current.applyReceipt,
        validation: current.validationReceipt,
        expectedAppSpecPath: current.appSpec.artifactPath,
        appliedTreeDigest: applied.treeDigest,
        planningTreeDigest: planning.treeDigest,
        preparedTreeDigest: prepared.treeDigest,
      });
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
    const prepared = fixture
      ? await inspectFixtureApplyOverlay(
          sandbox,
          current.workspace.workspacePath,
          current.appSpec.appId,
        )
      : await inspectApplyOverlay(sandbox, current.workspace.workspacePath);
    assertTargetValidationSourceBindings({
      apply: current.applyReceipt,
      planningTreeDigest: planning.treeDigest,
      preparedTreeDigest: prepared.treeDigest,
    });
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
        const expectedPending = {
          ...base,
          phase: "validation_pending" as const,
          validationAttempt: attempt,
        };
        await verifyTargetValidationProtectedTrees({
          sandbox,
          apply: current.applyReceipt,
          planningRoot,
          preparedRoot: current.workspace.workspacePath,
          assertWorkflowState: () =>
            assertExactWorkflowState(
              latest,
              expectedPending,
              "target validation protected-state check",
            ),
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
        });
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
        const expectedPending = {
          ...base,
          phase: "validation_pending" as const,
          validationAttempt: attempt,
        };
        assertExactWorkflowState(
          latest,
          expectedPending,
          "target validation failure recording",
        );
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
      const expectedPending = {
        ...base,
        phase: "validation_pending" as const,
        validationAttempt: attempt,
      };
      assertExactWorkflowState(
        latest,
        expectedPending,
        "target validation success recording",
      );
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
