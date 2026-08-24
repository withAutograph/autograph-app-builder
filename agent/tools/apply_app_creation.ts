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
  executeProposalBoundApply,
  fixtureApplyCommandExecutor,
  inspectApplyOverlay,
  inspectFixtureApplyOverlay,
  sandboxApplyCommandExecutor,
} from "@/lib/repository/target-apply";

export default defineTool({
  description:
    "Apply the exact approved canonical proposal only inside a fresh builder-owned overlay. This separately approved operation reruns target execution readiness and records a durable apply or recovery-required receipt; it does not validate, review, publish, or mutate the prepared source.",
  inputSchema: z.object({
    expectedProposalDigest: z.string().regex(/^[0-9a-f]{64}$/u),
  }),
  approval: always(),
  async execute({ expectedProposalDigest }, ctx) {
    const current = appBuilderWorkflowState.get();
    if (
      current.phase !== "planned" &&
      current.phase !== "apply_failed" &&
      current.phase !== "applied"
    )
      throw new Error(
        "Derive an exact canonical proposal before requesting target apply.",
      );
    exactPrototypeArtifact(current.artifacts, {
      path: current.appSpec.artifactPath,
      digest: current.appSpec.digest,
      revision: current.appSpec.artifactRevision,
      sessionId: ctx.session.id,
    });
    const sandbox = await ctx.getSandbox();
    const readiness = await inspectTargetExecutionReadiness({
      state: current,
      sandbox,
      expectedProposalDigest,
    });
    if (!readiness.targetCommandReady)
      throw new Error(
        `Target apply is not ready: ${readiness.blockers.join(" ")}`,
      );
    const fixture =
      process.env.APP_BUILDER_TEST_MODEL === "1" &&
      process.env.APP_BUILDER_REAL_SANDBOX !== "1";
    if (current.phase === "apply_failed")
      throw new Error(
        `Target apply is recovery-required after partial failure ${current.applyFailure.digest}; it will not be rerun automatically.`,
      );
    if (current.phase === "applied") {
      const observed = fixture
        ? await inspectFixtureApplyOverlay(
            sandbox,
            current.applyReceipt.applyRoot,
            current.appSpec.appId,
          )
        : await inspectApplyOverlay(sandbox, current.applyReceipt.applyRoot);
      if (observed.treeDigest !== current.applyReceipt.postTreeDigest)
        throw new Error(
          "The applied overlay changed after its durable receipt.",
        );
      return { ...current.applyReceipt, reused: true };
    }

    const binding = {
      sourceSha: current.workspace.sourceSha,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      dependencyReceiptDigest: current.dependencyReceipt.digest,
      identityDigest: current.identityReceipt.digest,
      imageDigest: current.dependencyReceipt.imageDigest,
      dependencyCacheDigest: current.dependencyReceipt.dependencyCacheDigest,
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
      proposal: current.proposal.target,
      appliedByCallId: ctx.callId,
    });
    if (!result.ok) {
      appBuilderWorkflowState.update(() => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "apply_failed",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: current.identityReceipt,
        proposal: current.proposal,
        applyFailure: result.receipt,
      }));
      throw new Error(
        `Target apply entered recovery-required partial failure ${result.receipt.digest}.`,
      );
    }
    appBuilderWorkflowState.update(() => ({
      version: APP_BUILDER_WORKFLOW_VERSION,
      phase: "applied",
      preparedByCallId: current.preparedByCallId,
      workspace: current.workspace,
      artifacts: current.artifacts,
      appSpec: current.appSpec,
      dependencyReceipt: current.dependencyReceipt,
      identityReceipt: current.identityReceipt,
      proposal: current.proposal,
      applyReceipt: result.receipt,
    }));
    return { ...result.receipt, reused: false };
  },
});
