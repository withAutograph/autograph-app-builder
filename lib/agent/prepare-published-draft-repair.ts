import type { ToolContext } from "eve/tools";
import type { AppBuilderWorkflowState } from "./workflow-state";
import { appBuilderWorkflowState } from "./workflow-state";
import { getSourceBoundSandbox } from "./source-bound-sandbox";
import { githubPublicationRuntimeForSession } from "./deployment-github-publication-runtime";
import { repositoryAccessRuntimeForSession } from "./deployment-repository-access-runtime";
import {
  repositoryAccessReceiptSchema,
  repositoryAccessReceiptState,
} from "./repository-access-state";
import { createPublishedDraftRepairSource } from "./published-draft-repair";
import {
  draftReconciliationState,
  publishedDraftRepairCompletions,
  updateExactDraftReconciliation,
} from "./draft-reconciliation-state";
import { publicationContentSourceForReviewedWorkflow } from "./github-publication-content-source";
import { readPublishedOperatorSourceForSession } from "./compiled-operator-artifacts";
import { hostedOperatorCallbackExecution } from "../provisioning/hosted-operator-callback-owner";
import { prepareWithVerifiedGitHubFetchRecovery } from "./verified-github-fetch-recovery";
import { setBuilderSandboxNetworkPolicy } from "../sandbox/builder-sandbox";
import { preparePublishedDraftRepairCandidate } from "../repository/sandbox-draft-reconciliation";

type Reviewed = Extract<AppBuilderWorkflowState, { phase: "reviewed" }>;
const assertCurrentOrigin = (expected: Reviewed): void => {
  const current = appBuilderWorkflowState.get();
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

/** Acquire a second private checkout for this session's actual published app, never replace its starter. */
export const preparePublishedDraftRepair = async (input: {
  state: Reviewed;
  ctx: ToolContext;
  pullRequestNumber: number;
}) => {
  const { state, ctx } = input;
  const proposalDigest =
    state.publishedGitHubDraftProposalDigest ?? state.githubDraftProposal?.proposal.digest;
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
  if (runtime.inspectOwnedPublishedDraftRepairSource === undefined) {
    throw new Error("The publication runtime cannot prepare a same-session owned draft repair.");
  }
  const owned = await runtime.inspectOwnedPublishedDraftRepairSource({
    publishedProposalDigest: proposalDigest,
    appId: state.appSpec.appId,
    expectedInstallationId: access.scope.installationId,
    resolvedByCallId: ctx.callId,
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
  const sandbox = await getSourceBoundSandbox(ctx);
  const previous = draftReconciliationState.get();
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
      assertCurrentOrigin(state);
      return await preparePublishedDraftRepairCandidate({
        sandbox,
        repository: repair.source.repository,
        appId: repair.appId,
        headBranch: owned.draft.headBranch,
        headSha: owned.draft.headSha,
        ...(unpublished === undefined ? {} : { unpublished }),
        ...(previous?.kind === "published-draft-repair" && previous.repair.digest === repair.digest
          ? { previousCandidate: previous, replayPreviousCandidate: true }
          : {}),
      });
    },
  });
  assertCurrentOrigin(state);
  const candidate = {
    ...prepared,
    kind: "published-draft-repair" as const,
    repair,
    version: 1 as const,
    repositoryId: owned.draft.repositoryId,
    pullRequestNumber: owned.draft.number,
    githubSourceDigest: owned.source.digest,
    originalReviewDigest: state.reviewReceipt.digest,
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
