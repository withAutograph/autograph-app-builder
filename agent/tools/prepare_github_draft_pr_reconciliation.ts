import { setBuilderSandboxNetworkPolicy } from "../../lib/sandbox/builder-sandbox";
import { defineTool } from "eve/tools";
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
} from "@/lib/agent/draft-reconciliation-state";
import type { DraftReconciliationCandidate } from "@/lib/agent/draft-reconciliation-state";
import { appBuilderWorkflowState } from "@/lib/agent/workflow-state";
import type { AppBuilderWorkflowState } from "@/lib/agent/workflow-state";
import { repositoryAccessReceiptState } from "@/lib/agent/repository-access-state";
import { prepareWithVerifiedGitHubFetchRecovery } from "@/lib/agent/verified-github-fetch-recovery";
import { readPublishedOperatorSourceForSession } from "@/lib/agent/compiled-operator-artifacts";
import { resolveAcceptedAppSpecContent } from "@/lib/agent/accepted-app-spec-content";
import { recoverLegacyAppSpecTransport } from "@/lib/repository/legacy-app-spec-recovery";
import { compactAcceptedPlanningInput } from "@/lib/repository/compact-accepted-planning-input";
import { retireUnusedDraftWorktrees } from "@/lib/repository/retire-unused-draft-worktrees";
import { appBaselineState } from "@/lib/agent/app-baseline-state";
import { assertExistingAppReviewScope } from "@/lib/repository/reviewed-change-set";
import { prepareDraftReconciliation } from "@/lib/repository/sandbox-draft-reconciliation";
import type { DraftReconciliationInput } from "@/lib/repository/sandbox-draft-reconciliation";

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
): Pick<
  ReconciliationSourceRequest,
  "previousReconciliation" | "publishedReconciliation" | "priorPublishedProposalDigest"
> => {
  const priorPublishedProposalDigest =
    state.publishedGitHubDraftProposalDigest ?? state.githubDraftProposal?.proposal.digest;
  const previousReconciliation =
    original?.appId === state.appSpec.appId ? original.proposal : undefined;
  const publishedReconciliation =
    original?.appId === state.appSpec.appId ? original.publishedReconciliation : undefined;
  return {
    ...(previousReconciliation === undefined ? {} : { previousReconciliation }),
    ...(publishedReconciliation === undefined ? {} : { publishedReconciliation }),
    ...(priorPublishedProposalDigest === undefined ? {} : { priorPublishedProposalDigest }),
  };
};

const retainedPublishedReconciliation = (
  current: DraftReconciliationCandidate["publishedReconciliation"],
  previous: DraftReconciliationCandidate["publishedReconciliation"],
): Pick<DraftReconciliationCandidate, "publishedReconciliation"> => {
  const retained = current ?? previous;
  return retained === undefined ? {} : { publishedReconciliation: retained };
};

export default defineTool({
  description:
    "Fetch the live base and existing draft head into an isolated Builder checkout and prepare a non-force merge candidate. This does not update GitHub. It reports exact app-owned conflict paths and refuses platform-owned conflicts. If candidate validation reports outside-app metadata changes, run this tool again: Builder preserves the old checkout, creates a fresh private candidate, and carries app repairs across the same verified draft/head/review lineage, merging current base app changes when the base advances. This technical recovery needs no human lockfile edit or new private-worktree approval.",
  async execute(input, ctx) {
    const state = appBuilderWorkflowState.get();
    if (
      state.phase !== "reviewed" ||
      state.githubSource === undefined ||
      state.sourceReceipt.sourceKind !== "existing-repository"
    ) {
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
      ...draftReconciliationCompletions.get().map((completion) => completion.root),
    ];
    await retireUnusedDraftWorktrees({ sandbox, retainedRoots, signal: ctx.abortSignal });
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
      return recovery;
    }
    const runtime = await githubPublicationRuntimeForSession(ctx.session.auth);
    const original = draftReconciliationState.get();
    const lineage = reconciliationLineageRequest(state, original);
    const source = await runtime.inspectExistingDraftReconciliationSource({
      ...lineage,
      readPublishedSource: async (draft) =>
        await readPublishedOperatorSourceForSession({
          appId: state.appSpec.appId,
          appSpecDigest: state.appSpec.digest,
          root: state.applyReceipt.applyRoot,
          callId: ctx.callId,
          sessionAuth: ctx.session.auth,
          adapterSessionId: ctx.session.id,
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
    const unpublished =
      state.reviewReceipt.changes.length === 0
        ? undefined
        : {
            changes: state.reviewReceipt.changes,
            ...(source.publishedHeadSha === undefined
              ? {}
              : { priorPublishedHeadSha: source.publishedHeadSha }),
            contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
            reviewDigest: state.reviewReceipt.digest,
          };
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
    Object.assign(
      request,
      previousCandidateRequest(original, {
        appId: state.appSpec.appId,
        repositoryId: state.githubSource.repository.repositoryId,
        pullRequestNumber: input.pullRequestNumber,
        githubSourceDigest: state.githubSource.digest,
        originalReviewDigest: state.reviewReceipt.digest,
        headSha: source.draft.headSha,
        baseSha: source.base.headSha,
      }),
    );
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
      preservedCandidateRoot: _preserved,
      replayedAppChanges: _replayed,
      ...preparedCandidate
    } = prepared;
    void _created;
    void _preserved;
    void _replayed;
    const candidate = {
      ...preparedCandidate,
      ...retainedPublishedReconciliation(
        source.publishedReconciliation,
        lineage.publishedReconciliation,
      ),
      githubSourceDigest: state.githubSource.digest,
      originalReviewDigest: state.reviewReceipt.digest,
      pullRequestNumber: input.pullRequestNumber,
      repositoryId: state.githubSource.repository.repositoryId,
      version: 1 as const,
    };
    updateExactDraftReconciliation({
      expected: original,
      operation: "preparing the isolated merge candidate",
      transition: () => candidate,
    });
    const result = {
      baseSha: prepared.baseSha,
      conflicts: prepared.conflicts,
      headSha: prepared.headSha,
      root: prepared.root,
      status: prepared.conflicts.length === 0 ? "ready_for_validation" : "needs_resolution",
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
  },
  inputSchema: z.strictObject({ pullRequestNumber: z.number().int().positive() }),
});
// oxlint-disable github/filenames-match-regex -- Eve tool discovery requires the public snake_case tool name.
