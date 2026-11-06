import { z } from "zod";
import { LocalPlanningSourcePrerequisiteError } from "../repository/local-planning-source-prerequisite";
import {
  recordLocalSourcePrerequisite,
  resolveLocalSourcePrerequisite,
} from "./local-source-prerequisite-state";
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
const observe = async (current: SourceWorkflow) => {
  const receipt = await developmentSourceReceipt(current.sourceReceipt.sourceKind);
  if (receipt === undefined) {
    throw new Error("The current local planning source is unavailable.");
  }
  const baseline = localPlanningSourceBase(current);
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
  return { capture, changed, receipt };
};
export const refreshLocalPlanningSource = async (
  ctx: Pick<ToolContext, "callId" | "getSandbox"> &
    Partial<Pick<ToolContext, "abortSignal">> & {
      session: { auth: unknown; id: string; ownerRunId?: string; ownerAnchorRunId?: string };
    },
): Promise<Awaited<ReturnType<typeof getSourceBoundSandbox>> | undefined> => {
  const current = appBuilderWorkflowState.get();
  if (!localWorkflow(current) || !settledPhases.has(current.phase)) {
    return undefined;
  }
  const observed = await observe(current);
  try {
    if (!observed.changed) {
      resolveLocalSourcePrerequisite(current, ctx.session.id, ctx.callId);
      return undefined;
    }
    // Native transport history identifies the retained overlay only when reconciliation is needed.
    const transportRequest = {
      expected: {
        reconciliation: {
          appId: current.appSpec.appId,
          currentWorkspace: current.workspace,
          history: localPlanningSourceHistory.get(),
          sourceReceipt: current.sourceReceipt,
        },
        sourcePath: current.sourceReceipt.sourcePath,
        workspaceId: current.workspace.workspaceId,
        workspacePath: current.workspace.workspacePath,
      },
      sessionId: ctx.session.id,
      signal: ctx.abortSignal,
    };
    if (ctx.session.ownerAnchorRunId !== undefined) {
      transportRequest.ownerAnchorRunId = ctx.session.ownerAnchorRunId;
    }
    if (ctx.session.ownerRunId !== undefined) {
      transportRequest.ownerRunId = ctx.session.ownerRunId;
    }
    const completedTransport = await readCompletedLocalSourceTransport(transportRequest);
    const baseline = localPlanningSourceBase(current, completedTransport);
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
    const reconcileInput = {
      appId: current.appSpec.appId,
      assertCurrent,
      callId: ctx.callId,
      capture: observed.capture,
      originalSourceSha: baseline.sourceSha,
      originalWorkspaceDigest: baseline.workspaceDigest,
      receipt: observed.receipt,
      sandbox,
      sessionId: ctx.session.id,
      workspaceId: baseline.workspaceId,
    };
    if (completedTransport?.requiresCurrentManifestReadback) {
      reconcileInput.verifyCurrentManifest = current.workspace;
    }
    if (baseline.sourceOverlay !== undefined) {
      reconcileInput.sourceOverlay = baseline.sourceOverlay;
    }
    const reconciled = await reconcileLocalPlanningSource(reconcileInput);
    assertCurrent();
    const record: LocalPlanningSourceReceipt = {
      acceptedAppSpecDigest: current.appSpec.digest,
      appId: current.appSpec.appId,
      checkpointRef: reconciled.checkpointRef,
      previousSourceReceiptDigest: current.sourceReceipt.digest,
      previousWorkspaceDigest: baseline.workspaceDigest,
      privateSourceCommit: reconciled.sourceSha,
      reconciledByCallId: ctx.callId,
      sourceReceiptDigest: observed.receipt.digest,
      sourceSnapshotTree: reconciled.sourceSnapshotTree,
      workspaceDigest: reconciled.workspace.workspaceDigest,
      workspaceId: reconciled.workspace.workspaceId,
    };
    if ("restoredOriginalBase" in reconciled && reconciled.restoredOriginalBase !== undefined) {
      record.restoredOriginalBase = z
        .strictObject({
          originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
          sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
          sourceTree: z.string().regex(/^[a-f0-9]{40}$/u),
        })
        .parse(reconciled.restoredOriginalBase);
    }
    if (baseline.sourceOverlay !== undefined) {
      record.recognizedSourceOverlay = baseline.sourceOverlay;
    }
    if ("applyReceipt" in current) {
      record.previousApplyDigest = current.applyReceipt.digest;
    }
    if ("proposal" in current) {
      record.previousProposalDigest = current.proposal.digest;
    }
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "record the reconciled local planning input");
      const nextState = {
        appSpec: current.appSpec,
        artifacts: current.artifacts,
        phase: "app_spec_accepted",
        preparedByCallId: ctx.callId,
        sourceReceipt: observed.receipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: reconciled.workspace,
      };
      if (current.checkoutDependencyAttempts !== undefined) {
        nextState.checkoutDependencyAttempts = current.checkoutDependencyAttempts;
      }
      return nextState;
    });
    sourceWorkflowState.update(() => ({
      phase: "reviewed",
      receipt: observed.receipt,
      version: APP_BUILDER_SOURCE_VERSION,
    }));
    localPlanningSourceHistory.update((history) => [...history, record]);
    resolveLocalSourcePrerequisite(current, ctx.session.id, ctx.callId);
    return sandbox;
  } catch (error) {
    if (error instanceof LocalPlanningSourcePrerequisiteError) {
      recordLocalSourcePrerequisite({
        callId: ctx.callId,
        originalSourceSha: error.originalSourceSha,
        originalWorkspaceDigest: error.originalWorkspaceDigest,
        sessionId: ctx.session.id,
        state: current,
      });
    }
    throw error;
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
    appId: record.appId,
    appSpecDigest: record.acceptedAppSpecDigest,
    checkpointRef: record.checkpointRef,
    kind: "local-source-reconciliation-v1",
    previousApplyDigest: record.previousApplyDigest,
    previousProposalDigest: record.previousProposalDigest,
    previousSourceReceiptDigest: record.previousSourceReceiptDigest,
    previousWorkspaceDigest: record.previousWorkspaceDigest,
    reconciledByCallId: record.reconciledByCallId,
    sourceReceiptDigest: record.sourceReceiptDigest,
    sourceSnapshotTree: record.sourceSnapshotTree,
    workspaceDigest: record.workspaceDigest,
    workspaceId: record.workspaceId,
  });
};
