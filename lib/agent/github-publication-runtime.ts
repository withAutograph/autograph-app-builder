import {
  createDraftPullRequestProposal,
  createRepositoryObservation,
  assertCanonicalGitHubMutationReceipt,
  assertExactDraftPullRequestProposal,
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
  GitHubRepositoryObservation,
  GitHubInstallationIdentity,
  ImmutableGitHubSourceReceipt,
} from "../repository/github-publication";
import type { DraftUpdateReview } from "../repository/published-draft-repair-review";
import type { ReviewedChangeSetReceipt } from "../repository/reviewed-change-set";
import type { SourceReceiptEvidence } from "../repository/source-receipt";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import type { GitHubDraftAdoptionStore } from "../repository/postgres-github-draft-adoption-store";
import { isDeepStrictEqual } from "node:util";
import {
  inspectAppliedExistingDraftUpdate,
  sealExistingDraftUpdate,
  updateExistingDraft,
} from "../repository/github-draft-update";
import type {
  ExistingDraftObservation,
  ExistingDraftUpdateAdapter,
  ExistingDraftUpdateProposal,
} from "../repository/github-draft-update";
import {
  reconcileExistingDraft,
  inspectAppliedExistingDraftReconciliation,
  sealExistingDraftReconciliation,
} from "../repository/github-draft-reconciliation";
import type {
  ExistingDraftReconciliationAdapter,
  ExistingDraftReconciliationProposal,
  ReconciliationReviewReceipt,
} from "../repository/github-draft-reconciliation";
import { approvalTargetFromDraftProposal, assertApprovalReceipt } from "./approval-receipt";
import type { ApprovalReceipt } from "./approval-receipt";
import type { HostedGitHubTenantAuthority } from "../repository/postgres-github-installation-store";
import type { GitHubDestinationReviewBinding } from "../repository/github-destination-review";
import { assertGitHubDestinationReviewBinding } from "../repository/github-destination-review";
import type { OverlayFile } from "../repository/target-apply";
import type {
  HistoricalAppSourceObservation,
  HistoricalAppSourceSelector,
} from "../repository/historical-app-source";

import { publishedAppSourceSchema } from "../provisioning/hosted-operator-artifact-selection";
import type { PublishedAppSource } from "../provisioning/hosted-operator-artifact-selection";

type PublishedSourceReader = (
  draft: ExistingDraftObservation,
) => Promise<PublishedAppSource | undefined>;

const supportedOperations = [
  "resolve-immutable-existing-source",
  "seal-draft-pull-request-proposal",
  "create-approved-private-fresh-history-repository",
  "publish-approved-branch-and-draft-pull-request",
  "update-approved-existing-draft-pull-request",
  "reconcile-approved-existing-draft-pull-request",
  "recover-lost-response-by-idempotency-key",
] as const;
const draftPublicationOperation = "publish-draft-pull-request" as const;
const sourceReadOperation = "resolve-existing-source" as const;
const draftReceiptKind = "draft-pull-request" as const;

const readOwnedDraftPublication = async (input: {
  receipts: GitHubPublicationReceiptStore;
  proposalDigest?: string;
  draft: ExistingDraftObservation;
}): Promise<DraftPullRequestSuccessReceipt | undefined> => {
  const prior =
    input.proposalDigest === undefined
      ? await input.receipts.findDraftByPullRequest?.(input.draft.repositoryId, input.draft.number)
      : await input.receipts.read(input.proposalDigest);
  if (prior === undefined && input.proposalDigest === undefined) {
    return undefined;
  }
  if (prior !== undefined) {
    assertCanonicalGitHubMutationReceipt(prior);
  }
  if (prior?.status !== "succeeded" || prior.kind !== draftReceiptKind) {
    throw new Error("The workflow's published draft receipt is unavailable in this tenant.");
  }
  const matches = isDeepStrictEqual(
    [
      prior.proposalDigest,
      prior.repositoryId,
      prior.pullRequestId,
      prior.pullRequestNumber,
      prior.branchName,
    ],
    [
      input.proposalDigest ?? prior.proposalDigest,
      input.draft.repositoryId,
      input.draft.pullRequestId,
      input.draft.number,
      input.draft.headBranch,
    ],
  );
  if (!matches) {
    throw new Error(
      "The current draft does not match this workflow's tenant-owned published pull request. Inspect its current publication before preparing a repair.",
    );
  }
  return prior;
};

const readAppliedOwnedReconciliation = async (input: {
  adapter: GitHubPublicationAdapter;
  draft: ExistingDraftObservation;
  prior: DraftPullRequestSuccessReceipt | undefined;
  candidates: readonly (ExistingDraftReconciliationProposal | undefined)[];
}): Promise<ExistingDraftReconciliationProposal | undefined> => {
  const { prior } = input;
  const inspect = input.adapter.inspectAppliedDraftReconciliation;
  if (prior === undefined || inspect === undefined) {
    return undefined;
  }
  const { draft } = input;
  const candidates = input.candidates.filter(
    (candidate): candidate is ExistingDraftReconciliationProposal =>
      candidate !== undefined &&
      candidate.expectedHeadSha !== draft.headSha &&
      candidate.resolvedTree === draft.headTree &&
      isDeepStrictEqual(
        [
          candidate.repositoryId,
          candidate.owner,
          candidate.name,
          candidate.pullRequestId,
          candidate.pullRequestNumber,
          candidate.branchName,
          candidate.baseBranch,
          candidate.priorPublicationDigest,
        ],
        [
          draft.repositoryId,
          draft.owner,
          draft.name,
          draft.pullRequestId,
          draft.number,
          draft.headBranch,
          draft.baseBranch,
          prior.digest,
        ],
      ),
  );
  const unique = [
    ...new Map(candidates.map((candidate) => [candidate.digest, candidate])).values(),
  ];
  for (const candidate of unique) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each later provider read is needed only when the prior candidate proof is absent.
    if (await inspect.call(input.adapter, candidate, draft)) {
      return candidate;
    }
  }
  return undefined;
};

const reconciliationBaselineSources = [
  "retained-reconciliation",
  "published-source",
  "original-publication",
  "none",
] as const;
interface ReconciliationBaseline {
  headSha: string | undefined;
  source: (typeof reconciliationBaselineSources)[number];
  canonicalPublishedSourceMatched: boolean;
}
interface ReconciliationBaselineDiagnostic extends Pick<
  ReconciliationBaseline,
  "source" | "canonicalPublishedSourceMatched"
> {
  previousReconciliationPresent: boolean;
  publishedReconciliationPresent: boolean;
}
const reportReconciliationBaseline = (diagnostic: ReconciliationBaselineDiagnostic): void => {
  try {
    console.info(
      JSON.stringify({ event: "app_builder.draft_reconciliation_baseline", ...diagnostic }),
    );
  } catch {
    /* Diagnostic delivery cannot change ownership checks or baseline selection. */
  }
};

const ownedPublishedHead = async (input: {
  draft: ExistingDraftObservation;
  prior: DraftPullRequestSuccessReceipt | undefined;
  appliedReconciliation: ExistingDraftReconciliationProposal | undefined;
  readPublishedSource: PublishedSourceReader | undefined;
}): Promise<ReconciliationBaseline> => {
  const { draft, prior, appliedReconciliation, readPublishedSource } = input;
  if (appliedReconciliation !== undefined) {
    return {
      headSha: draft.headSha,
      source: "retained-reconciliation",
      canonicalPublishedSourceMatched: false,
    };
  }
  const fallback: ReconciliationBaseline = {
    headSha: prior?.branchSha,
    source: prior === undefined ? "none" : "original-publication",
    canonicalPublishedSourceMatched: false,
  };
  if (
    prior === undefined ||
    prior.branchSha === draft.headSha ||
    readPublishedSource === undefined
  ) {
    return fallback;
  }
  const source = publishedAppSourceSchema.safeParse(await readPublishedSource(draft));
  const matched =
    source.success &&
    [
      source.data.repositoryId === draft.repositoryId,
      source.data.branch === draft.headBranch,
      source.data.gitSha === draft.headSha,
      source.data.gitTree === draft.headTree,
    ].every(Boolean);
  return matched
    ? { headSha: draft.headSha, source: "published-source", canonicalPublishedSourceMatched: true }
    : fallback;
};

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

export interface GitHubPublicationDestinationIdentity {
  repositoryId: string;
  owner: string;
  name: string;
  defaultBranch: string;
  installationId: string;
}

type GitHubDraftDestination =
  | { githubSource: ImmutableGitHubSourceReceipt; destination?: never }
  | { githubSource?: never; destination: GitHubPublicationDestinationIdentity };

const draftDestinationRepository = (request: GitHubDraftDestination) => {
  if (request.destination === undefined) {
    return request.githubSource.repository;
  }
  return request.destination;
};

const assertDraftDestinationRepository = (
  request: GitHubDraftDestination,
  repository: GitHubRepositoryObservation,
) => {
  const destination = draftDestinationRepository(request);
  const sameRepository = (["repositoryId", "owner", "name"] as const).every(
    (key) => repository[key] === destination[key],
  );
  const sameBranch =
    request.destination === undefined || repository.defaultBranch === destination.defaultBranch;
  if (!sameRepository || !sameBranch) {
    throw new Error("The publication destination differs from the selected GitHub repository.");
  }
};

export interface GitHubPublicationRuntime {
  inspectOwnedPublishedDraftRepairSource?: (input: {
    publishedProposalDigest: string;
    appId: string;
    expectedInstallationId: string;
    resolvedByCallId: string;
    readPublishedSource: (lookup: {
      repositoryId: string;
      branch: string;
      gitSha: string;
      gitTree: string;
    }) => Promise<PublishedAppSource | undefined>;
  }) => Promise<{
    proposal: DraftPullRequestProposal;
    publication: DraftPullRequestSuccessReceipt;
    draft: ExistingDraftObservation;
    source: ImmutableGitHubSourceReceipt;
  }>;
  inspectAppliedExistingDraftUpdate?: (input: {
    proposal: ExistingDraftUpdateProposal;
    review: DraftUpdateReview;
  }) => ReturnType<typeof inspectAppliedExistingDraftUpdate>;
  inspectDraftDestination?: (
    input: GitHubDraftDestination & {
      existingProposal?: DraftPullRequestProposal;
      paths: readonly string[];
    },
  ) => Promise<{
    repository: GitHubRepositoryObservation;
    installation: GitHubInstallationIdentity;
    preTree: readonly OverlayFile[];
  }>;
  readDraftDestinationFile?: (input: {
    binding: GitHubDestinationReviewBinding;
    path: string;
  }) => Promise<{ bytes: Uint8Array; mode: string; digest: string } | null>;
  status: () => Promise<GitHubPublicationRuntimeStatus>;
  resolveImmutableSource: (input: {
    expectedInstallationId: string;
    repositoryId: string;
    ref: string;
    expectedSha: string;
    expectedTree: string;
    approvedByCallId: string;
  }) => Promise<ImmutableGitHubSourceReceipt>;
  sealDraftPullRequestProposal: (
    input: (
      | {
          githubSource: ImmutableGitHubSourceReceipt;
          destination?: never;
          destinationReview?: GitHubDestinationReviewBinding;
        }
      | {
          githubSource?: never;
          destination: GitHubPublicationDestinationIdentity;
          destinationReview: GitHubDestinationReviewBinding;
        }
    ) & {
      source: SourceReceiptEvidence;
      review: ReviewedChangeSetReceipt;
      title: string;
    },
  ) => Promise<DraftPullRequestProposal>;
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
    review: DraftUpdateReview;
    pullRequestNumber: number;
    priorPublishedProposalDigest?: string;
    selectedCheckoutHeadSha: string;
    selectedCheckoutHeadTree: string;
  }) => Promise<ExistingDraftUpdateProposal>;
  updateExistingDraft: (input: {
    proposal: ExistingDraftUpdateProposal;
    review: DraftUpdateReview;
    contentSource: GitHubDraftPullRequestContentSource;
  }) => Promise<ExistingDraftObservation>;
  inspectExistingDraftSource: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    pullRequestNumber: number;
  }) => Promise<ExistingDraftObservation>;
  inspectOpenPullRequestSource: GitHubPublicationRuntime["inspectExistingDraftSource"];
  inspectSourceBranch: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    branch: string;
  }) => Promise<{ branch: string; headSha: string; headTree: string }>;
  inspectHistoricalAppSource: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    source: HistoricalAppSourceSelector;
  }) => Promise<HistoricalAppSourceObservation>;
  inspectExistingDraftReconciliationSource: (input: {
    repositoryId: string;
    owner: string;
    name: string;
    pullRequestNumber: number;
    priorPublishedProposalDigest?: string;
    /** Retained server-owned sealed candidate; never a caller-supplied baseline SHA. */
    previousReconciliation?: ExistingDraftReconciliationProposal;
    publishedReconciliation?: ExistingDraftReconciliationProposal;
    /** Trusted current owner/session/app lookup; never serialized as public tool input. */
    readPublishedSource?: PublishedSourceReader;
  }) => Promise<{
    draft: ExistingDraftObservation;
    base: GitHubRepositoryObservation;
    publishedHeadSha?: string;
    publishedReconciliation?: ExistingDraftReconciliationProposal;
  }>;
  sealExistingDraftReconciliation: (input: {
    githubSource: ImmutableGitHubSourceReceipt;
    review: ReconciliationReviewReceipt;
    pullRequestNumber: number;
    priorPublishedProposalDigest?: string;
    selectedCheckoutHeadSha: string;
    selectedCheckoutHeadTree: string;
  }) => Promise<ExistingDraftReconciliationProposal>;
  inspectAppliedExistingDraftReconciliation: (input: {
    proposal: ExistingDraftReconciliationProposal;
    review: ReconciliationReviewReceipt;
  }) => ReturnType<typeof inspectAppliedExistingDraftReconciliation>;
  reconcileExistingDraft: (input: {
    proposal: ExistingDraftReconciliationProposal;
    review: ReconciliationReviewReceipt;
    contentSource: GitHubDraftPullRequestContentSource;
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
  // oxlint-disable-next-line eslint/sort-keys -- Keep runtime methods grouped by their original publication flow.
  return {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async createFreshRepository() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async inspectExistingDraftSource() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- Keep the runtime interface.
    async inspectOpenPullRequestSource() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- Keep the runtime interface.
    async inspectSourceBranch() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- Keep the runtime interface.
    async inspectHistoricalAppSource() {
      throw new Error(
        "Historical App source inspection is unavailable because the GitHub App provider is not configured. Connect GitHub with repository read access, then retry.",
      );
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async inspectExistingDraftReconciliationSource() {
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
    async inspectAppliedExistingDraftReconciliation() {
      return unavailable();
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async reconcileExistingDraft() {
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
    async sealExistingDraftReconciliation() {
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
    async inspectAppliedRepair(proposal, resolvedTree, observed) {
      if (adapter.inspectAppliedDraftRepair === undefined) {
        throw new Error(
          "The GitHub provider cannot read back an exact draft repair without source bytes.",
        );
      }
      return await adapter.inspectAppliedDraftRepair(proposal, resolvedTree, observed);
    },
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
  const draftReconciliationAdapter: ExistingDraftReconciliationAdapter = {
    async inspectAppliedDraftReconciliation(proposal, observed) {
      if (adapter.inspectAppliedDraftReconciliation === undefined) {
        throw new Error(
          "GitHub draft reconciliation verification is unavailable. Upgrade the GitHub provider before updating this PR.",
        );
      }
      return await adapter.inspectAppliedDraftReconciliation(proposal, observed);
    },
    async inspectExistingDraft(request) {
      return await adapter.inspectExistingDraft(request);
    },
    async inspectInstallation() {
      return await adapter.inspectInstallation(draftPublicationOperation);
    },
    async inspectRepository(request) {
      return await adapter.inspectRepository(request);
    },
    async reconcileExistingDraft(proposal, content) {
      if (adapter.reconcileExistingDraft === undefined) {
        throw new Error(
          "GitHub draft reconciliation is unavailable. Upgrade the GitHub provider before updating this PR.",
        );
      }
      return await adapter.reconcileExistingDraft(proposal, content);
    },
  };
  // oxlint-disable-next-line eslint/sort-keys -- Keep runtime methods grouped by their original publication flow.
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
    async inspectDraftDestination(request) {
      if (request.existingProposal !== undefined) {
        const prior = await receipts.read(request.existingProposal.digest);
        if (prior !== undefined) {
          assertCanonicalGitHubMutationReceipt(prior);
          if (
            prior.kind !== draftReceiptKind ||
            prior.proposalDigest !== request.existingProposal.digest
          ) {
            throw new Error("The prior publication journal does not match this draft proposal.");
          }
          if (prior.status === "pending") {
            throw new Error(
              "Recover the prior draft publication's unknown outcome before preparing another destination review.",
            );
          }
          if (prior.status === "succeeded") {
            throw new Error(
              "Use the existing draft update workflow for the published pull request.",
            );
          }
          if (
            prior.failureCode !== "provider-rejected" ||
            !["reviewed-path-changed", "invalid-publication-material"].includes(prior.providerCode)
          ) {
            throw new Error(
              "The failed draft publication requires recovery before another destination review.",
            );
          }
        }
      }
      if (adapter.inspectDestinationFiles === undefined) {
        throw new Error("The GitHub provider does not support immutable destination review reads.");
      }
      const destination = draftDestinationRepository(request);
      const repository = await adapter.inspectRepository({
        operation: sourceReadOperation,
        ref: `refs/heads/${destination.defaultBranch}`,
        repositoryId: destination.repositoryId,
      });
      assertDraftDestinationRepository(request, repository);
      const installation = await adapter.inspectInstallation(sourceReadOperation);
      if (
        request.destination !== undefined &&
        installation.installationId !== request.destination.installationId
      ) {
        throw new Error(
          "The publication destination differs from the selected GitHub installation.",
        );
      }
      return {
        installation,
        preTree: await adapter.inspectDestinationFiles({ paths: request.paths, repository }),
        repository,
      };
    },
    async readDraftDestinationFile(request) {
      if (adapter.readDestinationFile === undefined) {
        throw new Error(
          "The GitHub provider does not support immutable destination content reads.",
        );
      }
      if (!request.binding.candidatePaths.includes(request.path)) {
        throw new Error("The file is outside the prepared destination review.");
      }
      return await adapter.readDestinationFile({
        path: request.path,
        repository: request.binding.repository,
      });
    },
    async inspectSourceBranch(request) {
      const observed = await adapter.inspectRepository({
        operation: sourceReadOperation,
        ref: `refs/heads/${request.branch}`,
        repositoryId: request.repositoryId,
      });
      if (
        observed.repositoryId !== request.repositoryId ||
        observed.owner !== request.owner ||
        observed.name !== request.name
      ) {
        throw new Error("The selected branch belongs to a different GitHub repository.");
      }
      return { branch: request.branch, headSha: observed.headSha, headTree: observed.headTree };
    },
    async inspectHistoricalAppSource(request) {
      if (adapter.inspectHistoricalAppSource === undefined) {
        throw new Error(
          "Historical App source inspection is unavailable from this GitHub provider. Upgrade the GitHub provider, reconnect GitHub with repository read access, then retry.",
        );
      }
      return await adapter.inspectHistoricalAppSource(request);
    },
    async inspectOpenPullRequestSource(request) {
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
          observed.headRepositoryId,
          observed.baseRepositoryId,
        ],
        [
          request.repositoryId,
          request.owner,
          request.name,
          request.pullRequestNumber,
          "open",
          request.repositoryId,
          request.repositoryId,
        ],
      );
      if (!matchesSelection) {
        throw new Error(
          "The selected PR is not open with a branch in this connected GitHub repository. Choose the correct open PR, then retry source selection.",
        );
      }
      return observed;
    },
    async inspectExistingDraftSource(request) {
      const observed = await this.inspectOpenPullRequestSource(request);
      if (!observed.draft) {
        throw new Error(
          "The selected PR is not an open draft. Source inspection does not authorize updating a non-draft PR.",
        );
      }
      return observed;
    },
    async inspectAppliedExistingDraftUpdate(request) {
      return await inspectAppliedExistingDraftUpdate({ adapter: draftUpdateAdapter, ...request });
    },
    async inspectOwnedPublishedDraftRepairSource(request) {
      const proposal = await proposals.read(request.publishedProposalDigest);
      if (
        proposal === undefined ||
        proposal.intendedOutcome !== "publish-reviewed-change-set-as-draft-pull-request"
      ) {
        throw new Error("The original published draft proposal is unavailable in this tenant.");
      }
      assertExactDraftPullRequestProposal(proposal);
      const prior = await receipts.read(proposal.digest);
      if (prior === undefined)
        throw new Error("The original published draft receipt is unavailable.");
      assertCanonicalGitHubMutationReceipt(prior);
      if (
        prior.kind !== "draft-pull-request" ||
        prior.status !== "succeeded" ||
        !isDeepStrictEqual(
          [
            prior.proposalDigest,
            prior.repositoryId,
            prior.branchName,
            prior.changeSetDigest,
            prior.changedContentDigest,
            prior.normalizedChangedPaths,
          ],
          [
            proposal.digest,
            proposal.repositoryId,
            proposal.branchName,
            proposal.changeSetDigest,
            proposal.changedContentDigest,
            proposal.approvedPaths,
          ],
        )
      ) {
        throw new Error("The original draft journal does not match this publication.");
      }
      const recorded = await request.readPublishedSource({
        repositoryId: prior.repositoryId,
        branch: prior.branchName,
        gitSha: prior.branchSha,
        gitTree: prior.branchTree,
      });
      if (
        recorded === undefined ||
        !isDeepStrictEqual(
          [
            recorded.repositoryId,
            recorded.branch,
            recorded.gitSha,
            recorded.gitTree,
            recorded.reviewDigest,
            recorded.changeSetDigest,
          ],
          [
            prior.repositoryId,
            prior.branchName,
            prior.branchSha,
            prior.branchTree,
            proposal.reviewDigest,
            proposal.changeSetDigest,
          ],
        )
      ) {
        throw new Error(
          "The published source is not recorded for this owned app and accepted specification.",
        );
      }
      const draft = await this.inspectExistingDraftSource({
        repositoryId: proposal.repositoryId,
        owner: proposal.owner,
        name: proposal.name,
        pullRequestNumber: prior.pullRequestNumber,
      });
      await readOwnedDraftPublication({ receipts, proposalDigest: proposal.digest, draft });
      if (draft.verifiedBuilderOrigin?.appId !== request.appId) {
        throw new Error("The current draft does not prove this app's Builder publication origin.");
      }
      if (draft.headSha !== prior.branchSha || draft.headTree !== prior.branchTree) {
        const current = await request.readPublishedSource({
          repositoryId: draft.repositoryId,
          branch: draft.headBranch,
          gitSha: draft.headSha,
          gitTree: draft.headTree,
        });
        const matches =
          current !== undefined &&
          [
            current.repositoryId === draft.repositoryId,
            current.branch === draft.headBranch,
            current.gitSha === draft.headSha,
            current.gitTree === draft.headTree,
          ].every(Boolean);
        if (!matches) {
          throw new Error(
            "The draft advanced beyond the recorded owned source. Recover its exact approved update first.",
          );
        }
      }
      const source = await this.resolveImmutableSource({
        expectedInstallationId: request.expectedInstallationId,
        repositoryId: draft.repositoryId,
        ref: `refs/heads/${draft.headBranch}`,
        expectedSha: draft.headSha,
        expectedTree: draft.headTree,
        approvedByCallId: request.resolvedByCallId,
      });
      return { proposal, publication: prior, draft, source };
    },
    async inspectExistingDraftReconciliationSource(request) {
      const diagnostic: ReconciliationBaselineDiagnostic = {
        source: "none",
        previousReconciliationPresent: request.previousReconciliation !== undefined,
        publishedReconciliationPresent: request.publishedReconciliation !== undefined,
        canonicalPublishedSourceMatched: false,
      };
      try {
        const draft = await this.inspectExistingDraftSource(request);
        const prior = await readOwnedDraftPublication({
          draft,
          proposalDigest: request.priorPublishedProposalDigest,
          receipts,
        });
        const base = await adapter.inspectRepository({
          operation: draftPublicationOperation,
          ref: `refs/heads/${draft.baseBranch}`,
          repositoryId: request.repositoryId,
        });
        if (
          base.repositoryId !== request.repositoryId ||
          base.owner !== request.owner ||
          base.name !== request.name ||
          base.defaultBranch !== draft.baseBranch
        ) {
          throw new Error(
            "The draft PR base no longer matches the connected repository's default branch. Reopen the current PR and select its intended base before reconciliation.",
          );
        }
        const publishedReconciliation = await readAppliedOwnedReconciliation({
          adapter,
          draft,
          prior,
          candidates: [request.previousReconciliation, request.publishedReconciliation],
        });
        const baseline = await ownedPublishedHead({
          draft,
          prior,
          appliedReconciliation: publishedReconciliation,
          readPublishedSource: request.readPublishedSource,
        });
        diagnostic.source = baseline.source;
        diagnostic.canonicalPublishedSourceMatched = baseline.canonicalPublishedSourceMatched;
        const publishedHeadSha = baseline.headSha;
        return {
          base,
          draft,
          ...(publishedHeadSha === undefined ? {} : { publishedHeadSha }),
          ...(publishedReconciliation === undefined ? {} : { publishedReconciliation }),
        };
      } finally {
        reportReconciliationBaseline(diagnostic);
      }
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
      const destination = draftDestinationRepository(request);
      if (request.githubSource === undefined && request.destinationReview === undefined) {
        throw new Error("Review the publication destination before sealing its draft proposal.");
      }
      let repository =
        request.destinationReview?.repository ??
        (await adapter.inspectRepository({
          operation: draftPublicationOperation,
          ref: `refs/heads/${destination.defaultBranch}`,
          repositoryId: destination.repositoryId,
        }));
      const installation = await adapter.inspectInstallation(draftPublicationOperation);
      if (request.destinationReview !== undefined) {
        assertGitHubDestinationReviewBinding(request.destinationReview, {
          applyDigest: request.review.applyDigest,
          postTreeDigest: request.review.postTreeDigest,
          validationDigest: request.review.validationDigest,
        });
        const sameRepository = (["repositoryId", "owner", "name"] as const).every(
          (key) => repository[key] === destination[key],
        );
        const sameInstallation = (
          ["installationId", "accountId", "accountLogin", "accountType"] as const
        ).every((key) => request.destinationReview?.installation[key] === installation[key]);
        const sameDestination =
          request.destination === undefined ||
          (repository.defaultBranch === destination.defaultBranch &&
            installation.installationId === request.destination.installationId);
        if (!sameRepository || !sameInstallation || !sameDestination) {
          throw new Error(
            "The destination review does not match the selected repository and publication installation.",
          );
        }
        // Rebind fresh publication authority while preserving the reviewed
        // immutable destination commit/tree and all repository metadata.
        repository = createRepositoryObservation({
          defaultBranch: repository.defaultBranch,
          headSha: repository.headSha,
          headTree: repository.headTree,
          installationIdentityDigest: installation.digest,
          name: repository.name,
          owner: repository.owner,
          releaseGate: repository.releaseGate,
          repositoryId: repository.repositoryId,
          visibility: repository.visibility,
        });
      }
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
        prior.kind === draftReceiptKind &&
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
    // oxlint-disable-next-line eslint/complexity -- verifies live draft, tenant receipt, and Builder origin before sealing.
    async sealExistingDraftReconciliation(request) {
      const observed = await draftReconciliationAdapter.inspectExistingDraft({
        name: request.githubSource.repository.name,
        number: request.pullRequestNumber,
        owner: request.githubSource.repository.owner,
        repositoryId: request.githubSource.repository.repositoryId,
      });
      if (
        observed.headSha !== request.selectedCheckoutHeadSha ||
        observed.headTree !== request.selectedCheckoutHeadTree ||
        observed.headSha !== request.review.headSha ||
        observed.headTree !== request.review.headTree
      ) {
        throw new Error(
          "The selected checkout or draft PR head moved during conflict resolution. Reopen its current branch, resolve against the current base, and review both diffs again.",
        );
      }
      const prior = await readOwnedDraftPublication({
        draft: observed,
        proposalDigest: request.priorPublishedProposalDigest,
        receipts,
      });
      // oxlint-disable-next-line sonarjs/expression-complexity -- verify all tenant receipt identity fields together.
      if (
        // oxlint-disable-next-line sonarjs/expression-complexity -- one tenant receipt predicate.
        prior !== undefined &&
        (prior.status !== "succeeded" ||
          prior.kind !== draftReceiptKind ||
          prior.repositoryId !== observed.repositoryId ||
          prior.pullRequestNumber !== observed.number ||
          (request.priorPublishedProposalDigest !== undefined &&
            prior.proposalDigest !== request.priorPublishedProposalDigest))
      ) {
        throw new Error(
          "The selected draft PR does not match Builder's tenant-scoped publication receipt. Reopen the correct PR branch and review its current files.",
        );
      }
      if (prior === undefined && request.priorPublishedProposalDigest !== undefined) {
        throw new Error(
          "The original Builder publication receipt is unavailable in this tenant. Reopen the current PR branch and verify its Builder origin before retrying.",
        );
      }
      const adopted =
        prior === undefined
          ? await adoptions?.read(observed.repositoryId, observed.pullRequestId)
          : undefined;
      // oxlint-disable-next-line sonarjs/expression-complexity -- reject any missing or mismatched Builder origin evidence.
      if (
        // oxlint-disable-next-line sonarjs/expression-complexity -- one Builder origin predicate.
        (prior === undefined && adopted === undefined) ||
        observed.verifiedBuilderOrigin === undefined ||
        (adopted !== undefined &&
          !isDeepStrictEqual(
            [adopted.appId, adopted.authorId, adopted.builderMarker, adopted.pullRequestNumber],
            [
              observed.verifiedBuilderOrigin.appId,
              observed.verifiedBuilderOrigin.authorId,
              observed.verifiedBuilderOrigin.marker,
              observed.number,
            ],
          ))
      ) {
        throw new Error(
          "Builder cannot verify the draft PR's origin marker and tenant-scoped publication or adoption record. Refresh its provenance before reconciling.",
        );
      }
      const repository = await adapter.inspectRepository({
        operation: draftPublicationOperation,
        ref: `refs/heads/${request.githubSource.repository.defaultBranch}`,
        repositoryId: request.githubSource.repository.repositoryId,
      });
      const installation = await adapter.inspectInstallation(draftPublicationOperation);
      return await sealExistingDraftReconciliation({
        adapter: draftReconciliationAdapter,
        installation,
        originMarker: observed.verifiedBuilderOrigin.marker,
        priorPublicationDigest: prior?.digest ?? adopted?.adoptionDigest ?? "",
        pullRequestNumber: request.pullRequestNumber,
        repository,
        review: request.review,
        selectedSourceRef:
          prior === undefined
            ? request.githubSource.resolvedRef
            : `refs/heads/${observed.headBranch}`,
      });
    },
    async inspectAppliedExistingDraftReconciliation(request) {
      return await inspectAppliedExistingDraftReconciliation({
        adapter: draftReconciliationAdapter,
        proposal: request.proposal,
        review: request.review,
      });
    },
    async reconcileExistingDraft(request) {
      return await reconcileExistingDraft({
        adapter: draftReconciliationAdapter,
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
