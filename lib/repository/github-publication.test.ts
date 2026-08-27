import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GITHUB_PUBLICATION_VERSION,
  GitHubOutcomeUnknownError,
  assertCanonicalGitHubMutationReceipt,
  assertExactDraftPullRequestProposal,
  assertExactInstallationIdentity,
  assertExactRepositoryObservation,
  createApprovedFreshRepository,
  createDraftPullRequestProposal,
  createFreshRepositoryProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  publishApprovedDraftPullRequest,
  resolveImmutableExistingSource,
  type DraftPublicationReadBack,
  type DraftPullRequestProposal,
  type FreshRepositoryProposal,
  type FreshRepositoryReadBack,
  type GitHubInstallationIdentity,
  type GitHubMutationAcknowledgement,
  type GitHubMutationReceipt,
  type GitHubOperation,
  type GitHubPublicationAdapter,
  type GitHubPublicationReceiptStore,
  type GitHubRepositoryObservation,
} from "./github-publication";
import {
  createReviewedChangeSetReceipt,
  type NormalizedChangeSet,
} from "./reviewed-change-set";
import type { SourceReceiptEvidence } from "./source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "./supported-template";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = "1".repeat(40);
const tree = "2".repeat(40);
const branchSha = "3".repeat(40);
const branchTree = "4".repeat(40);

function source(
  sourceKind: SourceReceiptEvidence["sourceKind"] = "fresh-template",
): SourceReceiptEvidence {
  const unsigned = {
    version: 3 as const,
    sourceKind,
    sourceSha: sha,
    sourceTree: tree,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: "4".repeat(64),
    contractDigest: "5".repeat(64),
    releaseEnabled: false as const,
  } as const;
  return { ...unsigned, digest: hash(unsigned) };
}

function review() {
  const unsigned = {
    version: 2 as const,
    validationDigest: "6".repeat(64),
    applyDigest: "7".repeat(64),
    proposalDigest: "8".repeat(64),
    contractDigest: "9".repeat(64),
    repositoryContractDigest: "5".repeat(64),
    sourceSha: sha,
    sourceTree: tree,
    eligibilityDigest: "4".repeat(64),
    workspaceDigest: "a".repeat(64),
    appSpecDigest: "b".repeat(64),
    appSpecPath: "prototype/demo/app-spec.md",
    artifactRevision: "c".repeat(64),
    dependencyReceiptDigest: "d".repeat(64),
    identityDigest: "e".repeat(64),
    imageDigest: `sha256:${"f".repeat(64)}`,
    dependencyCacheDigest: "0".repeat(64),
    targetReceipt: {
      version: 1 as const,
      contractPath: ".config/repository-template.json",
      topology: {
        path: "apps.json",
        oldDigest: "1".repeat(64),
        newDigest: "2".repeat(64),
      },
    },
    preTreeDigest: "3".repeat(64),
    postTreeDigest: "4".repeat(64),
    changedContentDigest: "5".repeat(64),
    changes: [
      {
        path: "apps/demo/page.tsx",
        kind: "added" as const,
        after: { mode: "644", digest: "6".repeat(64) },
      },
    ],
    approvedPaths: ["apps/demo/page.tsx"],
  };
  const changeSet: NormalizedChangeSet = {
    ...unsigned,
    digest: hash(unsigned),
  };
  return createReviewedChangeSetReceipt(changeSet, "review-call");
}

function installation(
  operation: GitHubOperation,
  repositoryIds: readonly string[] = ["100"],
): GitHubInstallationIdentity {
  return createGitHubInstallationIdentity({
    operation,
    installationId: "10",
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    repositorySelection: "selected",
    selectedRepositoryIds: repositoryIds,
  });
}

function repository(
  identity: GitHubInstallationIdentity,
  overrides: Partial<
    Omit<GitHubRepositoryObservation, "version" | "digest">
  > = {},
): GitHubRepositoryObservation {
  return createRepositoryObservation({
    repositoryId: "100",
    owner: "withAutograph",
    name: "example-app",
    visibility: "private",
    defaultBranch: "main",
    headSha: sha,
    headTree: tree,
    installationIdentityDigest: identity.digest,
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED",
      configured: false,
    },
    ...overrides,
  });
}

function freshReadBack(
  proposal: FreshRepositoryProposal,
  identity: GitHubInstallationIdentity,
): FreshRepositoryReadBack {
  const repo = repository(identity, {
    repositoryId: "101",
    owner: proposal.destinationOwner,
    name: proposal.destinationName,
    headSha: branchSha,
    headTree: proposal.sourceTree,
  });
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    idempotencyKey: proposal.idempotencyKey,
    repository: repo,
    initialCommit: {
      sha: branchSha,
      tree: proposal.sourceTree,
      parents: [] as const,
    },
  };
  return { ...unsigned, digest: hash(unsigned) };
}

function draftReadBack(
  proposal: DraftPullRequestProposal,
  repo: GitHubRepositoryObservation,
  state: "absent" | "complete" | "branch-only" = "absent",
): DraftPublicationReadBack {
  const branch =
    state === "absent"
      ? ({ status: "absent" } as const)
      : ({
          status: "present",
          branchName: proposal.branchName,
          branchSha,
          branchTree,
          normalizedChangedPaths: proposal.approvedPaths,
          changedContentDigest: proposal.changedContentDigest,
          idempotencyKey: proposal.idempotencyKey,
        } as const);
  const pullRequest =
    state !== "complete"
      ? ({ status: "absent" } as const)
      : ({
          status: "present",
          pullRequestId: "400",
          pullRequestNumber: 7,
          draft: true,
          headRepositoryId: proposal.repositoryId,
          headBranch: proposal.branchName,
          headSha: branchSha,
          baseRepositoryId: proposal.repositoryId,
          baseBranch: proposal.baseBranch,
          baseSha: proposal.baseSha,
          changeSetDigest: proposal.changeSetDigest,
          idempotencyKey: proposal.idempotencyKey,
        } as const);
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    idempotencyKey: proposal.idempotencyKey,
    repository: repo,
    changedPathsSinceBase: [] as readonly string[],
    branch,
    pullRequest,
  };
  return { ...unsigned, digest: hash(unsigned) };
}

class Store implements GitHubPublicationReceiptStore {
  readonly values = new Map<string, GitHubMutationReceipt>();
  rejectTerminal = false;

  async read(key: string) {
    return this.values.get(key);
  }

  async compareAndSet(
    key: string,
    expected: string | undefined,
    value: GitHubMutationReceipt,
  ) {
    if (this.values.get(key)?.digest !== expected) return false;
    if (this.rejectTerminal && value.status !== "pending") return false;
    this.values.set(key, value);
    return true;
  }
}

class Adapter implements GitHubPublicationAdapter {
  readonly identities = {
    resolve: installation("resolve-existing-source"),
    create: installation("create-fresh-repository"),
    publish: installation("publish-draft-pull-request"),
  };
  resolveRepo = repository(this.identities.resolve);
  publishRepo = repository(this.identities.publish);
  destination: "absent" | GitHubRepositoryObservation = "absent";
  freshOutcome: FreshRepositoryReadBack | undefined;
  draftOutcome: DraftPublicationReadBack | undefined;
  freshCalls = 0;
  draftCalls = 0;
  freshAcknowledgement: GitHubMutationAcknowledgement = {
    status: "accepted",
    requestId: "fresh-request",
  };
  draftAcknowledgement: GitHubMutationAcknowledgement = {
    status: "accepted",
    requestId: "draft-request",
  };
  throwFreshMutation = false;
  throwDraftMutation = false;
  throwFreshReadBack = false;
  throwDraftReadBack = false;

  async inspectInstallation(operation: GitHubOperation) {
    return operation === "resolve-existing-source"
      ? this.identities.resolve
      : operation === "create-fresh-repository"
        ? this.identities.create
        : this.identities.publish;
  }

  async inspectRepository() {
    return this.resolveRepo;
  }

  async inspectDestination() {
    return this.destination;
  }

  async inspectFreshRepositoryOutcome() {
    if (this.throwFreshReadBack) throw new Error("read-back-failed");
    return this.freshOutcome;
  }

  async createPrivateFreshHistoryRepository(proposal: FreshRepositoryProposal) {
    this.freshCalls += 1;
    if (this.throwFreshMutation) throw new Error("transport-failed");
    if (this.freshAcknowledgement.status === "accepted")
      this.freshOutcome = freshReadBack(proposal, this.identities.create);
    return this.freshAcknowledgement;
  }

  async inspectDraftPublication(proposal: DraftPullRequestProposal) {
    if (this.throwDraftReadBack) throw new Error("read-back-failed");
    return this.draftOutcome ?? draftReadBack(proposal, this.publishRepo);
  }

  async publishDraftPullRequest(proposal: DraftPullRequestProposal) {
    this.draftCalls += 1;
    if (this.throwDraftMutation) throw new Error("transport-failed");
    if (this.draftAcknowledgement.status === "accepted")
      this.draftOutcome = draftReadBack(proposal, this.publishRepo, "complete");
    return this.draftAcknowledgement;
  }
}

function freshProposal(adapter: Adapter) {
  return createFreshRepositoryProposal({
    installation: adapter.identities.create,
    source: source(),
    review: review(),
    destinationOwner: "withAutograph",
    destinationName: "new-app",
  });
}

function draftProposal(adapter: Adapter) {
  return createDraftPullRequestProposal({
    installation: adapter.identities.publish,
    repository: adapter.publishRepo,
    review: review(),
    changedPathsSinceBase: [],
    title: "Add demo",
  });
}

describe("closed GitHub publication contract", () => {
  it("derives operation-specific least-privilege identities", () => {
    const resolve = installation("resolve-existing-source");
    const create = installation("create-fresh-repository");
    const publish = installation("publish-draft-pull-request");
    expect(resolve.permissions).toEqual({
      metadata: "read",
      contents: "read",
      pullRequests: "none",
      administration: "none",
      variables: "read",
    });
    expect(create.permissions.pullRequests).toBe("none");
    expect(create.permissions.administration).toBe("write");
    expect(publish.permissions.administration).toBe("none");
    expect(publish.permissions.pullRequests).toBe("write");
  });

  it("rejects unknown keys and permission escalation", () => {
    const identity = installation("publish-draft-pull-request");
    expect(() =>
      assertExactInstallationIdentity({
        ...identity,
        token: "secret",
      } as never),
    ).toThrow(/schema/u);
    expect(() =>
      assertExactInstallationIdentity({
        ...identity,
        permissions: { ...identity.permissions, administration: "write" },
      } as GitHubInstallationIdentity),
    ).toThrow(/over-privileged/u);
  });

  it("resolves only constrained exact private branch refs", async () => {
    const adapter = new Adapter();
    const result = await resolveImmutableExistingSource({
      adapter,
      repositoryId: "100",
      ref: "refs/heads/main",
      expectedSha: sha,
      expectedTree: tree,
      resolvedByCallId: "resolve-call",
    });
    expect(result.repository.repositoryId).toBe("100");
    for (const ref of [
      "main",
      "refs/tags/v1",
      "refs/heads/../main",
      "refs/heads/x.lock",
    ])
      await expect(
        resolveImmutableExistingSource({
          adapter,
          repositoryId: "100",
          ref,
          expectedSha: sha,
          expectedTree: tree,
          resolvedByCallId: "resolve-call",
        }),
      ).rejects.toThrow(/invalid/u);
  });

  it("rejects repository observation unknown keys, digest drift, and release gate drift", () => {
    const repo = repository(installation("resolve-existing-source"));
    expect(() =>
      assertExactRepositoryObservation({ ...repo, url: "private" } as never),
    ).toThrow(/schema/u);
    expect(() =>
      assertExactRepositoryObservation({ ...repo, headTree: "9".repeat(40) }),
    ).toThrow(/non-canonical/u);
    expect(() =>
      createRepositoryObservation({
        ...repo,
        releaseGate: { name: "REPOSITORY_RELEASE_ENABLED", configured: true },
      } as never),
    ).toThrow(/release-enabled/u);
  });

  it("rejects proposal unknown keys, unsafe names, titles, and paths", () => {
    const adapter = new Adapter();
    const fresh = freshProposal(adapter);
    const draft = draftProposal(adapter);
    expect(() =>
      assertExactDraftPullRequestProposal({
        ...draft,
        endpoint: "https://example.com",
      } as never),
    ).toThrow(/schema/u);
    expect(() =>
      createFreshRepositoryProposal({
        installation: adapter.identities.create,
        source: source(),
        review: review(),
        destinationOwner: "withAutograph",
        destinationName: "../bad",
      }),
    ).toThrow(/outside/u);
    expect(() =>
      createDraftPullRequestProposal({
        installation: adapter.identities.publish,
        repository: adapter.publishRepo,
        review: review(),
        changedPathsSinceBase: [],
        title: "bad\nbody",
      }),
    ).toThrow(/unauthorized/u);
    const canonicalReview = review();
    expect(() =>
      createDraftPullRequestProposal({
        installation: adapter.identities.publish,
        repository: adapter.publishRepo,
        review: {
          ...canonicalReview,
          changedContentDigest: "9".repeat(64),
        },
        changedPathsSinceBase: [],
        title: "Add demo",
      }),
    ).toThrow(/non-canonical/u);
    expect(fresh.visibility).toBe("private");
  });

  it("proves parentless fresh history, exact default branch/tree, and release-gate absence", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = freshProposal(adapter);
    const result = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      approvedByCallId: "approve",
    });
    expect(result.parentCount).toBe(0);
    expect(result.initialCommitTree).toBe(proposal.sourceTree);
    expect(result.repository.defaultBranch).toBe("main");
    expect(result.releaseGateAbsent).toBe(true);
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("returns the exact terminal receipt on idempotent retry", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = freshProposal(adapter);
    const first = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      approvedByCallId: "approve",
    });
    const second = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      approvedByCallId: "different-call",
    });
    expect(second).toEqual(first);
    expect(adapter.freshCalls).toBe(1);
  });

  it("keeps mutation transport failure pending and reconciles by independent read-back", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = freshProposal(adapter);
    adapter.throwFreshMutation = true;
    await expect(
      createApprovedFreshRepository({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect((await store.read(proposal.digest))?.status).toBe("pending");
    adapter.throwFreshMutation = false;
    adapter.freshOutcome = freshReadBack(proposal, adapter.identities.create);
    const recovered = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      approvedByCallId: "retry",
    });
    expect(recovered.recoveredFromPending).toBe(true);
    expect(adapter.freshCalls).toBe(1);
  });

  it("keeps read-back and terminal-store failures pending", async () => {
    for (const failure of ["read-back", "store"] as const) {
      const adapter = new Adapter();
      const store = new Store();
      const proposal = freshProposal(adapter);
      if (failure === "read-back") adapter.throwFreshReadBack = true;
      else store.rejectTerminal = true;
      await expect(
        createApprovedFreshRepository({
          adapter,
          store,
          proposal,
          approvedByCallId: "approve",
        }),
      ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
      expect((await store.read(proposal.digest))?.status).toBe("pending");
    }
  });

  it("distinguishes explicit provider rejection and sanitizes its code", async () => {
    const adapter = new Adapter();
    adapter.freshAcknowledgement = {
      status: "rejected",
      code: "secret raw provider message",
    };
    const store = new Store();
    const proposal = freshProposal(adapter);
    await expect(
      createApprovedFreshRepository({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toThrow(/rejected/u);
    const failure = await store.read(proposal.digest);
    expect(failure?.status).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain(
      "secret raw provider message",
    );
  });

  it("proves exact branch tree/content/paths and PR head/base/draft read-back", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = draftProposal(adapter);
    const result = await publishApprovedDraftPullRequest({
      adapter,
      store,
      proposal,
      approvedByCallId: "approve",
    });
    expect(result.branchTree).toBe(branchTree);
    expect(result.normalizedChangedPaths).toEqual(proposal.approvedPaths);
    expect(result.changedContentDigest).toBe(proposal.changedContentDigest);
    expect(result.baseSha).toBe(proposal.baseSha);
    expect(result.draft).toBe(true);
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("refuses stale, overlapping, and branch-collision read-back before mutation", async () => {
    const mutations: Array<
      (adapter: Adapter, proposal: DraftPullRequestProposal) => void
    > = [
      (adapter, proposal) => {
        const value = draftReadBack(proposal, adapter.publishRepo);
        const unsigned = { ...value, changedPathsSinceBase: ["apps/demo"] };
        delete (unsigned as Partial<DraftPublicationReadBack>).digest;
        adapter.draftOutcome = {
          ...unsigned,
          digest: hash(unsigned),
        } as DraftPublicationReadBack;
      },
      (adapter, proposal) => {
        const staleRepo = repository(adapter.identities.publish, {
          headSha: "9".repeat(40),
        });
        adapter.draftOutcome = draftReadBack(proposal, staleRepo);
      },
      (adapter, proposal) => {
        adapter.draftOutcome = draftReadBack(
          proposal,
          adapter.publishRepo,
          "branch-only",
        );
      },
    ];
    for (const mutate of mutations) {
      const adapter = new Adapter();
      const proposal = draftProposal(adapter);
      mutate(adapter, proposal);
      await expect(
        publishApprovedDraftPullRequest({
          adapter,
          store: new Store(),
          proposal,
          approvedByCallId: "approve",
        }),
      ).rejects.toThrow();
      expect(adapter.draftCalls).toBe(0);
    }
  });

  it("keeps malformed post-mutation read-back pending rather than recording rejection", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const original = adapter.publishDraftPullRequest.bind(adapter);
    adapter.publishDraftPullRequest = async (value) => {
      const ack = await original(value);
      if (adapter.draftOutcome?.pullRequest.status === "present") {
        const malformed = {
          ...adapter.draftOutcome,
          pullRequest: {
            ...adapter.draftOutcome.pullRequest,
            draft: false,
          },
        };
        const { digest: _old, ...unsigned } = malformed;
        void _old;
        adapter.draftOutcome = { ...unsigned, digest: hash(unsigned) };
      }
      return ack;
    };
    const store = new Store();
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect((await store.read(proposal.digest))?.status).toBe("pending");
  });

  it("keeps unknown-key provider read-back pending", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const original = adapter.publishDraftPullRequest.bind(adapter);
    adapter.publishDraftPullRequest = async (value) => {
      const acknowledgement = await original(value);
      const current = adapter.draftOutcome;
      if (current !== undefined) {
        const { digest: _old, ...unsigned } = current;
        void _old;
        const injected = { ...unsigned, authorization: "must-not-be-accepted" };
        adapter.draftOutcome = {
          ...injected,
          digest: hash(injected),
        } as DraftPublicationReadBack;
      }
      return acknowledgement;
    };
    const store = new Store();
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect((await store.read(proposal.digest))?.status).toBe("pending");
  });

  it("recovers a lost draft response without a duplicate branch or PR", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    adapter.throwDraftMutation = true;
    const store = new Store();
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    adapter.throwDraftMutation = false;
    adapter.draftOutcome = draftReadBack(
      proposal,
      adapter.publishRepo,
      "complete",
    );
    const recovered = await publishApprovedDraftPullRequest({
      adapter,
      store,
      proposal,
      approvedByCallId: "retry",
    });
    expect(recovered.recoveredFromPending).toBe(true);
    expect(adapter.draftCalls).toBe(1);
  });

  it("rejects corrupted or cross-proposal journals before provider calls", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const store = new Store();
    store.values.set(proposal.digest, {
      version: GITHUB_PUBLICATION_VERSION,
      kind: "draft-pull-request",
      status: "pending",
      proposalDigest: proposal.digest,
      idempotencyKey: "9".repeat(64),
      approvedByCallId: "approve",
      digest: "8".repeat(64),
    });
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toThrow(/digest|proposal/u);
    expect(adapter.draftCalls).toBe(0);
  });

  it("rejects a digest-valid journal carrying an unknown key", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const store = new Store();
    const unsigned = {
      version: GITHUB_PUBLICATION_VERSION,
      kind: "draft-pull-request" as const,
      status: "pending" as const,
      proposalDigest: proposal.digest,
      idempotencyKey: proposal.idempotencyKey,
      approvedByCallId: "approve",
      rawProviderPayload: "must-not-be-accepted",
    };
    store.values.set(proposal.digest, {
      ...unsigned,
      digest: hash(unsigned),
    } as GitHubMutationReceipt);
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        approvedByCallId: "approve",
      }),
    ).rejects.toThrow(/schema/u);
    expect(adapter.draftCalls).toBe(0);
  });

  it("rejects proposal digest/idempotency tampering before provider calls", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    for (const tampered of [
      { ...proposal, title: "Tampered" },
      { ...proposal, idempotencyKey: "9".repeat(64) },
      { ...proposal, approvedPaths: ["../unsafe"] },
    ]) {
      await expect(
        publishApprovedDraftPullRequest({
          adapter,
          store: new Store(),
          proposal: tampered,
          approvedByCallId: "approve",
        }),
      ).rejects.toThrow();
    }
    expect(adapter.draftCalls).toBe(0);
  });
});
