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
    const completedTransport = await readCompletedLocalSourceTransport({
      sessionId: ctx.session.id,
      ...(ctx.session.ownerRunId === undefined ? {} : { ownerRunId: ctx.session.ownerRunId }),
      ...(ctx.session.ownerAnchorRunId === undefined
        ? {}
        : { ownerAnchorRunId: ctx.session.ownerAnchorRunId }),
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
      signal: ctx.abortSignal,
    });
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
    const reconciled = await reconcileLocalPlanningSource({
      assertCurrent,
      sandbox,
      sessionId: ctx.session.id,
      appId: current.appSpec.appId,
      callId: ctx.callId,
      originalSourceSha: baseline.sourceSha,
      originalWorkspaceDigest: baseline.workspaceDigest,
      workspaceId: baseline.workspaceId,
      ...(completedTransport?.requiresCurrentManifestReadback
        ? { verifyCurrentManifest: current.workspace }
        : {}),
      ...(baseline.sourceOverlay === undefined ? {} : { sourceOverlay: baseline.sourceOverlay }),
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
      previousWorkspaceDigest: baseline.workspaceDigest,
      sourceSnapshotTree: reconciled.sourceSnapshotTree,
      privateSourceCommit: reconciled.sourceSha,
      checkpointRef: reconciled.checkpointRef,
      ...("restoredOriginalBase" in reconciled && reconciled.restoredOriginalBase !== undefined
        ? {
            restoredOriginalBase: z
              .strictObject({
                originalSourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
                sourceSha: z.string().regex(/^[a-f0-9]{40}$/u),
                sourceTree: z.string().regex(/^[a-f0-9]{40}$/u),
              })
              .parse(reconciled.restoredOriginalBase),
          }
        : {}),
      ...(baseline.sourceOverlay === undefined
        ? {}
        : { recognizedSourceOverlay: baseline.sourceOverlay }),
      ...("applyReceipt" in current ? { previousApplyDigest: current.applyReceipt.digest } : {}),
      ...("proposal" in current ? { previousProposalDigest: current.proposal.digest } : {}),
      acceptedAppSpecDigest: current.appSpec.digest,
      reconciledByCallId: ctx.callId,
    };
    appBuilderWorkflowState.update((latest) => {
      assertExactWorkflowState(latest, current, "record the reconciled local planning input");
      return {
        appSpec: current.appSpec,
        artifacts: current.artifacts,
        phase: "app_spec_accepted",
        preparedByCallId: ctx.callId,
        sourceReceipt: observed.receipt,
        version: APP_BUILDER_WORKFLOW_VERSION,
        workspace: reconciled.workspace,
        ...(current.checkoutDependencyAttempts === undefined
          ? {}
          : { checkoutDependencyAttempts: current.checkoutDependencyAttempts }),
      };
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
