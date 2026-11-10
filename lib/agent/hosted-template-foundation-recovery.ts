import { isDeepStrictEqual } from "node:util";
import type { ToolContext } from "eve/tools";
import { reconcileHostedTemplateFoundation } from "../repository/hosted-template-source-reconciliation";
import { assertApprovedPrivateApplySession } from "./private-apply-authority";
import { hostedTemplateFoundationRecoveryHistory } from "./hosted-template-foundation-recovery-state";
import type { HostedTemplateFoundationRecoveryReceipt } from "./hosted-template-foundation-recovery-state";
import { invalidateProductBehaviorEvidence } from "./product-behavior-state";
import { APP_BUILDER_SOURCE_VERSION, sourceWorkflowState } from "./source-state";
import { appBuilderWorkflowState, assertExactWorkflowState } from "./workflow-state";
import type { AppBuilderWorkflowState } from "./workflow-state";
import type { OwnedCompletedAppPublication } from "./github-publication-runtime";

type AppliedWorkflow = Extract<
  AppBuilderWorkflowState,
  // oxlint-disable-next-line sonarjs/max-union-size -- Preserve the four settled states with an existing applied app.
  { phase: "applied" | "validation_failed" | "validated" | "reviewed" }
>;
type RecoveryContext = Pick<ToolContext, "callId" | "getSandbox"> &
  Partial<Pick<ToolContext, "abortSignal">> & { session: { id: string } };

const appliedWorkflow = (state: AppBuilderWorkflowState): state is AppliedWorkflow =>
  state.phase === "applied" ||
  state.phase === "validation_failed" ||
  state.phase === "validated" ||
  state.phase === "reviewed";

const assertRetainedApp = (current: AppliedWorkflow, subject: { appId: string; root: string }) => {
  const { appSpec, proposal, applyReceipt, workspace } = current;
  const sameApp = [
    subject.appId === appSpec.appId,
    subject.root === workspace.workspacePath,
    applyReceipt.applyRoot === subject.root,
    proposal.target.contract.appId === appSpec.appId,
    proposal.appSpecDigest === appSpec.digest,
    proposal.target.contract.appSpec.sha256 === appSpec.digest,
    proposal.target.contract.appSpec.path === appSpec.artifactPath,
    proposal.artifactRevision === appSpec.artifactRevision,
    applyReceipt.appSpecDigest === appSpec.digest,
    applyReceipt.proposalDigest === proposal.digest,
    applyReceipt.appSpecPath === appSpec.artifactPath,
    applyReceipt.artifactRevision === appSpec.artifactRevision,
  ].every(Boolean);
  if (!sameApp) {
    throw new Error("The failed local task does not belong to this approved app and workspace.");
  }
};

const appliedAfterRecovery = (
  current: AppliedWorkflow,
  result: Awaited<ReturnType<typeof reconcileHostedTemplateFoundation>>,
): Extract<AppBuilderWorkflowState, { phase: "applied" }> => {
  const next = {
    ...current,
    phase: "applied" as const,
    sourceReceipt: result.sourceReceipt,
    workspace: result.workspace,
  };
  // These receipts describe the previous source execution/diff. Original Build,
  // applied product, resource ownership and published lineage remain unchanged.
  for (const key of [
    "validationAttempt",
    "validationFailure",
    "validationReceipt",
    "reviewReceipt",
    "githubDraftProposal",
    "existingDraftUpdate",
    "githubDestinationReview",
    "githubDestinationReviewRead",
  ]) {
    Reflect.deleteProperty(next, key);
  }
  return next;
};

/** Recover an actual local failure or an explicitly requested same-app source refresh. Never an admission prerequisite. */
export const recoverHostedTemplateFoundation = async (
  ctx: RecoveryContext,
  subject: { appId: string; root: string },
  reconcile: typeof reconcileHostedTemplateFoundation = reconcileHostedTemplateFoundation,
  publication?: OwnedCompletedAppPublication,
): Promise<boolean> => {
  ctx.abortSignal?.throwIfAborted();
  const current = appBuilderWorkflowState.get();
  if (
    !appliedWorkflow(current) ||
    current.sourceReceipt.sourceKind !== "fresh-template" ||
    current.githubSource !== undefined
  ) {
    return false;
  }
  const source = sourceWorkflowState.get();
  const history = hostedTemplateFoundationRecoveryHistory.get();
  const assertCurrent = () => {
    ctx.abortSignal?.throwIfAborted();
    assertExactWorkflowState(
      appBuilderWorkflowState.get(),
      current,
      "recover the retained template foundation",
    );
    if (
      !isDeepStrictEqual(sourceWorkflowState.get(), source) ||
      !isDeepStrictEqual(hostedTemplateFoundationRecoveryHistory.get(), history)
    ) {
      throw new Error("The template source recovery changed concurrently.");
    }
    assertRetainedApp(current, subject);
    assertApprovedPrivateApplySession({
      appId: current.appSpec.appId,
      appSpecDigest: current.appSpec.digest,
      proposalDigest: current.proposal.digest,
      sessionId: ctx.session.id,
      workspaceId: current.workspace.workspaceId,
    });
  };
  assertCurrent();
  // A completed filesystem transition may precede its Eve CAS. Opening the raw
  // owned session lets the transport replay that transition from its journal.
  const sandbox = await ctx.getSandbox();
  assertCurrent();
  let result: Awaited<ReturnType<typeof reconcileHostedTemplateFoundation>>;
  try {
    result = await reconcile({
      appId: current.appSpec.appId,
      sessionId: ctx.session.id,
      callId: ctx.callId,
      sourceReceipt: current.sourceReceipt,
      workspace: current.workspace,
      sandbox,
      signal: ctx.abortSignal,
      assertCurrent,
    });
  } catch (error) {
    // A known transport outage must never hide a concurrent owner or consent
    // change when the local-task caller preserves the original failed result.
    assertCurrent();
    throw error;
  }
  assertCurrent();
  if (!result.changed) {
    // Legacy completed transitions omitted publication lookup context. A fresh
    // provider proof can fill that optional context without replaying source or
    // reviving validation/review; all original transition fields stay intact.
    if (publication !== undefined) {
      hostedTemplateFoundationRecoveryHistory.update(() =>
        history.map((entry) =>
          // oxlint-disable-next-line sonarjs/expression-complexity -- Only the same completed owner/app/Build/source transition may gain optional ownership lookup context.
          entry.publication === undefined &&
          entry.sessionId === ctx.session.id &&
          entry.appId === current.appSpec.appId &&
          entry.appSpecDigest === current.appSpec.digest &&
          entry.proposalDigest === current.proposal.digest &&
          entry.applyDigest === current.applyReceipt.digest &&
          isDeepStrictEqual(entry.sourceReceipt, current.sourceReceipt) &&
          isDeepStrictEqual(entry.workspace, current.workspace)
            ? { ...entry, publication }
            : entry,
        ),
      );
    }
    return false;
  }
  const sameTransition = [
    result.workspace.workspaceId === current.workspace.workspaceId,
    result.workspace.workspacePath === subject.root,
    result.sourceReceipt.sourceKind === "fresh-template",
    result.provenance.previousSourceReceiptDigest === current.sourceReceipt.digest,
    result.provenance.previousWorkspaceDigest === current.workspace.workspaceDigest,
    result.provenance.previousSourceSha === current.sourceReceipt.sourceSha,
  ].every(Boolean);
  if (!sameTransition) {
    throw new Error("The recovered template foundation belongs to another app workspace.");
  }
  const next = appliedAfterRecovery(current, result);
  const record: HostedTemplateFoundationRecoveryReceipt = structuredClone({
    version: 1 as const,
    appId: current.appSpec.appId,
    sessionId: ctx.session.id,
    workspaceId: current.workspace.workspaceId,
    appSpecDigest: current.appSpec.digest,
    proposalDigest: current.proposal.digest,
    applyDigest: current.applyReceipt.digest,
    previousSourceReceipt: current.sourceReceipt,
    previousWorkspace: current.workspace,
    sourceReceipt: result.sourceReceipt,
    workspace: result.workspace,
    provenance: result.provenance,
    recoveredByCallId: ctx.callId,
  });
  if (publication !== undefined) {
    record.publication = structuredClone(publication);
  }
  assertCurrent();
  // No asynchronous boundary separates these related Eve projections. The
  // transport's durable completed receipt remains resumable until this point.
  appBuilderWorkflowState.update((latest) => {
    assertExactWorkflowState(latest, current, "record the recovered template foundation");
    return next;
  });
  sourceWorkflowState.update(() =>
    source.phase === "empty"
      ? {
          version: APP_BUILDER_SOURCE_VERSION,
          phase: "reviewed",
          receipt: result.sourceReceipt,
        }
      : { ...source, receipt: result.sourceReceipt },
  );
  hostedTemplateFoundationRecoveryHistory.update(() => [...history, record]);
  invalidateProductBehaviorEvidence("source-repair");
  return true;
};
