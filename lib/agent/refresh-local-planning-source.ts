import { readCompletedLocalSourceTransport } from "./local-source-transport-history";
/* oxlint-disable unicorn/no-useless-undefined -- Explicit absent results keep optional workflow returns consistent. */
import { localPlanningSourceBase } from "./local-planning-source-base";
import { localSourceReconciliationSchema } from "../repository/local-source-reconciliation-contract";
import type { ToolContext } from "eve/tools";
import {
  canAutoSelectDevelopmentSource,
  developmentSourceReceipt,
} from "../repository/development-source";
import {
  captureLocalPlanningSource,
  reconcileLocalPlanningSource,
} from "../repository/local-planning-source";
import { localPlanningSourceHistory } from "./local-planning-source-state";
import type { LocalPlanningSourceReceipt } from "./local-planning-source-state";
import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
  APP_BUILDER_WORKFLOW_VERSION,
} from "./workflow-state";
import type { AppBuilderWorkflowState, AcceptedAppSpec } from "./workflow-state";
import { sourceWorkflowState, APP_BUILDER_SOURCE_VERSION } from "./source-state";
import { getSourceBoundSandbox } from "./source-bound-sandbox";

type SourceWorkflow = Extract<AppBuilderWorkflowState, { appSpec: AcceptedAppSpec }>;
const localWorkflow = (current: AppBuilderWorkflowState): current is SourceWorkflow =>
  canAutoSelectDevelopmentSource() && "appSpec" in current && current.githubSource === undefined;
const settledPhases = new Set([
  "app_spec_accepted",
  "dependencies_prepared",
  "identity_resolved",
  "planned",
  "applied",
  "validation_failed",
  "validated",
  "reviewed",
]);
export const LOCAL_SOURCE_REFRESH_GUIDANCE =
  "The local shared source has changed. Call prepare-app-creation to reconcile it with this saved app while retaining its content and data, then continue the normal new-plan review and apply before validation. Original source, approvals and private app work remain saved.";

const observe = async (
  current: SourceWorkflow,
  completedTransport?: Awaited<ReturnType<typeof readCompletedLocalSourceTransport>>,
) => {
  const receipt = await developmentSourceReceipt(current.sourceReceipt.sourceKind);
  if (receipt === undefined) {
    throw new Error("The current local planning source is unavailable.");
  }
  const baseline = localPlanningSourceBase(current, completedTransport);
  const capture = await captureLocalPlanningSource(receipt.sourcePath, baseline.sourceSha);
  const prior = localPlanningSourceHistory
    .get()
    .findLast(
      (entry) =>
        entry.appId === current.appSpec.appId &&
        entry.workspaceId === current.workspace.workspaceId &&
        entry.sourceReceiptDigest === current.sourceReceipt.digest &&
        entry.workspaceDigest === current.workspace.workspaceDigest,
    );
  const changed =
    capture.generation.workspaceDigest !== baseline.workspaceDigest ||
    (prior !== undefined && prior.sourceSnapshotTree !== capture.snapshotTree);
  return { receipt, capture, changed, baseline };
};
/** Observe local input before opening/resuming any Sandbox. Ordinary moving source requests a new inexpensive planning input. */
export const localPlanningSourceRefreshRequirement = async (
  current: AppBuilderWorkflowState,
): Promise<string | undefined> => {
  if (!localWorkflow(current) || !settledPhases.has(current.phase)) {
    return undefined;
  }
  let observed: Awaited<ReturnType<typeof observe>> | undefined;
  try {
    observed = await observe(current);
    return observed.changed ? LOCAL_SOURCE_REFRESH_GUIDANCE : undefined;
  } finally {
    observed?.capture.dispose();
  }
};

export const refreshLocalPlanningSource = async (
  ctx: Pick<ToolContext, "callId" | "getSandbox"> &
    Partial<Pick<ToolContext, "abortSignal">> & {
      session: { auth: unknown; id: string; ownerRunId?: string; ownerAnchorRunId?: string };
    },
  purpose: "planning" | "schema-compilation",
): Promise<Awaited<ReturnType<typeof getSourceBoundSandbox>> | undefined> => {
  const current = appBuilderWorkflowState.get();
  if (!localWorkflow(current) || !settledPhases.has(current.phase)) {
    return undefined;
  }
  const completedTransport = await readCompletedLocalSourceTransport({
    sessionId: ctx.session.id,
    ...(ctx.session.ownerRunId === undefined ? {} : { ownerRunId: ctx.session.ownerRunId }),
    ...(ctx.session.ownerAnchorRunId === undefined
      ? {}
      : { ownerAnchorRunId: ctx.session.ownerAnchorRunId }),
    expected: {
      workspaceId: current.workspace.workspaceId,
      workspacePath: current.workspace.workspacePath,
      sourcePath: current.sourceReceipt.sourcePath,
    },
    signal: ctx.abortSignal,
  });
  const observed = await observe(current, completedTransport);
  try {
    if (!observed.changed) {
      return undefined;
    }
    if (purpose !== "planning") {
      throw new Error(LOCAL_SOURCE_REFRESH_GUIDANCE);
    }
    const assertCurrent = () => {
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        current,
        "reconcile the local shared source",
      );
    };
    assertCurrent();
    const sandbox = await getSourceBoundSandbox(ctx);
    assertCurrent();
    const reconciled = await reconcileLocalPlanningSource({
      assertCurrent,
      sandbox,
      sessionId: ctx.session.id,
      appId: current.appSpec.appId,
      callId: ctx.callId,
      originalSourceSha: observed.baseline.sourceSha,
      originalWorkspaceDigest: observed.baseline.workspaceDigest,
      workspaceId: observed.baseline.workspaceId,
      ...(observed.baseline.sourceOverlay === undefined
        ? {}
        : { sourceOverlay: observed.baseline.sourceOverlay }),
      receipt: observed.receipt,
      capture: observed.capture,
    });
    assertCurrent();
    const record: LocalPlanningSourceReceipt = {
      appId: current.appSpec.appId,
      workspaceId: reconciled.workspace.workspaceId,
      sourceReceiptDigest: observed.receipt.digest,
      previousSourceReceiptDigest: current.sourceReceipt.digest,
      workspaceDigest: reconciled.workspace.workspaceDigest,
      previousWorkspaceDigest: observed.baseline.workspaceDigest,
      sourceSnapshotTree: reconciled.sourceSnapshotTree,
      privateSourceCommit: reconciled.sourceSha,
      checkpointRef: reconciled.checkpointRef,
      ...(observed.baseline.sourceOverlay === undefined
        ? {}
        : { recognizedSourceOverlay: observed.baseline.sourceOverlay }),
      ...("applyReceipt" in current ? { previousApplyDigest: current.applyReceipt.digest } : {}),
      ...("proposal" in current ? { previousProposalDigest: current.proposal.digest } : {}),
      acceptedAppSpecDigest: current.appSpec.digest,
      reconciledByCallId: ctx.callId,
    };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "record the reconciled local planning input");
      return {
        version: APP_BUILDER_WORKFLOW_VERSION,
        phase: "app_spec_accepted",
        appSpec: current.appSpec,
        artifacts: current.artifacts,
        preparedByCallId: ctx.callId,
        sourceReceipt: observed.receipt,
        workspace: reconciled.workspace,
        ...(current.checkoutDependencyAttempts === undefined
          ? {}
          : { checkoutDependencyAttempts: current.checkoutDependencyAttempts }),
      };
    });
    sourceWorkflowState.update(() => ({
      version: APP_BUILDER_SOURCE_VERSION,
      phase: "reviewed",
      receipt: observed.receipt,
    }));
    localPlanningSourceHistory.update((history) => [...history, record]);
    return sandbox;
  } finally {
    observed.capture.dispose();
  }
};

export const localSourceReconciliationForPlanning = (
  current: AppBuilderWorkflowState,
): ReturnType<typeof localSourceReconciliationSchema.parse> | undefined => {
  if (!localWorkflow(current)) {
    return undefined;
  }
  const record = localPlanningSourceHistory
    .get()
    .findLast(
      (entry) =>
        entry.appId === current.appSpec.appId &&
        entry.workspaceId === current.workspace.workspaceId &&
        entry.sourceReceiptDigest === current.sourceReceipt.digest &&
        entry.workspaceDigest === current.workspace.workspaceDigest,
    );
  if (
    record?.previousApplyDigest === undefined ||
    record.previousProposalDigest === undefined ||
    record.acceptedAppSpecDigest !== current.appSpec.digest
  ) {
    return undefined;
  }
  return localSourceReconciliationSchema.parse({
    kind: "local-source-reconciliation-v1",
    appId: record.appId,
    appSpecDigest: record.acceptedAppSpecDigest,
    workspaceId: record.workspaceId,
    previousApplyDigest: record.previousApplyDigest,
    previousProposalDigest: record.previousProposalDigest,
    previousSourceReceiptDigest: record.previousSourceReceiptDigest,
    sourceReceiptDigest: record.sourceReceiptDigest,
    previousWorkspaceDigest: record.previousWorkspaceDigest,
    workspaceDigest: record.workspaceDigest,
    sourceSnapshotTree: record.sourceSnapshotTree,
    checkpointRef: record.checkpointRef,
    reconciledByCallId: record.reconciledByCallId,
  });
};
