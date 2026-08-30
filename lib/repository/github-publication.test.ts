import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  GITHUB_PUBLICATION_VERSION,
  GitHubOutcomeUnknownError,
  assertCanonicalGitHubMutationReceipt,
  assertExactDraftPullRequestProposal,
  assertExactFreshRepositoryProposal,
  assertExactGitHubPublicationContent,
  assertExactInstallationIdentity,
  assertExactRepositoryObservation,
  createApprovedFreshRepository,
  createDraftPullRequestProposal,
  createFreshRepositoryProposal,
  createGitHubInstallationIdentity,
  createRepositoryObservation,
  publishApprovedDraftPullRequest,
  readExactGitHubFreshRepositoryContent,
  readExactGitHubPublicationContent,
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
  type GitHubDraftPullRequestContent,
  type GitHubFreshRepositoryContent,
  type GitHubPublicationReceiptStore,
  type GitHubRepositoryObservation,
} from "./github-publication";
import {
  createReviewedChangeSetReceipt,
  type NormalizedChangeSet,
} from "./reviewed-change-set";
import type { SourceReceiptEvidence } from "./source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "./supported-template";
import { compareOverlayPaths } from "./target-apply";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha = "1".repeat(40);
const templateBytes = new TextEncoder().encode("# Template\n");
const templateDigest = createHash("sha256").update(templateBytes).digest("hex");
const templateObjectId = createHash("sha1")
  .update(Buffer.from(`blob ${templateBytes.byteLength}\0`))
  .update(templateBytes)
  .digest("hex");
const treeContent = Buffer.concat([
  Buffer.from("100644 README.md\0"),
  Buffer.from(templateObjectId, "hex"),
]);
const tree = createHash("sha1")
  .update(Buffer.from(`tree ${treeContent.byteLength}\0`))
  .update(treeContent)
  .digest("hex");
const branchSha = "3".repeat(40);
const branchTree = "4".repeat(40);
const reviewedBytes = new TextEncoder().encode("export default 'demo';\n");
const reviewedBytesDigest = createHash("sha256")
  .update(reviewedBytes)
  .digest("hex");

function publicationContentSource(
  bytes: Uint8Array | null = reviewedBytes,
  onRead?: (path: string) => void,
  mode = "644",
) {
  return {
    async readFreshTree() {
      onRead?.("README.md");
      return {
        version: 1 as const,
        kind: "fresh-repository-source-tree" as const,
        sourceSha: sha,
        sourceTree: tree,
        files: [
          {
            path: "README.md",
            mode: "100644" as const,
            objectId: templateObjectId,
            digest: templateDigest,
            bytes: templateBytes,
          },
        ],
      };
    },
    async readFile(path: string) {
      onRead?.(path);
      return bytes === null
        ? null
        : { mode, digest: reviewedBytesDigest, bytes };
    },
  };
}

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

function review(
  inputChanges: NormalizedChangeSet["changes"] = [
    {
      path: "apps/demo/page.tsx",
      kind: "added" as const,
      after: { mode: "644", digest: reviewedBytesDigest },
    },
  ],
) {
  const changes = [...inputChanges].toSorted((left, right) =>
    compareOverlayPaths(left.path, right.path),
  );
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
    dependencyCacheContentDigest: "1".repeat(64),
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
    changedContentDigest: hash(changes),
    changes,
    approvedPaths: changes.map(({ path }) => path),
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
  freshContent: GitHubFreshRepositoryContent | undefined;
  draftContent: GitHubDraftPullRequestContent | undefined;

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

  async createPrivateFreshHistoryRepository(
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ) {
    this.freshCalls += 1;
    this.freshContent = content;
    if (this.throwFreshMutation) throw new Error("transport-failed");
    if (this.freshAcknowledgement.status === "accepted")
      this.freshOutcome = freshReadBack(proposal, this.identities.create);
    return this.freshAcknowledgement;
  }

  async inspectDraftPublication(proposal: DraftPullRequestProposal) {
    if (this.throwDraftReadBack) throw new Error("read-back-failed");
    return this.draftOutcome ?? draftReadBack(proposal, this.publishRepo);
  }

  async publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ) {
    this.draftCalls += 1;
    this.draftContent = content;
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
  it("round-trips UTF-8 ordered review paths into GitHub publication", () => {
    const adapter = new Adapter();
    const canonicalReview = review([
      {
        path: "apps/demo/\u{10000}.tsx",
        kind: "added",
        after: { mode: "644", digest: reviewedBytesDigest },
      },
      {
        path: ".codex/skills/example/agents/openai.yaml",
        kind: "added",
        after: { mode: "644", digest: reviewedBytesDigest },
      },
      {
        path: "apps/demo/\u{e000}.tsx",
        kind: "added",
        after: { mode: "644", digest: reviewedBytesDigest },
      },
      {
        path: ".codex/skills/example/SKILL.md",
        kind: "added",
        after: { mode: "644", digest: reviewedBytesDigest },
      },
    ]);
    const roundTripped = JSON.parse(
      JSON.stringify(canonicalReview),
    ) as typeof canonicalReview;
    const proposal = createDraftPullRequestProposal({
      installation: adapter.identities.publish,
      repository: adapter.publishRepo,
      review: roundTripped,
      changedPathsSinceBase: [],
      title: "Add demo",
    });

    expect(proposal.approvedPaths).toEqual([
      ".codex/skills/example/SKILL.md",
      ".codex/skills/example/agents/openai.yaml",
      "apps/demo/\u{e000}.tsx",
      "apps/demo/\u{10000}.tsx",
    ]);
    expect(() => assertExactDraftPullRequestProposal(proposal)).not.toThrow();
  });

  it("derives operation-specific least-privilege identities", () => {
    const resolve = installation("resolve-existing-source");
    const create = installation("create-fresh-repository");
    const publish = installation("publish-draft-pull-request");
    expect(resolve.permissions).toEqual({
      metadata: "read",
      contents: "read",
      workflows: "none",
      pullRequests: "none",
      administration: "none",
      variables: "read",
    });
    expect(create.permissions.pullRequests).toBe("none");
    expect(create.permissions.administration).toBe("write");
    expect(create.permissions.workflows).toBe("write");
    expect(publish.permissions.administration).toBe("none");
    expect(publish.permissions.pullRequests).toBe("write");
    expect(publish.permissions.workflows).toBe("write");
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

  it("accepts exact active release-gate observations and rejects schema or digest drift", () => {
    const repo = repository(installation("resolve-existing-source"));
    expect(() =>
      assertExactRepositoryObservation({ ...repo, url: "private" } as never),
    ).toThrow(/schema/u);
    expect(() =>
      assertExactRepositoryObservation({ ...repo, headTree: "9".repeat(40) }),
    ).toThrow(/non-canonical/u);
    const active = repository(installation("resolve-existing-source"), {
      releaseGate: { name: "REPOSITORY_RELEASE_ENABLED", configured: true },
    });
    expect(active.releaseGate.configured).toBe(true);
    expect(() => assertExactRepositoryObservation(active)).not.toThrow();
  });

  it("keeps fresh repositories release-disabled", () => {
    const adapter = new Adapter();
    const proposal = freshProposal(adapter);
    const unsigned = {
      ...proposal,
      releaseGate: {
        name: "REPOSITORY_RELEASE_ENABLED" as const,
        configured: true,
      },
    };
    delete (unsigned as Partial<typeof proposal>).digest;
    const releaseEnabled = {
      ...unsigned,
      digest: hash(unsigned),
    };
    expect(() =>
      assertExactFreshRepositoryProposal(releaseEnabled as never),
    ).toThrow(/malformed/u);
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
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "approve",
    });
    expect(result.parentCount).toBe(0);
    expect(result.initialCommitTree).toBe(proposal.sourceTree);
    expect(result.repository.defaultBranch).toBe("main");
    expect(result.releaseGateAbsent).toBe(true);
    expect(adapter.freshContent?.files).toEqual([
      {
        path: "README.md",
        mode: "100644",
        objectId: templateObjectId,
        digest: templateDigest,
        bytes: templateBytes,
      },
    ]);
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("constructs a closed content bundle without retaining mutable source bytes", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const sourceBytes = reviewedBytes.slice();
    const content = await readExactGitHubPublicationContent({
      proposal,
      review: review(),
      source: publicationContentSource(sourceBytes),
    });
    sourceBytes.fill(0);
    const change = content.changes[0];
    expect(change?.kind).toBe("added");
    if (change?.kind === "added")
      expect(change.after.bytes).toEqual(reviewedBytes);
    expect(() =>
      assertExactGitHubPublicationContent({
        proposal,
        review: review(),
        content: { ...content, token: "secret" } as never,
      }),
    ).toThrow(/schema is not closed/u);
  });

  it("accepts only the exact immutable source manifest and defensively copies fresh bytes", async () => {
    const adapter = new Adapter();
    const proposal = freshProposal(adapter);
    const mutable = templateBytes.slice();
    const content = await readExactGitHubFreshRepositoryContent({
      proposal,
      source: {
        async readFreshTree() {
          return {
            ...(await publicationContentSource().readFreshTree()),
            files: [
              {
                ...(await publicationContentSource().readFreshTree()).files[0]!,
                bytes: mutable,
              },
            ],
          };
        },
      },
    });
    mutable.fill(0);
    expect(content.files[0]?.bytes).toEqual(templateBytes);

    for (const drift of ["mode", "object", "bytes", "tree"] as const) {
      await expect(
        readExactGitHubFreshRepositoryContent({
          proposal,
          source: {
            async readFreshTree() {
              const exact = await publicationContentSource().readFreshTree();
              const file = exact.files[0]!;
              return {
                ...exact,
                ...(drift === "tree" ? { sourceTree: "0".repeat(40) } : {}),
                files: [
                  {
                    ...file,
                    ...(drift === "mode" ? { mode: "100755" as const } : {}),
                    ...(drift === "object" ? { objectId: "0".repeat(40) } : {}),
                    ...(drift === "bytes"
                      ? { bytes: new TextEncoder().encode("drift\n") }
                      : {}),
                  },
                ],
              };
            },
          },
        }),
      ).rejects.toThrow(/fresh repository content/u);
    }
  });

  it("returns the exact terminal receipt on idempotent retry", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = freshProposal(adapter);
    const first = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "approve",
    });
    const second = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      review: review(),
      contentSource: publicationContentSource(),
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
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect((await store.read(proposal.digest))?.status).toBe("pending");
    adapter.throwFreshMutation = false;
    adapter.freshOutcome = freshReadBack(proposal, adapter.identities.create);
    let recoveryReads = 0;
    const recovered = await createApprovedFreshRepository({
      adapter,
      store,
      proposal,
      review: review(),
      contentSource: publicationContentSource(reviewedBytes, () => {
        recoveryReads += 1;
      }),
      approvedByCallId: "retry",
    });
    expect(recovered.recoveredFromPending).toBe(true);
    expect(adapter.freshCalls).toBe(1);
    expect(recoveryReads).toBe(0);
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
          review: review(),
          contentSource: publicationContentSource(),
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
        review: review(),
        contentSource: publicationContentSource(),
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
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "approve",
    });
    expect(result.branchTree).toBe(branchTree);
    expect(result.normalizedChangedPaths).toEqual(proposal.approvedPaths);
    expect(result.changedContentDigest).toBe(proposal.changedContentDigest);
    expect(result.baseSha).toBe(proposal.baseSha);
    expect(result.draft).toBe(true);
    const draftChange = adapter.draftContent?.changes[0];
    expect(draftChange?.kind).toBe("added");
    if (draftChange?.kind === "added") {
      expect(draftChange.after.mode).toBe("644");
      expect(draftChange.after.digest).toBe(reviewedBytesDigest);
      expect(draftChange.after.bytes).toEqual(reviewedBytes);
    }
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("publishes to an active repository only while the release gate remains unchanged", async () => {
    const adapter = new Adapter();
    adapter.publishRepo = repository(adapter.identities.publish, {
      releaseGate: {
        name: "REPOSITORY_RELEASE_ENABLED",
        configured: true,
      },
    });
    const store = new Store();
    const proposal = draftProposal(adapter);
    expect(proposal.releaseGate.configured).toBe(true);

    const result = await publishApprovedDraftPullRequest({
      adapter,
      store,
      proposal,
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "approve-active-repository",
    });

    expect(result.releaseGateUnchanged).toBe(true);
    expect(result).not.toHaveProperty("releaseGateAbsent");
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("rejects release-gate drift after the draft proposal is sealed", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const changedGate = repository(adapter.identities.publish, {
      releaseGate: {
        name: "REPOSITORY_RELEASE_ENABLED",
        configured: true,
      },
    });
    adapter.draftOutcome = draftReadBack(proposal, changedGate);

    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        store: new Store(),
        proposal,
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "approve-stale-gate",
      }),
    ).rejects.toThrow(/stale or overlapping/u);
    expect(adapter.draftCalls).toBe(0);
  });

  it("keeps content-source failures pending without provider dispatch and permits explicit recovery", async () => {
    const cases = [
      {
        name: "missing",
        source: publicationContentSource(null),
        message: /postimage is missing/u,
      },
      {
        name: "mode-drift",
        source: publicationContentSource(reviewedBytes, undefined, "755"),
        message: /postimage changed/u,
      },
      {
        name: "byte-drift",
        source: publicationContentSource(
          new TextEncoder().encode("stale bytes\n"),
        ),
        message: /postimage changed/u,
      },
      {
        name: "source-error",
        source: {
          async readFile(): Promise<never> {
            throw new Error("raw-content-source-secret");
          },
        },
        message: /content source failed/u,
      },
    ];
    for (const fixture of cases) {
      const adapter = new Adapter();
      const store = new Store();
      const proposal = draftProposal(adapter);
      const failure = await publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        review: review(),
        contentSource: fixture.source,
        approvedByCallId: `approve-${fixture.name}`,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(fixture.message);
      expect(JSON.stringify(failure)).not.toContain(
        "raw-content-source-secret",
      );
      expect(adapter.draftCalls).toBe(0);
      expect((await store.read(proposal.digest))?.status).toBe("pending");

      const recovered = await publishApprovedDraftPullRequest({
        adapter,
        store,
        proposal,
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: `recover-${fixture.name}`,
      });
      expect(recovered.status).toBe("succeeded");
      expect(recovered.recoveredFromPending).toBe(false);
      expect(adapter.draftCalls).toBe(1);
    }
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
          review: review(),
          contentSource: publicationContentSource(),
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
    adapter.publishDraftPullRequest = async (value, content) => {
      const ack = await original(value, content);
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
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    expect((await store.read(proposal.digest))?.status).toBe("pending");
  });

  it("keeps unknown-key provider read-back pending", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const original = adapter.publishDraftPullRequest.bind(adapter);
    adapter.publishDraftPullRequest = async (value, content) => {
      const acknowledgement = await original(value, content);
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
        review: review(),
        contentSource: publicationContentSource(),
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
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "approve",
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    adapter.throwDraftMutation = false;
    adapter.draftOutcome = draftReadBack(
      proposal,
      adapter.publishRepo,
      "complete",
    );
    let recoveryReads = 0;
    const recovered = await publishApprovedDraftPullRequest({
      adapter,
      store,
      proposal,
      review: review(),
      contentSource: publicationContentSource(reviewedBytes, () => {
        recoveryReads += 1;
      }),
      approvedByCallId: "retry",
    });
    expect(recovered.recoveredFromPending).toBe(true);
    expect(adapter.draftCalls).toBe(1);
    expect(recoveryReads).toBe(0);
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
        review: review(),
        contentSource: publicationContentSource(),
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
        review: review(),
        contentSource: publicationContentSource(),
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
          review: review(),
          contentSource: publicationContentSource(),
          approvedByCallId: "approve",
        }),
      ).rejects.toThrow();
    }
    expect(adapter.draftCalls).toBe(0);
  });
});
