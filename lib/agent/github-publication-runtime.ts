import {
  createDraftPullRequestProposal,
  createApprovedFreshRepository,
  publishApprovedDraftPullRequest,
  resolveImmutableExistingSource,
  resolveImmutableExistingSourceWithTargetProof,
} from "../repository/github-publication";
import type {
  DraftPullRequestProposal,
  DraftPullRequestSuccessReceipt,
  FreshRepositorySuccessReceipt,
  GitHubDraftPullRequestContentSource,
  GitHubFreshRepositoryContentSource,
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
  ImmutableGitHubSourceReceipt,
} from "../repository/github-publication";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { SourceReceiptEvidence } from "../repository/source-receipt";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import type { GitHubDraftAdoptionStore } from "../repository/postgres-github-draft-adoption-store";
import { isDeepStrictEqual } from "node:util";
import { sealExistingDraftUpdate, updateExistingDraft } from "../repository/github-draft-update";
import type {
  ExistingDraftObservation,
  ExistingDraftUpdateAdapter,
  ExistingDraftUpdateProposal,
} from "../repository/github-draft-update";
import { approvalTargetFromDraftProposal, assertApprovalReceipt } from "./approval-receipt";
import type { ApprovalReceipt } from "./approval-receipt";
import type { HostedGitHubTenantAuthority } from "../repository/postgres-github-installation-store";

const supportedOperations = [
  "resolve-immutable-existing-source",
  "seal-draft-pull-request-proposal",
  "create-approved-private-fresh-history-repository",
  "publish-approved-branch-and-draft-pull-request",
  "update-approved-existing-draft-pull-request",
  "recover-lost-response-by-idempotency-key",
] as const;
const draftPublicationOperation = "publish-draft-pull-request" as const;

export interface GitHubPublicationRuntimeStatus {
  version: 3;
  enabled: boolean;
  adapterConfigured: boolean;
  durableStoreConfigured: boolean;
  genericShellAuthority: false;
  liveGitHubCallsAvailable: boolean;
  supportedOperations: typeof supportedOperations;
  releaseGate: {
    name: "REPOSITORY_RELEASE_ENABLED";
    policies: {
      "create-approved-private-fresh-history-repository": {
        requiredConfiguredState: false;
      };
      "publish-approved-branch-and-draft-pull-request": {
        requiredConfiguredState: "sealed-proposal-value";
        rejectsDrift: true;
      };
    };
  };
  reason: string;
}

export interface GitHubPublicationRuntime {
  status: () => Promise<GitHubPublicationRuntimeStatus>;
  resolveImmutableSource: (input: {
    expectedInstallationId: string;
    repositoryId: string;
    ref: string;
    expectedSha: string;
    expectedTree: string;
    approvedByCallId: string;
  }) => Promise<ImmutableGitHubSourceReceipt>;
  sealDraftPullRequestProposal: (input: {
    githubSource: ImmutableGitHubSourceReceipt;
    source: SourceReceiptEvidence;
    review: ReviewedChangeSetReceipt;
    title: string;
  }) => Promise<DraftPullRequestProposal>;
  createFreshRepository: (input: {
    expectedProposalDigest: string;
    review: ReviewedChangeSetReceipt;
    contentSource: GitHubFreshRepositoryContentSource;
    approvedByCallId: string;
  }) => Promise<FreshRepositorySuccessReceipt>;
  publishDraftPullRequest: (input: {
    expectedProposalDigest: string;
    approvalReceipt: ApprovalReceipt;
    review: ReviewedChangeSetReceipt;
    contentSource: GitHubDraftPullRequestContentSource;
    approvedByCallId: string;
  }) => Promise<DraftPullRequestSuccessReceipt>;
  sealExistingDraftUpdate: (input: {
    githubSource: ImmutableGitHubSourceReceipt;
    review: ReviewedChangeSetReceipt;
    pullRequestNumber: number;
    priorPublishedProposalDigest?: string;
    selectedCheckoutHeadSha: string;
    selectedCheckoutHeadTree: string;
  }) => Promise<ExistingDraftUpdateProposal>;
  updateExistingDraft: (input: {
    proposal: ExistingDraftUpdateProposal;
    review: ReviewedChangeSetReceipt;
    contentSource: GitHubDraftPullRequestContentSource;
  }) => Promise<ExistingDraftObservation>;
  inspectExistingDraftSource: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    pullRequestNumber: number;
  }) => Promise<ExistingDraftObservation>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function runtimeStatus(enabled: boolean): GitHubPublicationRuntimeStatus {
  return {
    adapterConfigured: enabled,
    durableStoreConfigured: enabled,
    enabled,
    genericShellAuthority: false,
    liveGitHubCallsAvailable: enabled,
    reason: enabled
      ? "The explicit installation adapter and durable PostgreSQL stores are configured."
      : "A least-privilege GitHub App adapter and durable receipt store are not configured on this host.",
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED",
      policies: {
        "create-approved-private-fresh-history-repository": {
          requiredConfiguredState: false,
        },
        "publish-approved-branch-and-draft-pull-request": {
          rejectsDrift: true,
          requiredConfiguredState: "sealed-proposal-value",
        },
      },
    },
    supportedOperations,
    version: 3,
  };
}

const unavailable = (): never => {
  throw new Error(
    "GitHub acquisition and publication are disabled: no least-privilege GitHub App adapter or durable receipt store is configured.",
  );
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function disabledRuntime(): GitHubPublicationRuntime {
  return {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async createFreshRepository() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async inspectExistingDraftSource() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async publishDraftPullRequest() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async resolveImmutableSource() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async sealDraftPullRequestProposal() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async sealExistingDraftUpdate() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async status() {
      return runtimeStatus(false);
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async updateExistingDraft() {
      return unavailable();
    },
  };
}

/**
 * Explicit composition boundary. Enabling requires an already-created
 * operation-scoped adapter plus durable proposal and receipt stores. This
 * function never reads environment variables, credentials, endpoints, or
 * database URLs.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function composeGitHubPublicationRuntime(input: {
  enabled: boolean;
  adapter?: GitHubPublicationAdapter;
  authority?: HostedGitHubTenantAuthority;
  proposals?: GitHubPublicationProposalStore;
  receipts?: GitHubPublicationReceiptStore;
  adoptions?: GitHubDraftAdoptionStore;
}): GitHubPublicationRuntime {
  if (!input.enabled) {
    return disabledRuntime();
  }
  if (
    input.adapter === undefined ||
    input.proposals === undefined ||
    input.receipts === undefined
  ) {
    throw new Error(
      "GitHub publication cannot be enabled without its typed adapter and durable stores.",
    );
  }
  const { adapter } = input;
  const { proposals } = input;
  const { receipts } = input;
  const { adoptions } = input;
  const draftUpdateAdapter: ExistingDraftUpdateAdapter = {
    async inspectAppliedUpdate(proposal, content, observed) {
      if (adapter.inspectAppliedDraftUpdate === undefined) {
        throw new Error(
          "GitHub draft update verification is unavailable. Upgrade the GitHub provider before updating this PR.",
        );
      }
      return await adapter.inspectAppliedDraftUpdate(proposal, content, observed);
    },
    async inspectDraft(request) {
      return await adapter.inspectExistingDraft(request);
    },
    async inspectInstallation() {
      return await adapter.inspectInstallation(draftPublicationOperation);
    },
    async updateDraft(proposal, content) {
      return await adapter.updateExistingDraft(proposal, content);
    },
  };
  return {
    async createFreshRepository(request) {
      const proposal = await proposals.read(request.expectedProposalDigest);
      if (
        proposal === undefined ||
        proposal.digest !== request.expectedProposalDigest ||
        proposal.intendedOutcome !== "create-private-fresh-history-repository"
      ) {
        throw new Error("The exact fresh-repository proposal is unavailable or changed.");
      }
      return createApprovedFreshRepository({
        adapter,
        approvedByCallId: request.approvedByCallId,
        contentSource: request.contentSource,
        proposal,
        review: request.review,
        store: receipts,
      });
    },
    async inspectExistingDraftSource(request) {
      const observed = await adapter.inspectExistingDraft({
        name: request.name,
        number: request.pullRequestNumber,
        owner: request.owner,
        repositoryId: request.repositoryId,
      });
      const matchesSelection = isDeepStrictEqual(
        [
          observed.repositoryId,
          observed.owner,
          observed.name,
          observed.number,
          observed.state,
          observed.draft,
          observed.headRepositoryId,
          observed.baseRepositoryId,
        ],
        [
          request.repositoryId,
          request.owner,
          request.name,
          request.pullRequestNumber,
          "open",
          true,
          request.repositoryId,
          request.repositoryId,
        ],
      );
      if (!matchesSelection) {
        throw new Error(
          "The selected PR is not an open draft with a branch in this connected GitHub repository. Choose the correct draft PR, then retry source selection.",
        );
      }
      return observed;
    },
    async publishDraftPullRequest(request) {
      const proposal = await proposals.read(request.expectedProposalDigest);
      if (
        proposal === undefined ||
        proposal.digest !== request.expectedProposalDigest ||
        proposal.intendedOutcome !== "publish-reviewed-change-set-as-draft-pull-request"
      ) {
        throw new Error("The exact draft-pull-request proposal is unavailable or changed.");
      }
      assertApprovalReceipt({
        actual: request.approvalReceipt,
        phase: "publication",
        subjectDigest: proposal.digest,
        target: approvalTargetFromDraftProposal(proposal),
      });
      return publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: request.approvedByCallId,
        contentSource: request.contentSource,
        proposal,
        review: request.review,
        store: receipts,
      });
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async resolveImmutableSource(request) {
      if (adapter.targetSourceAdapter && input.authority) {
        return resolveImmutableExistingSourceWithTargetProof({
          adapter: adapter.targetSourceAdapter,
          authority: input.authority,
          expectedInstallationId: request.expectedInstallationId,
          expectedSha: request.expectedSha,
          expectedTree: request.expectedTree,
          ref: request.ref,
          repositoryId: request.repositoryId,
          resolvedByCallId: request.approvedByCallId,
        });
      }
      return resolveImmutableExistingSource({
        adapter,
        expectedInstallationId: request.expectedInstallationId,
        expectedSha: request.expectedSha,
        expectedTree: request.expectedTree,
        ref: request.ref,
        repositoryId: request.repositoryId,
        resolvedByCallId: request.approvedByCallId,
      });
    },
    async sealDraftPullRequestProposal(request) {
      const repository = await adapter.inspectRepository({
        operation: draftPublicationOperation,
        ref: `refs/heads/${request.githubSource.repository.defaultBranch}`,
        repositoryId: request.githubSource.repository.repositoryId,
      });
      const installation = await adapter.inspectInstallation(draftPublicationOperation);
      const proposal = createDraftPullRequestProposal({
        changedPathsSinceBase: [],
        installation,
        repository,
        review: request.review,
        title: request.title,
      });
      const sealed = await proposals.save(proposal);
      if (sealed.intendedOutcome !== "publish-reviewed-change-set-as-draft-pull-request") {
        throw new Error("The saved draft proposal has the wrong publication outcome.");
      }
      return sealed;
    },
    async sealExistingDraftUpdate(request) {
      const prior =
        request.priorPublishedProposalDigest === undefined
          ? await receipts.findDraftByPullRequest?.(
              request.githubSource.repository.repositoryId,
              request.pullRequestNumber,
            )
          : await receipts.read(request.priorPublishedProposalDigest);
      const matchesOriginalPublication =
        prior?.status === "succeeded" &&
        prior.kind === "draft-pull-request" &&
        isDeepStrictEqual(
          [prior.repositoryId, prior.pullRequestNumber],
          [request.githubSource.repository.repositoryId, request.pullRequestNumber],
        );
      const matchesRequestedDigest =
        request.priorPublishedProposalDigest === undefined ||
        prior?.proposalDigest === request.priorPublishedProposalDigest;
      if (prior !== undefined && (!matchesOriginalPublication || !matchesRequestedDigest)) {
        throw new Error(
          "The selected draft PR conflicts with Builder's tenant-scoped publication receipt. Select its current branch and retry; no branch was changed.",
        );
      }
      if (prior === undefined && request.priorPublishedProposalDigest !== undefined) {
        throw new Error(
          "The specified original publication receipt is unavailable in this tenant. Reopen the current PR branch and review its diff before requesting a verified adoption.",
        );
      }
      let adoptedDraft: Awaited<ReturnType<GitHubDraftAdoptionStore["save"]>> | undefined;
      if (prior === undefined) {
        if (adoptions === undefined) {
          throw new Error(
            "This Builder installation cannot record verified draft PR adoptions. Upgrade its publication store, then retry; no branch was changed.",
          );
        }
        const observed = await draftUpdateAdapter.inspectDraft({
          name: request.githubSource.repository.name,
          number: request.pullRequestNumber,
          owner: request.githubSource.repository.owner,
          repositoryId: request.githubSource.repository.repositoryId,
        });
        const origin = observed.verifiedBuilderOrigin;
        if (origin === undefined) {
          throw new Error(
            "GitHub does not verify this draft PR as authored by this Builder App with matching PR and current-head commit markers. Restore the correct Builder-created branch or use its original Builder session; no branch was changed.",
          );
        }
        const existing = await adoptions.read(observed.repositoryId, observed.pullRequestId);
        if (existing === undefined) {
          adoptedDraft = await adoptions.save({
            appId: origin.appId,
            authorId: origin.authorId,
            builderMarker: origin.marker,
            originalHeadSha: observed.headSha,
            pullRequestId: observed.pullRequestId,
            pullRequestNumber: observed.number,
            repositoryId: observed.repositoryId,
          });
        } else {
          if (
            !isDeepStrictEqual(
              [
                existing.appId,
                existing.authorId,
                existing.builderMarker,
                existing.pullRequestNumber,
              ],
              [origin.appId, origin.authorId, origin.marker, observed.number],
            )
          ) {
            throw new Error(
              "The current GitHub draft differs from its tenant-scoped adoption record. Inspect its author and origin marker before retrying; no branch was changed.",
            );
          }
          adoptedDraft = existing;
        }
      }
      const repository = await adapter.inspectRepository({
        operation: draftPublicationOperation,
        ref: `refs/heads/${request.githubSource.repository.defaultBranch}`,
        repositoryId: request.githubSource.repository.repositoryId,
      });
      const installation = await adapter.inspectInstallation(draftPublicationOperation);
      return sealExistingDraftUpdate({
        adapter: draftUpdateAdapter,
        installation,
        ...(prior === undefined ? { adoptedDraft } : { priorPublication: prior }),
        pullRequestNumber: request.pullRequestNumber,
        repository,
        review: request.review,
        selectedCheckoutHeadSha: request.selectedCheckoutHeadSha,
        selectedCheckoutHeadTree: request.selectedCheckoutHeadTree,
        selectedSourceRef: request.githubSource.resolvedRef,
      });
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async status() {
      return runtimeStatus(true);
    },
    async updateExistingDraft(request) {
      return await updateExistingDraft({
        adapter: draftUpdateAdapter,
        contentSource: request.contentSource,
        proposal: request.proposal,
        review: request.review,
      });
    },
  };
}

/** Shipped default. Deployment composition must enable the runtime explicitly. */
export const githubPublicationRuntime = composeGitHubPublicationRuntime({
  enabled: false,
});
