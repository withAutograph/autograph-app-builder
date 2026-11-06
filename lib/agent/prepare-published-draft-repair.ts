import type { ToolContext } from "eve/tools";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { getSourceBoundSandbox } from "./source-bound-sandbox";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import type { DraftInspectionRecoveryInput } from "./github-publication-runtime";
import type { ExistingDraftObservation } from "../repository/github-draft-update";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import {
  repositoryAccessReceiptSchema,
  repositoryAccessReceiptState,
} from "./repository-access-state";
import { createPublishedDraftRepairSource } from "./published-draft-repair";
import { resolveDraftReviewedWorkflow } from "./draft-reviewed-lineage";
import {
  draftReconciliationCompletions,
  draftReconciliationState,
  publishedDraftRepairCompletions,
  samePersistedDraftCandidate,
  updateExactDraftReconciliation,
} from "./draft-reconciliation-state";
import type {
  DraftReconciliationCandidate,
  PreservedDraftWorkspace,
} from "./draft-reconciliation-state";
import { publicationContentSourceForReviewedWorkflow } from "./github-publication-content-source";
import { readPublishedOperatorSourceForSession } from "./compiled-operator-artifacts";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";
import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import {
  prepareDraftReconciliation,
  preparePublishedDraftRepairCandidate,
} from "../repository/sandbox-draft-reconciliation";
import type { DraftReconciliationInput } from "../repository/sandbox-draft-reconciliation";
import { priorResumedBuildDraftProposal } from "./existing-app-repair-planning";

type Reviewed = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
const PUBLISHED_DRAFT_REPAIR_KIND = "published-draft-repair" as const;
const assertCurrentOrigin = (
  expected: Reviewed,
  expectedCandidate: DraftReconciliationCandidate | null,
): void => {
  const workflow = appBuilderWorkflowState.get();
  const candidate = draftReconciliationState.get();
  if (!samePersistedDraftCandidate(candidate, expectedCandidate)) {
    throw new Error("The draft candidate changed during preparation.");
  }
  const current = resolveDraftReviewedWorkflow(workflow, candidate) ?? workflow;
  if (current.phase !== "reviewed") {
    throw new Error("The app is no longer reviewed for draft repair.");
  }
  const matches = [
    current.sourceReceipt.digest === expected.sourceReceipt.digest,
    current.appSpec.digest === expected.appSpec.digest,
    current.reviewReceipt.digest === expected.reviewReceipt.digest,
    current.applyReceipt.digest === expected.applyReceipt.digest,
  ].every(Boolean);
  if (!matches) {
    throw new Error("The accepted app workflow changed during draft repair preparation.");
  }
};

interface PreparationInput {
  state: Reviewed;
  ctx: ToolContext;
  pullRequestNumber: number;
  recovery?: "reopen-current-owned-draft";
}

/** Rebuild request-local recovery authority from owned workflow metadata, never public arguments. */
export const draftInspectionRecoveryForSession = (input: {
  ctx: ToolContext;
  appId: string;
  appSpecDigest: string;
  root: string;
  pullRequestNumber: number;
  priorPublishedProposalDigest?: string;
}): DraftInspectionRecoveryInput => {
  const candidate = draftReconciliationState.get();
  const sameApp =
    candidate !== null &&
    candidate.appId === input.appId &&
    candidate.pullRequestNumber === input.pullRequestNumber;
  // Sealed candidates and completions precede approval. Only this marker was retained
  // after provider-verified publication; an unverified current proposal cannot prove itself.
  const published = sameApp ? candidate.publishedReconciliation : undefined;
  return {
    priorPublishedProposalDigest: input.priorPublishedProposalDigest,
    readPublishedSource: async (draft) =>
      await readPublishedOperatorSourceForSession({
        adapterSessionId: input.ctx.session.id,
        appId: input.appId,
        appSpecDigest: input.appSpecDigest,
        callId: input.ctx.callId,
        callbackExecution: hostedOperatorCallbackExecution(input.ctx.session),
        lookup: {
          branch: draft.headBranch,
          gitSha: draft.headSha,
          gitTree: draft.headTree,
          repositoryId: draft.repositoryId,
        },
        root: input.root,
        sessionAuth: input.ctx.session.auth,
        signal: input.ctx.abortSignal,
      }),
    reconciliations: published === undefined ? [] : [published],
  };
};

const acquireOwnedPublishedDraft = async (
  input: PreparationInput,
  previous: DraftReconciliationCandidate | null,
) => {
  const { state, ctx } = input;
  assertCurrentOrigin(state, previous);
  const proposalDigest =
    state.publishedGitHubDraftProposalDigest ??
    state.githubDraftProposal?.proposal.digest ??
    priorResumedBuildDraftProposal(state, ctx.session.id)?.digest;
  const savedAccess = repositoryAccessReceiptState.get();
  if (proposalDigest === undefined || savedAccess === undefined) {
    throw new Error(
      "The owned original draft publication or its repository access is unavailable; preserve this session's source and recover its recorded publication.",
    );
  }
  const access = repositoryAccessReceiptSchema.parse(savedAccess);
  if (access.sessionId !== ctx.session.id) {
    throw new Error("The repository access belongs to another session.");
  }
  const runtime = await githubPublicationRuntimeForSession(ctx.session.auth, {
    selectedInstallationId: access.scope.installationId,
  });
  assertCurrentOrigin(state, previous);
  if (runtime.inspectOwnedPublishedDraftRepairSource === undefined) {
    throw new Error("The publication runtime cannot prepare a same-session owned draft repair.");
  }
  const owned = await runtime.inspectOwnedPublishedDraftRepairSource({
    appId: state.appSpec.appId,
    expectedInstallationId: access.scope.installationId,
    publishedProposalDigest: proposalDigest,
    readPublishedSource: async (lookup) =>
      await readPublishedOperatorSourceForSession({
        adapterSessionId: ctx.session.id,
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        callId: ctx.callId,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        lookup,
        root: state.applyReceipt.applyRoot,
        sessionAuth: ctx.session.auth,
        signal: ctx.abortSignal,
      }),
    recovery: draftInspectionRecoveryForSession({
      appId: state.appSpec.appId,
      appSpecDigest: state.appSpec.digest,
      ctx,
      priorPublishedProposalDigest: proposalDigest,
      pullRequestNumber: input.pullRequestNumber,
      root: state.applyReceipt.applyRoot,
    }),
    resolvedByCallId: ctx.callId,
  });
  if (
    owned.draft.number !== input.pullRequestNumber ||
    owned.draft.repositoryId !== access.repository.repositoryId ||
    owned.draft.owner !== access.repository.owner ||
    owned.draft.name !== access.repository.name
  ) {
    throw new Error(
      "The requested draft differs from this app's owned publication and repository access.",
    );
  }
  const repair = createPublishedDraftRepairSource({
    appId: state.appSpec.appId,
    appSpecDigest: state.appSpec.digest,
    draft: owned.draft,
    installationId: access.scope.installationId,
    originSourceReceiptDigest: state.sourceReceipt.digest,
    publicationDigest: owned.publication.digest,
    publicationProposalDigest: owned.proposal.digest,
    source: owned.source,
  });
  assertCurrentOrigin(state, previous);
  return { access, owned, repair, runtime };
};

/** Acquire a second private checkout for this session's actual published app, never replace its starter. */
export const preparePublishedDraftRepair = async (input: PreparationInput) => {
  const { state, ctx } = input;
  const previous = structuredClone(draftReconciliationState.get());
  const { access, owned, repair } = await acquireOwnedPublishedDraft(input, previous);
  const sandbox = await getSourceBoundSandbox(ctx);
  assertCurrentOrigin(state, previous);
  const originAlreadyCarried = publishedDraftRepairCompletions
    .get()
    .some((completion) =>
      [
        owned.draft.headSha !== completion.proposal.expectedHeadSha,
        owned.draft.headTree === completion.review.resolvedTree,
        completion.repair.publicationDigest === repair.publicationDigest,
        completion.repair.originSourceReceiptDigest === repair.originSourceReceiptDigest,
        completion.review.originReviewDigest === state.reviewReceipt.digest,
      ].every(Boolean),
    );
  const unpublished =
    originAlreadyCarried || state.reviewReceipt.changes.length === 0
      ? undefined
      : {
          changes: state.reviewReceipt.changes,
          contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
          priorPublishedHeadSha: owned.publication.branchSha,
          reviewDigest: state.reviewReceipt.digest,
        };
  const accessRuntime = await repositoryAccessRuntimeForSession(ctx.session.auth);
  const { prepared } = await prepareWithVerifiedGitHubFetchRecovery({
    acquireCredential: async () =>
      await accessRuntime.acquireExistingSourceCredential({
        installationId: access.scope.installationId,
        repository: repair.source.repository,
        sessionId: ctx.session.id,
      }),
    prepare: async () => {
      assertCurrentOrigin(state, previous);
      const preparation = {
        appId: repair.appId,
        headBranch: owned.draft.headBranch,
        headSha: owned.draft.headSha,
        repository: repair.source.repository,
        sandbox,
      };
      if (unpublished !== undefined) {
        preparation.unpublished = unpublished;
      }
      if (
        previous?.kind === PUBLISHED_DRAFT_REPAIR_KIND &&
        previous.repair.digest === repair.digest
      ) {
        preparation.previousCandidate = previous;
        preparation.replayPreviousCandidate = true;
      }
      return await preparePublishedDraftRepairCandidate(preparation);
    },
    sandbox: {
      setNetworkPolicy: async (policy) => {
        await setBuilderSandboxNetworkPolicy(sandbox, policy);
      },
    },
  });
  assertCurrentOrigin(state, previous);
  const { publicationScope: _publicationScope, ...preparedRepair } = prepared;
  void _publicationScope;
  const candidate = {
    ...preparedRepair,
    githubSourceDigest: owned.source.digest,
    kind: PUBLISHED_DRAFT_REPAIR_KIND,
    originalReviewDigest: state.reviewReceipt.digest,
    pullRequestNumber: owned.draft.number,
    repair,
    repositoryId: owned.draft.repositoryId,
    reviewedLineage: structuredClone(state),
    version: 1 as const,
  };
  updateExactDraftReconciliation({
    expected: previous,
    operation: "preparing this owned published draft repair",
    transition: () => candidate,
  });
  return {
    baseline: "draft-head" as const,
    conflicts: candidate.conflicts,
    headSha: candidate.headSha,
    kind: PUBLISHED_DRAFT_REPAIR_KIND,
    nextAction:
      "Inspect or format this same draft candidate, validate it, review the app-only draft-head delta, then seal_github_draft_pr_update and request separate update approval. The original fresh source and existing published root metadata remain intact.",
    root: candidate.root,
    status: "ready_for_validation" as const,
  };
};

const samePublishedOrigin = (
  previous: DraftReconciliationCandidate,
  repair: ReturnType<typeof createPublishedDraftRepairSource>,
  reviewDigest: string,
): boolean => {
  const origin =
    previous.kind === PUBLISHED_DRAFT_REPAIR_KIND ? previous.repair : previous.publishedOrigin;
  return (
    origin !== undefined &&
    [
      origin.publicationDigest === repair.publicationDigest,
      origin.publicationProposalDigest === repair.publicationProposalDigest,
      origin.originSourceReceiptDigest === repair.originSourceReceiptDigest,
      origin.installationId === repair.installationId,
      previous.appId === repair.appId,
      previous.repositoryId === repair.draft.repositoryId,
      previous.pullRequestNumber === repair.draft.number,
      previous.originalReviewDigest === reviewDigest,
    ].every(Boolean)
  );
};

const reviewedOriginAlreadyPublished = (
  state: Reviewed,
  owned: Awaited<ReturnType<typeof acquireOwnedPublishedDraft>>["owned"],
  repair: ReturnType<typeof createPublishedDraftRepairSource>,
): boolean => {
  if (owned.proposal.reviewDigest === state.reviewReceipt.digest) {
    return true;
  }
  const repaired = publishedDraftRepairCompletions
    .get()
    .some((completion) =>
      [
        owned.draft.headSha !== completion.proposal.expectedHeadSha,
        owned.draft.headTree === completion.review.resolvedTree,
        completion.repair.publicationDigest === repair.publicationDigest,
        completion.repair.originSourceReceiptDigest === repair.originSourceReceiptDigest,
        completion.review.originReviewDigest === state.reviewReceipt.digest,
      ].every(Boolean),
    );
  return (
    repaired ||
    draftReconciliationCompletions
      .get()
      .some((completion) =>
        [
          owned.draft.headSha !== completion.proposal.expectedHeadSha,
          owned.draft.headTree === completion.review.resolvedTree,
          completion.proposal.priorPublicationDigest === repair.publicationDigest,
          completion.publishedOrigin?.originSourceReceiptDigest ===
            repair.originSourceReceiptDigest,
          completion.appReview.digest === state.reviewReceipt.digest,
        ].every(Boolean),
      )
  );
};

const preservedDraftWorkspaces = (
  state: Reviewed,
  previous: DraftReconciliationCandidate | undefined,
  currentRoot: string,
  preservedCandidateRoot: string | undefined,
): readonly PreservedDraftWorkspace[] => {
  const workspaces: PreservedDraftWorkspace[] = [
    ...(previous?.preservedWorkspaces ?? []),
    ...(preservedCandidateRoot === undefined || preservedCandidateRoot === currentRoot
      ? []
      : [
          {
            kind: "draft-candidate" as const,
            reviewDigest: state.reviewReceipt.digest,
            root: preservedCandidateRoot,
          },
        ]),
    {
      kind: "app-review",
      paths: state.reviewReceipt.changes.flatMap((change) =>
        change.path.startsWith(`apps/${state.appSpec.appId}/`) ? [change.path] : [],
      ),
      reviewDigest: state.reviewReceipt.digest,
      root: state.applyReceipt.applyRoot,
    },
    ...(previous === undefined || previous.root === currentRoot
      ? []
      : [
          {
            kind: "draft-candidate" as const,
            reviewDigest: previous.originalReviewDigest,
            root: previous.root,
          },
        ]),
  ];
  return [
    ...new Map(
      workspaces.map((workspace) => [
        JSON.stringify([workspace.kind, workspace.root, workspace.reviewDigest]),
        workspace,
      ]),
    ).values(),
  ];
};

const reconciliationPreparationLineage = (
  input: PreparationInput,
  previous: DraftReconciliationCandidate | null,
  repair: ReturnType<typeof createPublishedDraftRepairSource>,
) => {
  const sameOrigin =
    previous !== null && samePublishedOrigin(previous, repair, input.state.reviewReceipt.digest);
  const ownedPrevious = sameOrigin ? previous : undefined;
  const recoveryMode = input.recovery ?? ownedPrevious?.recoveryMode;
  const reopenCurrent = recoveryMode === "reopen-current-owned-draft";
  const previousCandidate =
    previous !== null && (!reopenCurrent || sameOrigin) ? previous : undefined;
  const previousInput: Pick<
    DraftReconciliationInput,
    "previousCandidate" | "replayPreviousCandidate"
  > = {};
  if (previousCandidate !== undefined) {
    previousInput.previousCandidate = previousCandidate;
    previousInput.replayPreviousCandidate =
      input.recovery === undefined &&
      sameOrigin &&
      previousCandidate.headSha === repair.draft.headSha;
  }
  return { ownedPrevious, previousInput, recoveryMode, reopenCurrent };
};

/** Reconcile the owned draft with its live base without changing the accepted starter source. */
export const preparePublishedDraftReconciliation = async (input: PreparationInput) => {
  const { state, ctx } = input;
  const previous = structuredClone(draftReconciliationState.get());
  const { access, runtime, owned, repair } = await acquireOwnedPublishedDraft(input, previous);
  const { ownedPrevious, recoveryMode, reopenCurrent, previousInput } =
    reconciliationPreparationLineage(input, previous, repair);
  const sourceInput = {
    name: owned.draft.name,
    owner: owned.draft.owner,
    priorPublishedProposalDigest: owned.proposal.digest,
    pullRequestNumber: owned.draft.number,
    readPublishedSource: async (draft: ExistingDraftObservation) =>
      await readPublishedOperatorSourceForSession({
        adapterSessionId: ctx.session.id,
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        callId: ctx.callId,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        lookup: {
          branch: draft.headBranch,
          gitSha: draft.headSha,
          gitTree: draft.headTree,
          repositoryId: draft.repositoryId,
        },
        root: state.applyReceipt.applyRoot,
        sessionAuth: ctx.session.auth,
        signal: ctx.abortSignal,
      }),
    recovery: draftInspectionRecoveryForSession({
      appId: state.appSpec.appId,
      appSpecDigest: state.appSpec.digest,
      ctx,
      priorPublishedProposalDigest: owned.proposal.digest,
      pullRequestNumber: input.pullRequestNumber,
      root: state.applyReceipt.applyRoot,
    }),
    repositoryId: owned.draft.repositoryId,
  };
  if (ownedPrevious?.proposal !== undefined) {
    sourceInput.previousReconciliation = ownedPrevious.proposal;
  }
  if (ownedPrevious?.publishedReconciliation !== undefined) {
    sourceInput.publishedReconciliation = ownedPrevious.publishedReconciliation;
  }
  const source = await runtime.inspectExistingDraftReconciliationSource(sourceInput);
  if (
    source.draft.headSha !== owned.draft.headSha ||
    source.draft.headTree !== owned.draft.headTree
  ) {
    throw new Error("The draft branch moved during preparation. Re-observe this same draft.");
  }
  assertCurrentOrigin(state, previous);
  const sandbox = await getSourceBoundSandbox(ctx);
  // The original full publication already carries its approved root registration.
  const changes = state.reviewReceipt.changes.filter((change) =>
    change.path.startsWith(`apps/${repair.appId}/`),
  );
  const unpublished =
    reopenCurrent || reviewedOriginAlreadyPublished(state, owned, repair) || changes.length === 0
      ? undefined
      : {
          changes,
          contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
          priorPublishedHeadSha: owned.publication.branchSha,
          reviewDigest: state.reviewReceipt.digest,
        };
  const accessRuntime = await repositoryAccessRuntimeForSession(ctx.session.auth);
  const { prepared, retriedGitFetch } = await prepareWithVerifiedGitHubFetchRecovery({
    acquireCredential: async () =>
      await accessRuntime.acquireExistingSourceCredential({
        installationId: access.scope.installationId,
        repository: repair.source.repository,
        sessionId: ctx.session.id,
      }),
    prepare: async () => {
      assertCurrentOrigin(state, previous);
      const preparation = {
        appId: repair.appId,
        baseBranch: source.draft.baseBranch,
        baseSha: source.base.headSha,
        headBranch: source.draft.headBranch,
        headSha: source.draft.headSha,
        ownedPublication: { proposal: owned.proposal, publication: owned.publication },
        repository: repair.source.repository,
        sandbox,
        ...previousInput,
      };
      if (input.recovery !== undefined) {
        preparation.forceFreshCandidate = true;
      }
      if (unpublished !== undefined) {
        preparation.unpublished = unpublished;
      }
      return await prepareDraftReconciliation(preparation);
    },
    sandbox: {
      setNetworkPolicy: async (policy) => {
        await setBuilderSandboxNetworkPolicy(sandbox, policy);
      },
    },
  });
  assertCurrentOrigin(state, previous);
  const {
    created: _created,
    preservedCandidateRoot,
    replayedAppChanges,
    ...preparedCandidate
  } = prepared;
  void _created;
  const publishedReconciliation =
    source.publishedReconciliation ?? ownedPrevious?.publishedReconciliation;
  const preservedWorkspaces = reopenCurrent
    ? preservedDraftWorkspaces(state, ownedPrevious, prepared.root, preservedCandidateRoot)
    : undefined;
  const candidate = {
    ...preparedCandidate,
    githubSourceDigest: repair.source.digest,
    kind: "reconciliation" as const,
    originalReviewDigest: state.reviewReceipt.digest,
    publishedOrigin: repair,
    pullRequestNumber: owned.draft.number,
    repositoryId: owned.draft.repositoryId,
    reviewedLineage: structuredClone(state),
    version: 1 as const,
  };
  if (recoveryMode !== undefined) {
    candidate.preservedWorkspaces = preservedWorkspaces;
    candidate.recoveryMode = recoveryMode;
  }
  if (publishedReconciliation !== undefined) {
    candidate.publishedReconciliation = publishedReconciliation;
  }
  updateExactDraftReconciliation({
    expected: previous,
    operation: "preparing this owned draft's native base merge",
    transition: () => candidate,
  });
  const result = {
    baseSha: candidate.baseSha,
    conflicts: candidate.conflicts,
    headSha: candidate.headSha,
    kind: "reconciliation" as const,
    nextAction: reopenCurrent
      ? "The original app review was not replayed. Compare its preserved app changes through change_set_status and any retained draft candidates with this current owned draft, then apply only intended app edits. Resolve app conflicts, validate and review the candidate, then seal_github_draft_pr_reconciliation and request its exact update approval. The original source and private workspaces remain retained; their availability is established when read."
      : "Resolve any app conflicts, validate and review this native base/head merge, then seal_github_draft_pr_reconciliation and request its exact update approval. The original starter, same draft branch, and approved root registration remain intact.",
    root: candidate.root,
    status: candidate.conflicts.length === 0 ? "ready_for_validation" : "needs_resolution",
  };
  if (reopenCurrent) {
    result.originalReviewReplayed = false;
    result.preservedWorkspaces = preservedWorkspaces;
    result.recoveryMode = recoveryMode;
  }
  if (preservedCandidateRoot !== undefined) {
    result.preservedCandidateRoot = preservedCandidateRoot;
    result.replayedAppChanges = replayedAppChanges;
  }
  if (retriedGitFetch) {
    result.gitTransportRecovery = "Verified installation Git fetch recovered.";
  }
  return result;
};
