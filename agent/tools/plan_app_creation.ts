import { defineTool } from "eve/tools";
import { z } from "zod";

import {
  prepareOrReuseDependencies,
  type DependencyReadyState,
} from "@/lib/agent/target-dependency-preparation";
import { existingAppChangesSchema } from "@/lib/agent/existing-app-changes";
import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  type TargetIdentityReceipt,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

export default defineTool({
  description:
    "Create the implementation plan for the current product design. It prepares dependencies when needed, then runs the repository's normal planning commands. Repository inspection is best-effort context: ordinary source changes, new files, and differing project layouts do not block planning. This does not publish or otherwise change an external repository.",
  inputSchema: z.object({
    expectedAppSpecDigest: z.string().optional(),
    existingAppChanges: existingAppChangesSchema.optional(),
  }),
  async execute({ expectedAppSpecDigest, existingAppChanges }, ctx) {
    void expectedAppSpecDigest;
    const state = appBuilderWorkflowState.get();
    if (
      state.phase === "empty" ||
      state.phase === "prepared" ||
      state.phase === "ui_previewed" ||
      state.phase === "ui_accepted"
    )
      throw new Error(
        "Finalize the UI and accept a build-ready AppSpec before running target planning.",
      );
    const prepared = await prepareOrReuseDependencies({
      current: state,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      environment: process.env,
      getSandbox: () => ctx.getSandbox(),
    });
    const current: DependencyReadyState = prepared.state;
    const sandbox = prepared.sandbox;
    const execution = targetExecutionBinding(undefined, process.env);
    if (
      current.phase === "planned" ||
      current.phase === "apply_failed" ||
      current.phase === "applied" ||
      current.phase === "validation_pending" ||
      current.phase === "validation_failed" ||
      current.phase === "validated" ||
      current.phase === "reviewed"
    )
      return { ...current.proposal, reused: true };

    const binding = {
      sourceSha: current.workspace.sourceSha,
      sourceTree: current.workspace.sourceTree,
      sourceReceiptDigest: current.sourceReceipt.digest,
      eligibilityDigest: current.workspace.eligibilityDigest,
      workspaceDigest: current.workspace.workspaceDigest,
      imageDigest: execution.imageDigest,
      dependencyCacheDigest: execution.dependencyCacheDigest,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
    };
    let identityReceipt: TargetIdentityReceipt | undefined =
      current.phase === "identity_resolved"
        ? current.identityReceipt
        : undefined;
    let workflowBeforeProposal = current;
    const result = await executeTargetIdentityAndPlanning({
      sandbox,
      executor: execution.fixture
        ? fixtureTargetCommandExecutor()
        : sandboxTargetCommandExecutor(sandbox),
      appId: current.appSpec.appId,
      appSpecContent: current.appSpec.content,
      appSpecDigest: current.appSpec.digest,
      artifactRevision: current.appSpec.artifactRevision,
      existingAppChanges,
      sourceReceipt: current.sourceReceipt,
      environment: process.env,
      onIdentity(identity) {
        if (identityReceipt !== undefined) return;
        const unsigned = {
          version: 1 as const,
          ...binding,
          identity,
          resolvedByCallId: ctx.callId,
        };
        identityReceipt = {
          ...unsigned,
          digest: sha256(JSON.stringify(unsigned)),
        };
        const identityState = {
          version: APP_BUILDER_WORKFLOW_VERSION,
          phase: "identity_resolved",
          preparedByCallId: current.preparedByCallId,
          workspace: current.workspace,
          sourceReceipt: current.sourceReceipt,
          ...(current.githubSource === undefined
            ? {}
            : { githubSource: current.githubSource }),
          artifacts: current.artifacts,
          appSpec: current.appSpec,
          dependencyReceipt: current.dependencyReceipt,
          identityReceipt: identityReceipt!,
        } as const;
        updateExactWorkflow({
          expected: current,
          operation: "target identity receipt recording",
          transition: () => identityState,
        });
        workflowBeforeProposal = identityState;
      },
    });
    if (identityReceipt === undefined)
      throw new Error("Target identity receipt was not recorded.");
    const recordedIdentity = identityReceipt;
    const unsigned = {
      version: 1 as const,
      ...binding,
      identityDigest: recordedIdentity.digest,
      contractDigest: result.contractDigest,
      target: result.proposal,
      plannedByCallId: ctx.callId,
    };
    const proposal = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
    updateExactWorkflow({
      expected: workflowBeforeProposal,
      operation: "target proposal recording",
      transition: () => ({
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "planned",
        preparedByCallId: current.preparedByCallId,
        workspace: current.workspace,
        sourceReceipt: current.sourceReceipt,
        ...(current.githubSource === undefined
          ? {}
          : { githubSource: current.githubSource }),
        artifacts: current.artifacts,
        appSpec: current.appSpec,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: recordedIdentity,
        proposal,
      }),
    });
    return { ...proposal, reused: false };
  },
});
