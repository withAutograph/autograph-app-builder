import { inspectExistingAppRepair, existingAppRepairHistory } from "./existing-app-repair-planning";
import { applicationSourceImportState } from "./application-source-import-state";
import {
  preparePrivateComputePlanning,
  privateComputeProjection,
} from "./private-compute-planning";
import type { PRIVATE_COMPUTE_PROFILE_ID } from "../sandbox/private-compute-profile";
import { localSourceReconciliationForPlanning } from "./refresh-local-planning-source";
import { resolveLatestFrameworkVersions } from "../repository/framework-upgrade";
import { refreshPlanningSource } from "./refresh-planning-source";
import { productAcceptanceObligations } from "@/lib/agent/product-acceptance";
import type { ExistingAppChange } from "./existing-app-changes";
import {
  resolveAcceptedAppSpecContent,
  resolveAcceptedAppSpecStream,
} from "@/lib/agent/accepted-app-spec-content";
import type { ToolContext } from "eve/tools";

import { prepareOrReuseDependencies } from "@/lib/agent/target-dependency-preparation";
import type { DependencyReadyState } from "@/lib/agent/target-dependency-preparation";

import {
  APP_BUILDER_WORKFLOW_VERSION,
  appBuilderWorkflowState,
  sha256,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import type { AppBuilderWorkflowState, TargetIdentityReceipt } from "@/lib/agent/workflow-state";
import {
  executeTargetIdentityAndPlanning,
  fixtureTargetCommandExecutor,
  sandboxTargetCommandExecutor,
  targetExecutionBinding,
} from "@/lib/repository/target-planning";

interface FrameworkPlanningOptions {
  frameworkUpgradeRequested: boolean;
  resolveFrameworkVersions?: typeof resolveLatestFrameworkVersions;
}

interface PrivateComputePlanningInput {
  callId: string;
  repairChanges?: readonly ExistingAppChange[];
  requested?: typeof PRIVATE_COMPUTE_PROFILE_ID;
  sandbox: Awaited<ReturnType<typeof refreshPlanningSource>>;
  state: AppBuilderWorkflowState;
}

const frameworkPlanningOptions = (fixture: boolean, requested?: "latest", accepted?: "latest") => {
  const options: FrameworkPlanningOptions = {
    frameworkUpgradeRequested: (requested ?? accepted) === "latest",
  };
  if (!fixture) {
    options.resolveFrameworkVersions = resolveLatestFrameworkVersions;
  }
  return options;
};

type ReusableTargetPhase =
  | "planned"
  | "apply_failed"
  | "applied"
  | "validation_pending"
  | "validation_failed"
  | "validated"
  | "reviewed";

const canReusePlannedTarget = (
  state: DependencyReadyState,
): state is Extract<DependencyReadyState, { phase: ReusableTargetPhase }> =>
  [
    "planned",
    "apply_failed",
    "applied",
    "validation_pending",
    "validation_failed",
    "validated",
    "reviewed",
  ].some((phase) => phase === state.phase);

// oxlint-disable-next-line eslint/complexity -- Preserve the existing phase protocol and explicit same-app repair boundary in one producer.
export const prepareAppCreation = async (
  {
    existingAppChanges,
    frameworkUpgrade,
    privateCompute,
  }: {
    existingAppChanges?: ExistingAppChange[];
    frameworkUpgrade?: "latest";
    privateCompute?: typeof PRIVATE_COMPUTE_PROFILE_ID;
  },
  ctx: ToolContext,
) => {
  ctx.abortSignal?.throwIfAborted();
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
  const sandboxForPlanning = await refreshPlanningSource(ctx);
  const planningState = appBuilderWorkflowState.get();
  const repair = await inspectExistingAppRepair({
    changes: existingAppChanges,
    ctx,
    current: planningState,
    sandbox: sandboxForPlanning,
  });
  const computePlanningInput: PrivateComputePlanningInput = {
    callId: ctx.callId,
    requested: privateCompute,
    sandbox: sandboxForPlanning,
    state: planningState,
  };
  if (repair !== undefined) {
    computePlanningInput.repairChanges = existingAppChanges;
  }
  const computeProfile = await preparePrivateComputePlanning(computePlanningInput);
  repair?.assertCurrent();
  const stateForPlanning = appBuilderWorkflowState.get();
  if (
    stateForPlanning.phase === "empty" ||
    stateForPlanning.phase === "prepared" ||
    stateForPlanning.phase === "ui_previewed" ||
    stateForPlanning.phase === "ui_accepted"
  ) {
    throw new Error("The accepted app plan is unavailable after source reconciliation.");
  }
  const prepared = await prepareOrReuseDependencies({
    callId: ctx.callId,
    current: stateForPlanning,
    getSandbox: async () => await Promise.resolve(sandboxForPlanning),
  });
  const current: DependencyReadyState = prepared.state;
  const { sandbox } = prepared;
  const execution = targetExecutionBinding(undefined, process.env);
  if (canReusePlannedTarget(current) && (repair === undefined || repair.reuse)) {
    return {
      appId: current.appSpec.appId,
      productAcceptance: productAcceptanceObligations(current.appSpec),
      reused: true,
      ...privateComputeProjection(current.proposal.target.privateCompute),
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
  const appSpecReference = {
    accepted: current.appSpec,
    artifacts: current.artifacts,
    sessionAuth: ctx.session.auth,
    sessionId: ctx.session.id,
  };
  const appSpecSource: Pick<
    Parameters<typeof executeTargetIdentityAndPlanning>[0],
    "appSpecContent" | "appSpecStream"
  > = {};
  if (current.appSpec.version === 2) {
    appSpecSource.appSpecStream = resolveAcceptedAppSpecStream(appSpecReference);
  } else {
    appSpecSource.appSpecContent = await resolveAcceptedAppSpecContent(appSpecReference);
  }
  const imported = applicationSourceImportState.get();
  if (
    imported !== undefined &&
    (imported.reference.appId !== current.appSpec.appId ||
      imported.importedSessionId !== ctx.session.id ||
      imported.platformSourceReceiptDigest !== current.sourceReceipt.digest)
  ) {
    throw new Error("The app plan must retain its exact imported application source.");
  }
  const planningInput: Parameters<typeof executeTargetIdentityAndPlanning>[0] = {
    appId: current.appSpec.appId,
    appSpecDigest: current.appSpec.digest,
    artifactRevision: current.appSpec.artifactRevision,
    environment: process.env,
    executor: execution.fixture
      ? fixtureTargetCommandExecutor()
      : sandboxTargetCommandExecutor(sandbox),
    localSourceReconciliation: localSourceReconciliationForPlanning(current),
    privateCompute: computeProfile,
    ...frameworkPlanningOptions(
      execution.fixture,
      frameworkUpgrade,
      current.appSpec.frameworkUpgrade,
    ),
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
      if (repair !== undefined) {
        // Keep the settled workflow intact until the entire new proposal is ready.
        return;
      }
      const identityState: Extract<AppBuilderWorkflowState, { phase: "identity_resolved" }> = {
        appSpec: current.appSpec,
        artifacts: current.artifacts,
        dependencyReceipt: current.dependencyReceipt,
        identityReceipt: recordedIdentityReceipt,
        phase: "identity_resolved",
        preparedByCallId: current.preparedByCallId,
        sourceReceipt: current.sourceReceipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: current.workspace,
      };
      if (current.githubSource !== undefined) {
        identityState.githubSource = current.githubSource;
      }
      updateExactWorkflow({
        expected: current,
        operation: "target identity receipt recording",
        transition: () => identityState,
      });
      workflowBeforeProposal = identityState;
    },
    sandbox,
    sourceReceipt: current.sourceReceipt,
  };
  if (appSpecSource.appSpecContent !== undefined) {
    planningInput.appSpecContent = appSpecSource.appSpecContent;
  }
  if (appSpecSource.appSpecStream !== undefined) {
    planningInput.appSpecStream = appSpecSource.appSpecStream;
  }
  if (existingAppChanges !== undefined) {
    planningInput.existingAppChanges = existingAppChanges;
  }
  if (imported !== undefined) {
    planningInput.applicationSourceImport = {
      appId: imported.reference.appId,
      importedSessionId: imported.importedSessionId,
      manifestDigest: imported.reference.manifestDigest,
    };
  }
  const result = await executeTargetIdentityAndPlanning(planningInput);
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
  ctx.abortSignal?.throwIfAborted();
  repair?.assertCurrent();
  const plannedState: Extract<AppBuilderWorkflowState, { phase: "planned" }> = {
    appSpec: current.appSpec,
    artifacts: current.artifacts,
    dependencyReceipt: current.dependencyReceipt,
    identityReceipt: recordedIdentity,
    phase: "planned",
    preparedByCallId: current.preparedByCallId,
    proposal,
    sourceReceipt: current.sourceReceipt,
    version: APP_BUILDER_WORKFLOW_VERSION,
    workspace: current.workspace,
  };
  if (current.githubSource !== undefined) {
    Object.assign(plannedState, { githubSource: current.githubSource });
  }
  updateExactWorkflow({
    expected: workflowBeforeProposal,
    operation: "target proposal recording",
    transition: () => plannedState,
  });
  if (repair?.approvedBase !== undefined) {
    existingAppRepairHistory.update((history) => [
      ...history,
      {
        approvedBase: repair.approvedBase,
        previousWorkflow: current,
        proposalDigest: proposal.digest,
        requestDigest: repair.requestDigest,
        sessionId: ctx.session.id,
      },
    ]);
  }
  return {
    appId: current.appSpec.appId,
    productAcceptance: productAcceptanceObligations(current.appSpec),
    reused: false,
    ...privateComputeProjection(computeProfile),
  };
};
