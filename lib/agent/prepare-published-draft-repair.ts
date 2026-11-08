import { createHash } from "node:crypto";
import type { ToolContext } from "eve/tools";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { getSourceBoundSandbox } from "./source-bound-sandbox";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import type { DraftInspectionRecoveryInput } from "./github-publication-runtime";
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
import { observeNormalizedChangeSet, reviewableChanges } from "../../agent/tools/change_set_status";
import { readPreparedSandboxSourceManifest } from "../repository/supported-template";
import { overlayChanges } from "../repository/target-apply";
import { ARRUSTED_TEMPLATE_REPOSITORY } from "../repository/source-receipt";
import type { SandboxSession } from "eve/sandbox";
import { priorResumedBuildDraftProposal } from "./existing-app-repair-planning";

type Reviewed = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
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
  restoreInitialAppSource?: boolean;
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
    reconciliations: published === undefined ? [] : [published],
    readPublishedSource: async (draft) =>
      await readPublishedOperatorSourceForSession({
        appId: input.appId,
        appSpecDigest: input.appSpecDigest,
        root: input.root,
        callId: input.ctx.callId,
        sessionAuth: input.ctx.session.auth,
        adapterSessionId: input.ctx.session.id,
        callbackExecution: hostedOperatorCallbackExecution(input.ctx.session),
        signal: input.ctx.abortSignal,
        lookup: {
          repositoryId: draft.repositoryId,
          branch: draft.headBranch,
          gitSha: draft.headSha,
          gitTree: draft.headTree,
        },
      }),
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
    publishedProposalDigest: proposalDigest,
    appId: state.appSpec.appId,
    expectedInstallationId: access.scope.installationId,
    resolvedByCallId: ctx.callId,
    recovery: draftInspectionRecoveryForSession({
      ctx,
      appId: state.appSpec.appId,
      appSpecDigest: state.appSpec.digest,
      root: state.applyReceipt.applyRoot,
      pullRequestNumber: input.pullRequestNumber,
      priorPublishedProposalDigest: proposalDigest,
    }),
    readPublishedSource: async (lookup) =>
      await readPublishedOperatorSourceForSession({
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        root: state.applyReceipt.applyRoot,
        callId: ctx.callId,
        sessionAuth: ctx.session.auth,
        adapterSessionId: ctx.session.id,
        callbackExecution: hostedOperatorCallbackExecution(ctx.session),
        signal: ctx.abortSignal,
        lookup,
      }),
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
    originSourceReceiptDigest: state.sourceReceipt.digest,
    publicationProposalDigest: owned.proposal.digest,
    publicationDigest: owned.publication.digest,
    installationId: access.scope.installationId,
    source: owned.source,
    draft: owned.draft,
  });
  assertCurrentOrigin(state, previous);
  return { access, runtime, owned, repair };
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
          reviewDigest: state.reviewReceipt.digest,
          changes: state.reviewReceipt.changes,
          priorPublishedHeadSha: owned.publication.branchSha,
          contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
        };
  const accessRuntime = await repositoryAccessRuntimeForSession(ctx.session.auth);
  const { prepared } = await prepareWithVerifiedGitHubFetchRecovery({
    acquireCredential: async () =>
      await accessRuntime.acquireExistingSourceCredential({
        installationId: access.scope.installationId,
        repository: repair.source.repository,
        sessionId: ctx.session.id,
      }),
    sandbox: {
      setNetworkPolicy: async (policy) => {
        await setBuilderSandboxNetworkPolicy(sandbox, policy);
      },
    },
    prepare: async () => {
      assertCurrentOrigin(state, previous);
      const candidateInput: Parameters<typeof preparePublishedDraftRepairCandidate>[0] = {
        sandbox,
        repository: repair.source.repository,
        appId: repair.appId,
        headBranch: owned.draft.headBranch,
        headSha: owned.draft.headSha,
      };
      if (unpublished !== undefined) {
        candidateInput.unpublished = unpublished;
      }
      if (previous?.kind === "published-draft-repair" && previous.repair.digest === repair.digest) {
        candidateInput.previousCandidate = previous;
        candidateInput.replayPreviousCandidate = true;
      }
      return await preparePublishedDraftRepairCandidate(candidateInput);
    },
  });
  assertCurrentOrigin(state, previous);
  const { publicationScope: _publicationScope, ...preparedRepair } = prepared;
  void _publicationScope;
  const candidate = {
    ...preparedRepair,
    kind: "published-draft-repair" as const,
    repair,
    version: 1 as const,
    repositoryId: owned.draft.repositoryId,
    pullRequestNumber: owned.draft.number,
    githubSourceDigest: owned.source.digest,
    originalReviewDigest: state.reviewReceipt.digest,
    reviewedLineage: structuredClone(state),
  };
  updateExactDraftReconciliation({
    expected: previous,
    operation: "preparing this owned published draft repair",
    transition: () => candidate,
  });
  return {
    status: "ready_for_validation" as const,
    kind: "published-draft-repair" as const,
    baseline: "draft-head" as const,
    headSha: candidate.headSha,
    root: candidate.root,
    conflicts: candidate.conflicts,
    nextAction:
      "Inspect or format this same draft candidate, validate it, review the app-only draft-head delta, then seal_github_draft_pr_update and request separate update approval. The original fresh source and existing published root metadata remain intact.",
  };
};

const samePublishedDraft = (
  previous: DraftReconciliationCandidate,
  repair: ReturnType<typeof createPublishedDraftRepairSource>,
): boolean => {
  const origin =
    previous.kind === "published-draft-repair" ? previous.repair : previous.publishedOrigin;
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
            root: preservedCandidateRoot,
            reviewDigest: state.reviewReceipt.digest,
          },
        ]),
    {
      kind: "app-review",
      root: state.applyReceipt.applyRoot,
      reviewDigest: state.reviewReceipt.digest,
      paths: state.reviewReceipt.changes.flatMap((change) =>
        change.path.startsWith(`apps/${state.appSpec.appId}/`) ? [change.path] : [],
      ),
    },
    ...(previous === undefined || previous.root === currentRoot
      ? []
      : [
          {
            kind: "draft-candidate" as const,
            root: previous.root,
            reviewDigest: previous.originalReviewDigest,
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
  const sameDraft = previous !== null && samePublishedDraft(previous, repair);
  const sameOrigin =
    sameDraft && previous.originalReviewDigest === input.state.reviewReceipt.digest;
  const ownedPrevious = sameOrigin ? previous : undefined;
  const preservedPrevious = sameDraft ? previous : undefined;
  const recoveryMode = input.recovery ?? ownedPrevious?.recoveryMode;
  const reopenCurrent = recoveryMode === "reopen-current-owned-draft";
  const previousCandidate =
    previous !== null && (!reopenCurrent || sameOrigin) ? previous : undefined;
  const previousInput: Pick<
    DraftReconciliationInput,
    "previousCandidate" | "replayPreviousCandidate"
  > =
    previousCandidate === undefined
      ? {}
      : {
          previousCandidate,
          replayPreviousCandidate:
            input.recovery === undefined &&
            sameOrigin &&
            previousCandidate.headSha === repair.draft.headSha,
        };
  return { ownedPrevious, preservedPrevious, recoveryMode, reopenCurrent, previousInput };
};

const retainedInitialAppSource = async (input: {
  state: Reviewed;
  sandbox: SandboxSession;
  priorPublishedHeadSha: string;
  publishedPaths: readonly string[];
  destination: string;
}): Promise<NonNullable<DraftReconciliationInput["unpublished"]>> => {
  const { state, sandbox } = input;
  const appRoot = `apps/${state.appSpec.appId}/`;
  const manifest = `${appRoot}package.json`;
  if (input.publishedPaths.includes(manifest)) {
    throw new Error("The first publication already included the app manifest.");
  }
  const sameRepository =
    input.destination.toLowerCase() === ARRUSTED_TEMPLATE_REPOSITORY.toLowerCase();
  const [observation, original] = await Promise.all([
    observeNormalizedChangeSet({ sandbox, state }),
    sameRepository ? [] : readPreparedSandboxSourceManifest(sandbox, state.workspace),
  ]);
  const { observed } = observation;
  if (original.some(({ path }) => path.startsWith(appRoot))) {
    throw new Error("The original starter already contained this app.");
  }
  if (!observed.files.some(({ path }) => path === manifest)) {
    throw new Error("The retained app source has no package manifest to restore.");
  }
  const before = original.map(({ path, sha256: digest, mode }) => ({
    path,
    digest,
    mode: mode.slice(3),
  }));
  const delta = overlayChanges(
    { files: before, treeDigest: state.workspace.workspaceDigest },
    observed,
  );
  const appFiles = reviewableChanges(delta, state.appSpec.appId, true);
  const registrationPaths = new Set([
    "package.json",
    "bun.lock",
    state.applyReceipt.targetReceipt.topology.path,
  ]);
  const registration = delta.filter(
    ({ path, kind }) => registrationPaths.has(path) && kind !== "deleted",
  );
  const changes = [...appFiles, ...registration];
  const unpublished: Omit<NonNullable<DraftReconciliationInput["unpublished"]>, "reviewDigest"> = {
    changes,
    contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
    priorPublishedHeadSha: input.priorPublishedHeadSha,
    restoreInitialAppSource: true,
  };
  if (sameRepository) {
    unpublished.initialSourceRevision = {
      sha: state.sourceReceipt.sourceSha,
      tree: state.sourceReceipt.sourceTree,
    };
  }
  return {
    ...unpublished,
    reviewDigest: createHash("sha256")
      .update(JSON.stringify([state.reviewReceipt.digest, changes]))
      .digest("hex"),
  };
};

const publishedDraftUnpublishedSource = async (input: {
  state: Reviewed;
  sandbox: SandboxSession;
  owned: Awaited<ReturnType<typeof acquireOwnedPublishedDraft>>["owned"];
  repair: ReturnType<typeof createPublishedDraftRepairSource>;
  reopenCurrent: boolean;
  restoreInitialAppSource?: boolean;
}) => {
  const { state, sandbox, owned, repair } = input;
  if (input.restoreInitialAppSource === true) {
    return await retainedInitialAppSource({
      state,
      sandbox,
      priorPublishedHeadSha: owned.publication.branchSha,
      publishedPaths: owned.proposal.approvedPaths,
      destination: `https://github.com/${owned.proposal.owner}/${owned.proposal.name}.git`,
    });
  }
  const changes = state.reviewReceipt.changes.filter(({ path }) =>
    path.startsWith(`apps/${repair.appId}/`),
  );
  return input.reopenCurrent ||
    reviewedOriginAlreadyPublished(state, owned, repair) ||
    changes.length === 0
    ? undefined
    : {
        reviewDigest: state.reviewReceipt.digest,
        changes,
        priorPublishedHeadSha: owned.publication.branchSha,
        contentSource: publicationContentSourceForReviewedWorkflow({ sandbox, state }),
      };
};

/** Reconcile the owned draft with its live base without changing the accepted starter source. */
export const preparePublishedDraftReconciliation = async (input: PreparationInput) => {
  const { state, ctx } = input;
  const previous = structuredClone(draftReconciliationState.get());
  const { access, runtime, owned, repair } = await acquireOwnedPublishedDraft(input, previous);
  const { ownedPrevious, preservedPrevious, recoveryMode, reopenCurrent, previousInput } =
    reconciliationPreparationLineage(input, previous, repair);
  const inspectionRequest = (): Parameters<
    typeof runtime.inspectExistingDraftReconciliationSource
  >[0] => {
    const request: Omit<
      Parameters<typeof runtime.inspectExistingDraftReconciliationSource>[0],
      "readPublishedSource"
    > = {
      repositoryId: owned.draft.repositoryId,
      owner: owned.draft.owner,
      name: owned.draft.name,
      pullRequestNumber: owned.draft.number,
      priorPublishedProposalDigest: owned.proposal.digest,
      recovery: draftInspectionRecoveryForSession({
        ctx,
        appId: state.appSpec.appId,
        appSpecDigest: state.appSpec.digest,
        root: state.applyReceipt.applyRoot,
        pullRequestNumber: input.pullRequestNumber,
        priorPublishedProposalDigest: owned.proposal.digest,
      }),
    };
    if (ownedPrevious?.proposal !== undefined) {
      request.previousReconciliation = ownedPrevious.proposal;
    }
    if (ownedPrevious?.publishedReconciliation !== undefined) {
      request.publishedReconciliation = ownedPrevious.publishedReconciliation;
    }
    return {
      ...request,
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
    };
  };
  const source = await runtime.inspectExistingDraftReconciliationSource(inspectionRequest());
  if (
    source.draft.headSha !== owned.draft.headSha ||
    source.draft.headTree !== owned.draft.headTree
  ) {
    throw new Error("The draft branch moved during preparation. Re-observe this same draft.");
  }
  assertCurrentOrigin(state, previous);
  const sandbox = await getSourceBoundSandbox(ctx);
  const [unpublished, accessRuntime] = await Promise.all([
    publishedDraftUnpublishedSource({
      state,
      sandbox,
      owned,
      repair,
      reopenCurrent,
      restoreInitialAppSource: input.restoreInitialAppSource,
    }),
    repositoryAccessRuntimeForSession(ctx.session.auth),
  ]);
  const { prepared, retriedGitFetch } = await prepareWithVerifiedGitHubFetchRecovery({
    acquireCredential: async () =>
      await accessRuntime.acquireExistingSourceCredential({
        installationId: access.scope.installationId,
        repository: repair.source.repository,
        sessionId: ctx.session.id,
      }),
    sandbox: {
      setNetworkPolicy: async (policy) => {
        await setBuilderSandboxNetworkPolicy(sandbox, policy);
      },
    },
    prepare: async () => {
      assertCurrentOrigin(state, previous);
      const candidateInput: DraftReconciliationInput = {
        sandbox,
        repository: repair.source.repository,
        appId: repair.appId,
        baseBranch: source.draft.baseBranch,
        baseSha: source.base.headSha,
        headBranch: source.draft.headBranch,
        headSha: source.draft.headSha,
        ownedPublication: { proposal: owned.proposal, publication: owned.publication },
      };
      if (!(input.recovery === undefined && input.restoreInitialAppSource !== true)) {
        candidateInput.forceFreshCandidate = true;
      }
      if (unpublished !== undefined) {
        candidateInput.unpublished = unpublished;
      }
      return await prepareDraftReconciliation({
        ...candidateInput,
        ...previousInput,
      });
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
    ? preservedDraftWorkspaces(state, preservedPrevious, prepared.root, preservedCandidateRoot)
    : undefined;
  const candidateParts: typeof preparedCandidate &
    Pick<
      DraftReconciliationCandidate,
      "recoveryMode" | "preservedWorkspaces" | "publishedReconciliation"
    > & { kind: "reconciliation"; publishedOrigin: typeof repair } = {
    ...preparedCandidate,
    kind: "reconciliation" as const,
    publishedOrigin: repair,
  };
  if (recoveryMode !== undefined) {
    candidateParts.recoveryMode = recoveryMode;
    candidateParts.preservedWorkspaces = preservedWorkspaces;
  }
  if (publishedReconciliation !== undefined) {
    candidateParts.publishedReconciliation = publishedReconciliation;
  }
  const candidate = {
    ...candidateParts,
    version: 1 as const,
    repositoryId: owned.draft.repositoryId,
    pullRequestNumber: owned.draft.number,
    githubSourceDigest: repair.source.digest,
    originalReviewDigest: state.reviewReceipt.digest,
    reviewedLineage: structuredClone(state),
  };
  updateExactDraftReconciliation({
    expected: previous,
    operation: "preparing this owned draft's native base merge",
    transition: () => candidate,
  });
  return {
    status: candidate.conflicts.length === 0 ? "ready_for_validation" : "needs_resolution",
    kind: "reconciliation" as const,
    baseSha: candidate.baseSha,
    headSha: candidate.headSha,
    root: candidate.root,
    conflicts: candidate.conflicts,
    ...(reopenCurrent ? { recoveryMode, originalReviewReplayed: false, preservedWorkspaces } : {}),
    ...(preservedCandidateRoot === undefined ? {} : { preservedCandidateRoot, replayedAppChanges }),
    ...(retriedGitFetch
      ? { gitTransportRecovery: "Verified installation Git fetch recovered." }
      : {}),
    nextAction: reopenCurrent
      ? "The original app review was not replayed. Compare its preserved app changes through change_set_status and any retained draft candidates with this current owned draft, then apply only intended app edits. Resolve app conflicts, validate and review the candidate, then seal_github_draft_pr_reconciliation and request its exact update approval. The original source and private workspaces remain retained; their availability is established when read."
      : "Resolve any app conflicts, validate and review this native base/head merge, then seal_github_draft_pr_reconciliation and request its exact update approval. The original starter, same draft branch, and approved root registration remain intact.",
  };
};
