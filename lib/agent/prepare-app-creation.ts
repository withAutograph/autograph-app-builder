import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import type { ToolContext } from "eve/tools";

import { prepareOrReuseDependencies } from "@/lib/agent/target-dependency-preparation";
import type { DependencyReadyState } from "@/lib/agent/target-dependency-preparation";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import type { TargetIdentityReceipt } from "@/lib/agent/workflow-state";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

export const prepareAppCreation = async (
  { existingAppChanges }: { existingAppChanges?: { path: string; content: string }[] },
  ctx: ToolContext,
) => {
  const state = appBuilderWorkflowState.get();
  if (
    state.phase === "empty" ||
    state.phase === "prepared" ||
    state.phase === "ui_previewed" ||
    state.phase === "ui_accepted"
  ) {
    throw new Error(
      "Finalize the UI and accept a build-ready AppSpec before running target planning.",
    );
  }
  const prepared = await prepareOrReuseDependencies({
    callId: ctx.callId,
    current: state,
    getSandbox: () => ctx.getSandbox(),
  });
  const current: DependencyReadyState = prepared.state;
  const { sandbox } = prepared;
  const execution = targetExecutionBinding(undefined, process.env);
  if (
    current.phase === "planned" ||
    current.phase === "apply_failed" ||
    current.phase === "applied" ||
    current.phase === "validation_pending" ||
    current.phase === "validation_failed" ||
    current.phase === "validated" ||
    current.phase === "reviewed"
  ) {
    return {
      appId: current.appSpec.appId,
      productAcceptance: productAcceptanceObligations(current.appSpec),
      reused: true,
    };
  }

  const binding = {
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    dependencyCacheDigest: execution.dependencyCacheDigest,
    eligibilityDigest: current.workspace.eligibilityDigest,
    imageDigest: execution.imageDigest,
    sourceReceiptDigest: current.sourceReceipt.digest,
    sourceSha: current.workspace.sourceSha,
    sourceTree: current.workspace.sourceTree,
    workspaceDigest: current.workspace.workspaceDigest,
  };
  let identityReceipt: TargetIdentityReceipt | undefined =
    current.phase === "identity_resolved" ? current.identityReceipt : undefined;
  let workflowBeforeProposal = current;
  const result = await executeTargetIdentityAndPlanning({
    appId: current.appSpec.appId,
    appSpecContent: current.appSpec.content,
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    environment: process.env,
    executor: execution.fixture
      ? fixtureTargetCommandExecutor()
      : sandboxTargetCommandExecutor(sandbox),
    existingAppChanges,
    onIdentity(identity) {
      if (identityReceipt !== undefined) {
        return;
      }
      const unsigned = {
        version: 1 as const,
        ...binding,
        identity,
        resolvedByCallId: ctx.callId,
      };
      const recordedIdentityReceipt = {
        ...unsigned,
        digest: sha256(JSON.stringify(unsigned)),
      };
      identityReceipt = recordedIdentityReceipt;
      const identityState = {
        phase: "identity_resolved",
        preparedByCallId: current.preparedByCallId,
        sourceReceipt: current.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
        ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
        appSpec: current.appSpec,
        artifacts: current.artifacts,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: recordedIdentityReceipt,
      } as const;
      updateExactWorkflow({
        expected: current,
        operation: "target identity receipt recording",
        transition: () => identityState,
      });
      workflowBeforeProposal = identityState;
    },
    sandbox,
    sourceReceipt: current.sourceReceipt,
  });
  if (identityReceipt === undefined) {
    throw new Error("Target identity receipt was not recorded.");
  }
  const recordedIdentity = identityReceipt;
  const unsigned = {
    version: 1 as const,
    ...binding,
    contractDigest: result.contractDigest,
    identityDigest: recordedIdentity.digest,
    plannedByCallId: ctx.callId,
    target: result.proposal,
  };
  const proposal = { ...unsigned, digest: sha256(JSON.stringify(unsigned)) };
  updateExactWorkflow({
    expected: workflowBeforeProposal,
    operation: "target proposal recording",
    transition: () => ({
      phase: "planned",
      preparedByCallId: current.preparedByCallId,
      sourceReceipt: current.sourceReceipt,
      version: APP_BUILDER_WORKFLOW_VERSION,
      workspace: current.workspace,
      ...(current.githubSource === undefined ? {} : { githubSource: current.githubSource }),
      appSpec: current.appSpec,
      artifacts: current.artifacts,
      dependencyReceipt: current.dependencyReceipt,
      identityReceipt: recordedIdentity,
      proposal,
    }),
  });
  return {
    appId: current.appSpec.appId,
    productAcceptance: productAcceptanceObligations(current.appSpec),
    reused: false,
  };
};
