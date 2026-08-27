import type {
  DraftPullRequestSuccessReceipt,
  FreshRepositorySuccessReceipt,
  ImmutableGitHubSourceReceipt,
} from "@/lib/repository/github-publication";

export type GitHubPublicationRuntimeStatus = {
  version: 1;
  enabled: false;
  adapterConfigured: false;
  genericShellAuthority: false;
  liveGitHubCallsAvailable: false;
  supportedOperations: readonly [
    "resolve-immutable-existing-source",
    "create-approved-private-fresh-history-repository",
    "publish-approved-branch-and-draft-pull-request",
    "recover-lost-response-by-idempotency-key",
  ];
  releaseGate: {
    name: "REPOSITORY_RELEASE_ENABLED";
    requiredState: "absent";
  };
  reason: "A least-privilege GitHub App adapter and durable receipt store are not configured on this host.";
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

const unavailableStatus: GitHubPublicationRuntimeStatus = {
  version: 1,
  enabled: false,
  adapterConfigured: false,
  genericShellAuthority: false,
  liveGitHubCallsAvailable: false,
  supportedOperations: [
    "resolve-immutable-existing-source",
    "create-approved-private-fresh-history-repository",
    "publish-approved-branch-and-draft-pull-request",
    "recover-lost-response-by-idempotency-key",
  ],
  releaseGate: {
    name: "REPOSITORY_RELEASE_ENABLED",
    requiredState: "absent",
  },
  reason:
    "A least-privilege GitHub App adapter and durable receipt store are not configured on this host.",
};

const unavailable = (): never => {
  throw new Error(
    "GitHub acquisition and publication are disabled: no least-privilege GitHub App adapter or durable receipt store is configured.",
  );
};

/**
 * Fail-closed runtime seam. A later provider-composition slice must replace this
 * with an installation-bound adapter and durable CAS store. The typed tools do
 * not accept a token, command, endpoint, or caller-supplied provider response.
 */
export const githubPublicationRuntime: GitHubPublicationRuntime = {
  async status() {
    return unavailableStatus;
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
