import {
  createApprovedFreshRepository,
  publishApprovedDraftPullRequest,
  resolveImmutableExistingSource,
  type DraftPullRequestSuccessReceipt,
  type FreshRepositorySuccessReceipt,
  type GitHubPublicationAdapter,
  type GitHubPublicationReceiptStore,
  type ImmutableGitHubSourceReceipt,
} from "../repository/github-publication";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";

const supportedOperations = [
  "resolve-immutable-existing-source",
  "create-approved-private-fresh-history-repository",
  "publish-approved-branch-and-draft-pull-request",
  "recover-lost-response-by-idempotency-key",
] as const;

export type GitHubPublicationRuntimeStatus = {
  version: 2;
  enabled: boolean;
  adapterConfigured: boolean;
  durableStoreConfigured: boolean;
  genericShellAuthority: false;
  liveGitHubCallsAvailable: boolean;
  supportedOperations: typeof supportedOperations;
  releaseGate: {
    name: "REPOSITORY_RELEASE_ENABLED";
    requiredState: "absent";
  };
  reason: string;
};

export interface GitHubPublicationRuntime {
  status(): Promise<GitHubPublicationRuntimeStatus>;
  resolveImmutableSource(input: {
    repositoryId: string;
    ref: string;
    expectedSha: string;
    expectedTree: string;
    approvedByCallId: string;
  }): Promise<ImmutableGitHubSourceReceipt>;
  createFreshRepository(input: {
    expectedProposalDigest: string;
    approvedByCallId: string;
  }): Promise<FreshRepositorySuccessReceipt>;
  publishDraftPullRequest(input: {
    expectedProposalDigest: string;
    approvedByCallId: string;
  }): Promise<DraftPullRequestSuccessReceipt>;
}

function runtimeStatus(enabled: boolean): GitHubPublicationRuntimeStatus {
  return {
    version: 2,
    enabled,
    adapterConfigured: enabled,
    durableStoreConfigured: enabled,
    genericShellAuthority: false,
    liveGitHubCallsAvailable: enabled,
    supportedOperations,
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED",
      requiredState: "absent",
    },
    reason: enabled
      ? "The explicit installation adapter and durable PostgreSQL stores are configured."
      : "A least-privilege GitHub App adapter and durable receipt store are not configured on this host.",
  };
}

const unavailable = (): never => {
  throw new Error(
    "GitHub acquisition and publication are disabled: no least-privilege GitHub App adapter or durable receipt store is configured.",
  );
};

function disabledRuntime(): GitHubPublicationRuntime {
  return {
    async status() {
      return runtimeStatus(false);
    },
    async resolveImmutableSource() {
      return unavailable();
    },
    async createFreshRepository() {
      return unavailable();
    },
    async publishDraftPullRequest() {
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
export function composeGitHubPublicationRuntime(input: {
  enabled: boolean;
  adapter?: GitHubPublicationAdapter;
  proposals?: GitHubPublicationProposalStore;
  receipts?: GitHubPublicationReceiptStore;
}): GitHubPublicationRuntime {
  if (!input.enabled) return disabledRuntime();
  if (
    input.adapter === undefined ||
    input.proposals === undefined ||
    input.receipts === undefined
  ) {
    throw new Error(
      "GitHub publication cannot be enabled without its typed adapter and durable stores.",
    );
  }
  const adapter = input.adapter;
  const proposals = input.proposals;
  const receipts = input.receipts;
  return {
    async status() {
      return runtimeStatus(true);
    },
    async resolveImmutableSource(request) {
      return resolveImmutableExistingSource({
        adapter,
        repositoryId: request.repositoryId,
        ref: request.ref,
        expectedSha: request.expectedSha,
        expectedTree: request.expectedTree,
        resolvedByCallId: request.approvedByCallId,
      });
    },
    async createFreshRepository(request) {
      const proposal = await proposals.read(request.expectedProposalDigest);
      if (
        proposal === undefined ||
        proposal.digest !== request.expectedProposalDigest ||
        proposal.intendedOutcome !== "create-private-fresh-history-repository"
      ) {
        throw new Error(
          "The exact fresh-repository proposal is unavailable or changed.",
        );
      }
      return createApprovedFreshRepository({
        adapter,
        store: receipts,
        proposal,
        approvedByCallId: request.approvedByCallId,
      });
    },
    async publishDraftPullRequest(request) {
      const proposal = await proposals.read(request.expectedProposalDigest);
      if (
        proposal === undefined ||
        proposal.digest !== request.expectedProposalDigest ||
        proposal.intendedOutcome !==
          "publish-reviewed-change-set-as-draft-pull-request"
      ) {
        throw new Error(
          "The exact draft-pull-request proposal is unavailable or changed.",
        );
      }
      return publishApprovedDraftPullRequest({
        adapter,
        store: receipts,
        proposal,
        approvedByCallId: request.approvedByCallId,
      });
    },
  };
}

/** Shipped default. Deployment composition must enable the runtime explicitly. */
export const githubPublicationRuntime = composeGitHubPublicationRuntime({
  enabled: false,
});
