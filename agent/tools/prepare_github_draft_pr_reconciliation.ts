/* oxlint-disable unicorn/filename-case -- Eve derives the public tool identifier from this existing filename. */
import { isDeepStrictEqual } from "node:util";
import { resolveDraftReviewedWorkflow } from "@/lib/agent/draft-reviewed-lineage";
import { observeNormalizedChangeSet } from "./change_set_status";
import { hostedOperatorCallbackExecution } from "@/lib/provisioning/hosted-operator-callback-owner";
import { setBuilderSandboxNetworkPolicy } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
import type { ToolContext } from "eve/tools";
import {
  preparePublishedDraftReconciliation,
  draftInspectionRecoveryForSession,
  OwnedDraftReviewRefreshRequiredError,
} from "@/lib/agent/prepare-published-draft-repair";
import {
  draftPreparationPrerequisiteDiagnostic,
  draftPrerequisiteMessage,
} from "@/lib/agent/draft-reconciliation-prerequisites";
import { getSourceBoundSandbox } from "@/lib/agent/source-bound-sandbox";
import { z } from "zod";

import { githubPublicationRuntimeForSession } from "@/lib/agent/deployment-github-publication-runtime";
import { repositoryAccessRuntimeForSession } from "@/lib/agent/deployment-repository-access-runtime";
import { publicationContentSourceForReviewedWorkflow } from "@/lib/agent/github-publication-content-source";
import {
  draftReconciliationCompletions,
  draftReconciliationState,
  updateExactDraftReconciliation,
  samePersistedDraftCandidate,
} from "@/lib/agent/draft-reconciliation-state";
import type { DraftReconciliationCandidate } from "@/lib/agent/draft-reconciliation-state";
import {
  appBuilderWorkflowState,
  assertExactWorkflowState,
  invalidateGitHubDestinationReview,
  updateExactWorkflow,
} from "@/lib/agent/workflow-state";
import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import { prepareWithVerifiedGitHubFetchRecovery } from "@/lib/agent/verified-github-fetch-recovery";
import { readPublishedOperatorSourceForSession } from "@/lib/agent/compiled-operator-artifacts";
import { resolveAcceptedAppSpecContent } from "@/lib/agent/accepted-app-spec-content";
import { recoverLegacyAppSpecTransport } from "@/lib/repository/legacy-app-spec-recovery";
import { compactAcceptedPlanningInput } from "@/lib/repository/compact-accepted-planning-input";
import {
  annotateDraftWorktreeRetirementError,
  retireUnusedDraftWorktrees,
} from "@/lib/repository/retire-unused-draft-worktrees";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { prepareDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import type { DraftReconciliationInput } from "@/lib/repository/sandbox-draft-reconciliation";
import { priorResumedBuildDraftProposal } from "@/lib/agent/existing-app-repair-planning";
import { ReviewedPublicationSourceChangedError } from "@/lib/repository/reviewed-publication-source-changed";

const currentReviewRefresh = (input: {
  error: unknown;
  ctx: ToolContext;
  workflow: AppBuilderWorkflowState;
  state: AppBuilderWorkflowState;
  candidate: DraftReconciliationCandidate | null;
  pullRequestNumber: number;
}) => {
  if (!(input.error instanceof ReviewedPublicationSourceChangedError)) {
    return null;
  }
  input.ctx.abortSignal?.throwIfAborted();
  assertExactWorkflowState(
    appBuilderWorkflowState.get(),
    input.workflow,
    "current draft app review refresh",
  );
  if (!samePersistedDraftCandidate(draftReconciliationState.get(), input.candidate)) {
    throw new Error("The draft candidate changed before its app review could be refreshed.");
  }
  if (input.state.phase !== "reviewed") {
    throw input.error;
  }
  if (
    input.error.appId !== input.state.appSpec.appId ||
    input.error.reviewDigest !== input.state.reviewReceipt.digest
  ) {
    throw input.error;
  }
  const { workflow } = input;
  const creationNeedsValidation =
    workflow.phase === "applied" ||
    workflow.phase === "validation_pending" ||
    workflow.phase === "validation_failed";
  const canRefreshReview = workflow.phase === "reviewed" || workflow.phase === "validated";
  if (!creationNeedsValidation && !canRefreshReview) {
    throw input.error;
  }
  const publication =
    input.error instanceof OwnedDraftReviewRefreshRequiredError
      ? input.error.publicationProposalDigest
      : workflow.publishedGitHubDraftProposalDigest;
  if (
    workflow.publishedGitHubDraftProposalDigest !== undefined &&
    publication !== workflow.publishedGitHubDraftProposalDigest
  ) {
    throw input.error;
  }
  if (creationNeedsValidation) {
    return {
      status: "review_refresh_required" as const,
      nextCall: {
        tool: "validate_app_creation" as const,
        input: { implementationFiles: [], validationTarget: "creation-workspace" as const },
      },
      afterValidation: { tool: "prepare_github_draft_review" as const, input: {} },
      afterReview: {
        tool: "prepare_github_draft_pr_reconciliation" as const,
        input: { pullRequestNumber: input.pullRequestNumber },
      },
      recovery:
        "The current creation files need their own repository validation before a fresh app review. Follow nextCall to check that actual checkout, then continue its normal current-app review and this same draft. The isolated candidate and its separate validation remain preserved; no new Build is needed and the eventual update still requires exact approval.",
    };
  }
  const refreshed = invalidateGitHubDestinationReview(workflow);
  if (publication !== undefined) {
    refreshed.publishedGitHubDraftProposalDigest = publication;
  }
  updateExactWorkflow({
    expected: input.workflow,
    operation: "retiring the stale owned draft app review",
    transition: () => refreshed,
  });
  return {
    status: "review_refresh_required" as const,
    nextCall: { tool: "accept_change_set" as const, input: {} },
    afterReview: {
      tool: "prepare_github_draft_pr_reconciliation" as const,
      input: { pullRequestNumber: input.pullRequestNumber },
    },
    recovery:
      "The current app files are preserved. Accept their current change set, then continue this same draft's reconciliation. Its candidate still needs normal validation, review and exact update approval; no new Build is needed.",
  };
};

const assertReconciliationDraftLineage = (input: {
  headBranch: string;
  publishedHeadSha: string | undefined;
  resolvedRef: string;
}): void => {
  if (
    input.resolvedRef !== `refs/heads/${input.headBranch}` &&
    input.publishedHeadSha === undefined
  ) {
    throw new Error(
      "The selected Builder source is not this draft PR branch. Select that branch as the existing app source, then retry reconciliation.",
    );
  }
};

interface CandidateReplayLineage {
  appId: string;
  repositoryId: string;
  pullRequestNumber: number;
  githubSourceDigest: string;
  originalReviewDigest: string;
  headSha: string;
  baseSha: string;
}

const previousCandidateRequest = (
  previous: DraftReconciliationCandidate | null,
  current: CandidateReplayLineage,
): Pick<DraftReconciliationInput, "previousCandidate" | "replayPreviousCandidate"> => {
  if (previous === null) {
    return {};
  }
  return {
    previousCandidate: previous,
    replayPreviousCandidate: [
      previous.appId === current.appId,
      previous.repositoryId === current.repositoryId,
      previous.pullRequestNumber === current.pullRequestNumber,
      previous.githubSourceDigest === current.githubSourceDigest,
      previous.originalReviewDigest === current.originalReviewDigest,
      previous.headSha === current.headSha,
    ].every(Boolean),
  };
};

const candidateRecoveryGuidance = (
  prepared: Awaited<ReturnType<typeof prepareDraftReconciliation>>,
  previous: DraftReconciliationCandidate | null,
): string | undefined => {
  const { preservedCandidateRoot, replayedAppChanges } = prepared;
  if (preservedCandidateRoot !== undefined) {
    return replayedAppChanges === true
      ? `Builder preserved the old candidate at ${preservedCandidateRoot} and reconciled its app repairs and conflict state into this fresh candidate, merging an advanced base with those repairs when needed. Outside-app metadata was not copied. Continue normal conflict resolution and candidate validation; no GitHub update occurred.`
      : `Builder left the old candidate at ${preservedCandidateRoot} untouched and prepared the currently verified draft/base lineage. Old resolutions were not copied across changed source/review lineage. Continue normal conflict resolution and validation; nothing was published.`;
  }
  if (prepared.created && previous !== null) {
    return "Builder rebuilt the private candidate from the currently verified draft and base because its saved checkout was unavailable. Old uncommitted repairs cannot be assumed to survive. Continue normal conflict resolution and validation. Only the later outward GitHub update requires publication approval.";
  }
  return undefined;
};

const legacyTransportRecoveryResult = (
  status: Awaited<ReturnType<typeof recoverLegacyAppSpecTransport>>["status"],
  reviewed: boolean,
) => {
  if (status === "restored" || (status === "already-restored" && reviewed)) {
    return {
      status: "review_refresh_required",
      recovery:
        "Builder preserved the accepted AppSpec in its private planning input and restored only its proven legacy transport file to the selected source preimage. App files, validation results, and the old merge candidate remain intact. Continue automatically in this same session with change_set_status and accept_change_set to review the current app-only diff, then prepare this existing draft again. No user Continue reply or new dependency setup is needed; the later exact GitHub update still requires publication approval.",
    };
  }
  if (status === "preserved" && reviewed) {
    return {
      status: "needs_repair",
      recovery:
        "Builder preserved the source file and accepted AppSpec because its exact legacy transport preimage could not be proven. The app and old merge candidate remain intact. Inspect the current selected source and retained AppSpec through normal Builder tools, resolve its provenance, then refresh the normal change-set review before preparing this same draft. Do not delete or publish an unknown platform file; technical recovery needs no new user Continue reply.",
    };
  }
  return null;
};

type ReviewedWorkflow = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
type ReconciliationSourceRequest = Parameters<
  Awaited<
    ReturnType<typeof githubPublicationRuntimeForSession>
  >["inspectExistingDraftReconciliationSource"]
>[0];

const reconciliationLineageRequest = (
  state: ReviewedWorkflow,
  original: DraftReconciliationCandidate | null,
  sessionId: string,
): Pick<
  ReconciliationSourceRequest,
  "previousReconciliation" | "publishedReconciliation" | "priorPublishedProposalDigest"
> => {
  const priorPublishedProposalDigest =
    state.publishedGitHubDraftProposalDigest ??
    state.githubDraftProposal?.proposal.digest ??
    priorResumedBuildDraftProposal(state, sessionId)?.digest;
  const previousReconciliation =
    original?.appId === state.appSpec.appId ? original.proposal : undefined;
  const publishedReconciliation =
    original?.appId === state.appSpec.appId ? original.publishedReconciliation : undefined;
  const lineage: Pick<
    ReconciliationSourceRequest,
    "previousReconciliation" | "publishedReconciliation" | "priorPublishedProposalDigest"
  > = {};
  if (previousReconciliation !== undefined) {
    lineage.previousReconciliation = previousReconciliation;
  }
  if (publishedReconciliation !== undefined) {
    lineage.publishedReconciliation = publishedReconciliation;
  }
  if (priorPublishedProposalDigest !== undefined) {
    lineage.priorPublishedProposalDigest = priorPublishedProposalDigest;
  }
  return lineage;
};

const retainedPublishedReconciliation = (
  current: DraftReconciliationCandidate["publishedReconciliation"],
  previous: DraftReconciliationCandidate["publishedReconciliation"],
): Pick<DraftReconciliationCandidate, "publishedReconciliation"> => {
  const retained = current ?? previous;
  return retained === undefined ? {} : { publishedReconciliation: retained };
};

const freshPublishedRepair = (state: AppBuilderWorkflowState): ReviewedWorkflow | null => {
  if (state.phase !== "reviewed") {
    return null;
  }
  if (state.sourceReceipt.sourceKind === "fresh-template" && state.githubSource === undefined) {
    return state;
  }
  return null;
};

const isReviewedExistingSource = (
  state: AppBuilderWorkflowState,
): state is ReviewedWorkflow & { githubSource: NonNullable<ReviewedWorkflow["githubSource"]> } =>
  state.phase === "reviewed" &&
  state.githubSource !== undefined &&
  state.sourceReceipt.sourceKind === "existing-repository";

const prepareOwnedDraftRecovery = async (input: {
  state: AppBuilderWorkflowState;
  ctx: ToolContext;
  pullRequestNumber: number;
  recovery?: "reopen-current-owned-draft";
  restoreInitialAppSource?: boolean;
  repairOriginalPublication?: { discardAddedPaths: string[] };
}) => {
  if (input.restoreInitialAppSource === true && input.recovery !== undefined) {
    throw new Error("Choose either initial source restoration or reopening without replay.");
  }
  const repairOrigin = freshPublishedRepair(input.state);
  if (repairOrigin !== null) {
    return await preparePublishedDraftReconciliation({ ...input, state: repairOrigin });
  }
  if (input.repairOriginalPublication !== undefined && isReviewedExistingSource(input.state)) {
    if (input.repairOriginalPublication.discardAddedPaths.length !== 0) {
      throw new Error("An acquired-source composition repair cannot remove original draft files.");
    }
    if (input.recovery === undefined && input.restoreInitialAppSource !== true) {
      // The existing-repository path re-observes the exact owned first publication.
      return null;
    }
  }
  if (
    input.recovery !== undefined ||
    input.restoreInitialAppSource === true ||
    input.repairOriginalPublication !== undefined
  ) {
    throw new Error(
      "Reopening an owned draft is supported only for this reviewed starter-created app's existing publication. Preserve its source and complete the normal app review before reopening that same owned draft; this mode cannot replace an existing repository selection.",
    );
  }
  return null;
};

export default defineTool({
  description:
    "Fetch the live base and existing draft head into an isolated Builder checkout and prepare a non-force merge candidate. A fresh-template build that already published its own draft uses that verified owned publication and preserves its original starter source; it does not replace the occupied source through resolve_github_source. For an existing-repository app, retry normal preparation without a recovery flag: Builder can reuse this candidate's retained original app-review lineage while the same app, source and apply bindings still match, preserving its unpublished edits. After an approved correction already reached the draft, prepare again from that verified head before recompiling its unissued schema; Builder preserves the corrected source instead of replaying superseded bytes. Explicit recovery: reopen-current-owned-draft applies only to a reviewed starter-created app's verified owned publication; it starts a fresh candidate from that same draft and base without replaying the old review or candidate. Private work is preserved for inspection and deliberate current-candidate edits; normal retries retain this recovery mode. The new candidate needs validation, review and separate exact publication approval. This does not update GitHub. It reports exact app-owned conflict paths and refuses platform-owned conflicts. Builder preserves original approved root registration through the repository's automatic merge result. Set restoreInitialAppSource only to recover a first owned draft that omitted the app package. Builder stages the retained original app and its registration into a fresh private candidate for validation, review, and approved update. If candidate validation reports outside-app metadata changes, run this tool again: Builder preserves the old checkout, creates a fresh private candidate, and carries app repairs across the same verified draft/head/review lineage, merging current base app changes when the base advances. This technical recovery needs no human lockfile edit or new private-worktree approval. For a verified acquired-source first draft with stale composition, use repairOriginalPublication with discardAddedPaths: [] to rebuild shared registration and the lockfile. Only a starter-created app can also select unwanted original additions from its published diff for cleanup. Builder verifies its own original publication and unchanged file ownership, preserves previous private app repairs, reconstructs composition from current target metadata plus this app, and regenerates the lock. Never ask the creator for paths or edit shared files through the app editor. The corrected candidate still needs normal review and exact update approval.",
  // oxlint-disable-next-line eslint/complexity -- Preserve source recovery and the existing independent owner/draft guards.
  async execute(input, ctx) {
    ctx.abortSignal?.throwIfAborted();
    const workflow = appBuilderWorkflowState.get();
    const selectedCandidate = structuredClone(draftReconciliationState.get());
    const state = resolveDraftReviewedWorkflow(workflow, selectedCandidate) ?? workflow;
    let ownedRecovery;
    try {
      ownedRecovery = await prepareOwnedDraftRecovery({ ...input, state, ctx });
    } catch (error) {
      const refresh = currentReviewRefresh({
        ...input,
        error,
        ctx,
        workflow,
        state,
        candidate: selectedCandidate,
      });
      if (refresh !== null) {
        return refresh;
      }
      throw error;
    }
    if (ownedRecovery !== null) {
      return ownedRecovery;
    }
    if (!isReviewedExistingSource(state)) {
      throw new Error(
        draftPrerequisiteMessage(
          draftPreparationPrerequisiteDiagnostic(state),
          "Review the selected existing app and its current source before preparing a draft PR reconciliation.",
        ),
      );
    }
    assertExistingAppReviewScope(
      state.reviewReceipt,
      state.appSpec.appId,
      state.sourceReceipt.sourceKind,
      appBaselineState.get()?.receipt,
    );
    const sandbox = await getSourceBoundSandbox(ctx);
    const accessReceipt = repositoryAccessReceiptState.get();
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- bind all access receipt dimensions to this session and repository.
      accessReceipt === undefined ||
      accessReceipt.sessionId !== ctx.session.id ||
      accessReceipt.repository.repositoryId !== state.githubSource.repository.repositoryId ||
      accessReceipt.repository.owner !== state.githubSource.repository.owner ||
      accessReceipt.repository.name !== state.githubSource.repository.name
    ) {
      throw new Error(
        "Builder cannot fetch the current draft and base: the selected repository no longer matches its verified GitHub access. Reconnect this repository, then retry reconciliation.",
      );
    }
    let acceptedContent: Promise<string> | undefined;
    // oxlint-disable-next-line typescript/promise-function-async -- Preserve the returned promise and synchronous throw behavior.
    const readAcceptedContent = () =>
      (acceptedContent ??= resolveAcceptedAppSpecContent({
        accepted: state.appSpec,
        artifacts: state.artifacts,
        sessionAuth: ctx.session.auth,
        sessionId: ctx.session.id,
      }));
    const retainedCandidate = draftReconciliationState.get();
    const retainedRoots = [
      state.workspace.workspacePath,
      state.applyReceipt.applyRoot,
      ...state.validationReceipt.commands.map((command) => command.validationRoot),
      ...(retainedCandidate === null ? [] : [retainedCandidate.root]),
      ...(retainedCandidate?.preservedWorkspaces ?? []).map((workspace) => workspace.root),
      ...draftReconciliationCompletions.get().map((completion) => completion.root),
    ];
    const workspaceMaintenance = await retireUnusedDraftWorktrees({
      retainedRoots,
      sandbox,
      signal: ctx.abortSignal,
    });
    try {
      await compactAcceptedPlanningInput({
        sandbox,
        appId: state.appSpec.appId,
        artifactRevision: state.appSpec.artifactRevision,
        appSpecDigest: state.appSpec.digest,
        proposalAppSpec: state.proposal.target.contract.appSpec,
        retainedRoots,
        readAcceptedContent,
      });
      const transport = await recoverLegacyAppSpecTransport({
        sandbox,
        sessionId: ctx.session.id,
        repository: state.githubSource.repository,
        appId: state.appSpec.appId,
        artifactRevision: state.appSpec.artifactRevision,
        appSpecDigest: state.appSpec.digest,
        apply: state.applyReceipt,
        baseline: appBaselineState.get(),
        readAcceptedContent,
      });
      const legacyTransportPath = `.config/app-specs/${state.appSpec.appId}.md`;
      const reviewedTransport = state.reviewReceipt.changes.some(
        (change) =>
          change.path === legacyTransportPath && change.after?.digest === state.appSpec.digest,
      );
      const recovery = legacyTransportRecoveryResult(transport.status, reviewedTransport);
      if (recovery !== null) {
        return { ...recovery, workspaceMaintenance };
      }
      const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
      const original = draftReconciliationState.get();
      const lineage = reconciliationLineageRequest(state, original, ctx.session.id);
      const source = await runtime.inspectExistingDraftReconciliationSource({
        ...lineage,
        firstPublicationAppId: state.appSpec.appId,
        recovery: draftInspectionRecoveryForSession({
          ctx,
          appId: state.appSpec.appId,
          appSpecDigest: state.appSpec.digest,
          root: state.applyReceipt.applyRoot,
          pullRequestNumber: input.pullRequestNumber,
          priorPublishedProposalDigest: lineage.priorPublishedProposalDigest,
        }),
        readPublishedSource: async (draft) =>
          await readPublishedOperatorSourceForSession({
            appId: state.appSpec.appId,
            appSpecDigest: state.appSpec.digest,
            root: state.applyReceipt.applyRoot,
            callId: ctx.callId,
            sessionAuth: ctx.session.auth,
            adapterSessionId: ctx.session.id,
            callbackExecution: hostedOperatorCallbackExecution(ctx.session),
            signal: ctx.abortSignal,
            lookup: {
              repositoryId: draft.repositoryId,
              branch: draft.headBranch,
              gitSha: draft.headSha,
              gitTree: draft.headTree,
            },
          }),
        name: state.githubSource.repository.name,
        owner: state.githubSource.repository.owner,
        pullRequestNumber: input.pullRequestNumber,
        repositoryId: state.githubSource.repository.repositoryId,
      });
      assertReconciliationDraftLineage({
        headBranch: source.draft.headBranch,
        publishedHeadSha: source.publishedHeadSha,
        resolvedRef: state.githubSource.resolvedRef,
      });
      const { changeSet } = await observeNormalizedChangeSet({
        sandbox,
        state,
        destinationReview: "observe-current-edits",
      });
      ctx.abortSignal?.throwIfAborted();
      assertExactWorkflowState(
        appBuilderWorkflowState.get(),
        workflow,
        "draft app review observation",
      );
      if (!samePersistedDraftCandidate(draftReconciliationState.get(), selectedCandidate)) {
        throw new Error("The draft candidate changed during app review observation.");
      }
      if (changeSet.digest !== state.reviewReceipt.changeSetDigest) {
        throw new ReviewedPublicationSourceChangedError({
          appId: state.appSpec.appId,
          reviewDigest: state.reviewReceipt.digest,
        });
      }
      // A provider-proved update from this exact retained review supersedes the
      // original private bytes. Replaying them would undo the approved update.
      const publishedCorrection = source.publishedReconciliation;
      const publicationAlreadyContainsReview =
        publishedCorrection !== undefined &&
        source.publishedHeadSha === source.draft.headSha &&
        draftReconciliationCompletions
          .get()
          .some(
            (completion) =>
              completion.preparation === "sealed-before-approval" &&
              completion.appId === state.appSpec.appId &&
              completion.appReview.digest === state.reviewReceipt.digest &&
              isDeepStrictEqual(completion.proposal, publishedCorrection),
          );
      let unpublished: DraftReconciliationInput["unpublished"];
      if (state.reviewReceipt.changes.length !== 0 && !publicationAlreadyContainsReview) {
        const changes = { changes: state.reviewReceipt.changes };
        const prior: Pick<
          NonNullable<DraftReconciliationInput["unpublished"]>,
          "priorPublishedHeadSha"
        > = {};
        if (source.publishedHeadSha !== undefined) {
          prior.priorPublishedHeadSha = source.publishedHeadSha;
        }
        unpublished = {
          ...changes,
          ...prior,
          contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
          reviewDigest: state.reviewReceipt.digest,
        };
      }
      const request: DraftReconciliationInput = {
        appId: state.appSpec.appId,
        baseBranch: source.draft.baseBranch,
        baseSha: source.base.headSha,
        headBranch: source.draft.headBranch,
        headSha: source.draft.headSha,
        repository: {
          name: state.githubSource.repository.name,
          owner: state.githubSource.repository.owner,
        },
        sandbox,
      };
      if (unpublished !== undefined) {
        request.unpublished = unpublished;
      }
      if (source.ownedPublication !== undefined) {
        request.ownedPublication = source.ownedPublication;
      }
      const replay = previousCandidateRequest(original, {
        appId: state.appSpec.appId,
        repositoryId: state.githubSource.repository.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        githubSourceDigest: state.githubSource.digest,
        originalReviewDigest: state.reviewReceipt.digest,
        headSha: source.draft.headSha,
        baseSha: source.base.headSha,
      });
      Object.assign(request, replay);
      const retainedRepair =
        replay.replayPreviousCandidate === true ? original?.originalPublicationRepair : undefined;
      const compositionRepair = input.repairOriginalPublication ?? retainedRepair;
      if (compositionRepair !== undefined) {
        const publication = source.ownedPublication?.publication;
        if (
          compositionRepair.discardAddedPaths.length !== 0 ||
          publication?.branchSha !== source.draft.headSha ||
          publication?.branchTree !== source.draft.headTree
        ) {
          throw new Error(
            "Composition repair requires this app's verified original first-draft head and an empty cleanup selection.",
          );
        }
        request.originalPublicationRepair = compositionRepair;
      }
      const accessRuntime = await repositoryAccessRuntimeForSession(ctx.session.auth);
      const { prepared, retriedGitFetch } = await prepareWithVerifiedGitHubFetchRecovery({
        acquireCredential: async () =>
          await accessRuntime.acquireExistingSourceCredential({
            installationId: accessReceipt.scope.installationId,
            repository: {
              name: accessReceipt.repository.name,
              owner: accessReceipt.repository.owner,
              repositoryId: accessReceipt.repository.repositoryId,
            },
            sessionId: accessReceipt.sessionId,
          }),
        prepare: async () => await prepareDraftReconciliation(request),
        sandbox: {
          setNetworkPolicy: async (policy) => {
            await setBuilderSandboxNetworkPolicy(sandbox, policy);
          },
        },
      });
      const {
        created: _created,
        preservedCandidateRoot,
        replayedAppChanges: _replayed,
        ...preparedCandidate
      } = prepared;
      void _created;
      void _replayed;
      const preservedWorkspaces = [...(original?.preservedWorkspaces ?? [])];
      if (original !== null && preservedCandidateRoot === original.root) {
        preservedWorkspaces.push({
          kind: "draft-candidate",
          root: original.root,
          reviewDigest: original.originalReviewDigest,
        });
      }
      const candidate = {
        ...preparedCandidate,
        ...retainedPublishedReconciliation(
          source.publishedReconciliation,
          lineage.publishedReconciliation,
        ),
        githubSourceDigest: state.githubSource.digest,
        originalReviewDigest: state.reviewReceipt.digest,
        reviewedLineage: structuredClone(state),
        pullRequestNumber: input.pullRequestNumber,
        repositoryId: state.githubSource.repository.repositoryId,
        version: 1 as const,
      };
      updateExactDraftReconciliation({
        expected: original,
        operation: "preparing the isolated merge candidate",
        transition: () =>
          preservedWorkspaces.length === 0 ? candidate : { ...candidate, preservedWorkspaces },
      });
      const result = {
        baseSha: prepared.baseSha,
        conflicts: prepared.conflicts,
        headSha: prepared.headSha,
        root: prepared.root,
        status: prepared.conflicts.length === 0 ? "ready_for_validation" : "needs_resolution",
        workspaceMaintenance,
      };
      const output: typeof result & {
        recovery?: string;
        gitTransportRecovery?: string;
      } = result;
      const candidateRecovery = candidateRecoveryGuidance(prepared, original);
      if (candidateRecovery !== undefined) {
        output.recovery = candidateRecovery;
      }
      if (retriedGitFetch) {
        output.gitTransportRecovery =
          "The first sandbox Git fetch was rejected even though GitHub installation access was verified. Builder reacquired the installation credential and the private fetch succeeded on retry.";
      }
      return output;
    } catch (error) {
      const refresh = currentReviewRefresh({
        ...input,
        error,
        ctx,
        workflow,
        state,
        candidate: selectedCandidate,
      });
      if (refresh !== null) {
        return refresh;
      }
      annotateDraftWorktreeRetirementError(error, workspaceMaintenance, ctx.abortSignal);
      throw error;
    }
  },
  inputSchema: z.strictObject({
    pullRequestNumber: z.number().int().positive(),
    recovery: z.literal("reopen-current-owned-draft").optional(),
    restoreInitialAppSource: z.boolean().optional(),
    repairOriginalPublication: z
      .strictObject({ discardAddedPaths: z.array(z.string().min(1)) })
      .optional(),
  }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
