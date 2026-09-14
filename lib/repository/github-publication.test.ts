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
} from "./github-publication";
import type {
  DraftPublicationReadBack,
  DraftPullRequestProposal,
  FreshRepositoryProposal,
  FreshRepositoryReadBack,
  GitHubInstallationIdentity,
  GitHubMutationAcknowledgement,
  GitHubMutationReceipt,
  GitHubOperation,
  GitHubPublicationAdapter,
  GitHubDraftPullRequestContent,
  GitHubFreshRepositoryContent,
  GitHubRepositoryObservation,
} from "./github-publication";
import { createReviewedChangeSetReceipt } from "./reviewed-change-set";
import type { NormalizedChangeSet } from "./reviewed-change-set";
import type { SourceReceiptEvidence } from "./source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "./supported-template";
import { compareOverlayPaths } from "./target-apply";
import { GitHubPublicationTestStore as Store } from "./github-publication-test-store";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
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
const reviewedBytesDigest = createHash("sha256").update(reviewedBytes).digest("hex");
const reviewedAfter = (): { mode: "644"; digest: string } =>
  Object.fromEntries([
    ["mode", "644"],
    ["digest", reviewedBytesDigest],
  ]) as {
    mode: "644";
    digest: string;
  };
const reviewedChange = (
  change: NormalizedChangeSet["changes"][number],
): NormalizedChangeSet["changes"][number] => {
  if (change.kind === "added") {
    if (change.after === undefined) {throw new Error("Added change is missing its postimage.");}
    const { after: postimage } = change;
    const after = Object.fromEntries([
      ["mode", postimage.mode],
      ["digest", postimage.digest],
    ]);
    return Object.fromEntries([
      ["path", change.path],
      ["kind", change.kind],
      ["after", after],
    ]) as NormalizedChangeSet["changes"][number];
  }
  if (change.kind === "modified") {
    if (change.after === undefined) {throw new Error("Modified change is missing its postimage.");}
    const { after: postimage } = change;
    const after = Object.fromEntries([
      ["mode", postimage.mode],
      ["digest", postimage.digest],
    ]);
    return Object.fromEntries([
      ["path", change.path],
      ["kind", change.kind],
      ["before", change.before],
      ["after", after],
    ]) as NormalizedChangeSet["changes"][number];
  }
  return Object.fromEntries([
    ["path", change.path],
    ["kind", change.kind],
    ["before", change.before],
  ]) as NormalizedChangeSet["changes"][number];
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function publicationContentSource(
  bytes: Uint8Array | null = reviewedBytes,
  onRead?: (path: string) => void,
  mode = "644",
) {
  return {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async readFile(path: string) {
      onRead?.(path);
      return bytes === null ? null : { bytes, digest: reviewedBytesDigest, mode };
    },
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    async readFreshTree() {
      onRead?.("README.md");
      return {
        files: [
          {
            bytes: templateBytes,
            digest: templateDigest,
            mode: "100644" as const,
            objectId: templateObjectId,
            path: "README.md",
          },
        ],
        kind: "fresh-repository-source-tree" as const,
        sourceSha: sha,
        sourceTree: tree,
        version: 1 as const,
      };
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function source(
  sourceKind: SourceReceiptEvidence["sourceKind"] = "fresh-template",
): SourceReceiptEvidence {
  const unsigned = {
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    contractDigest: "5".repeat(64),
    eligibilityDigest: "4".repeat(64),
    releaseEnabled: false as const,
    sourceKind,
    sourceSha: sha,
    sourceTree: tree,
    version: 3 as const,
  } as const;
  return { ...unsigned, digest: hash(unsigned) };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function review(
  inputChanges: NormalizedChangeSet["changes"] = [
    {
      after: reviewedAfter(),
      kind: "added" as const,
      path: "apps/demo/page.tsx",
    },
  ],
  overrides: Partial<Pick<NormalizedChangeSet, "sourceReceiptDigest">> = {},
) {
  const changes = [...inputChanges]
    .toSorted((left, right) => compareOverlayPaths(left.path, right.path))
    .map(reviewedChange);
  const unsigned = {
    appSpecDigest: "b".repeat(64),
    appSpecPath: "prototype/demo/app-spec.md",
    applyDigest: "7".repeat(64),
    approvedPaths: changes.map(({ path }) => path),
    artifactRevision: "c".repeat(64),
    changedContentDigest: hash(changes),
    changes,
    contractDigest: "9".repeat(64),
    dependencyCacheContentDigest: "1".repeat(64),
    dependencyCacheDigest: "0".repeat(64),
    dependencyReceiptDigest: "d".repeat(64),
    eligibilityDigest: "4".repeat(64),
    identityDigest: "e".repeat(64),
    imageDigest: `sha256:${"f".repeat(64)}`,
    postTreeDigest: "4".repeat(64),
    preTreeDigest: "3".repeat(64),
    proposalDigest: "8".repeat(64),
    repositoryContractDigest: "5".repeat(64),
    sourceReceiptDigest: source().digest,
    sourceSha: sha,
    sourceTree: tree,
    targetReceipt: {
      contractPath: ".config/repository-template.json",
      topology: {
        newDigest: "2".repeat(64),
        oldDigest: "1".repeat(64),
        path: "apps.json",
      },
      version: 1 as const,
    },
    validationDigest: "6".repeat(64),
    version: 2 as const,
    workspaceDigest: "a".repeat(64),
    ...overrides,
  };
  const changeSet: NormalizedChangeSet = {
    ...unsigned,
    digest: hash(unsigned),
  };
  return createReviewedChangeSetReceipt(changeSet, "review-call");
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function installation(
  operation: GitHubOperation,
  repositoryIds: readonly string[] = ["100"],
): GitHubInstallationIdentity {
  return createGitHubInstallationIdentity({
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "10",
    operation,
    repositorySelection: "selected",
    selectedRepositoryIds: repositoryIds,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function repository(
  identity: GitHubInstallationIdentity,
  overrides: Partial<Omit<GitHubRepositoryObservation, "version" | "digest">> = {},
): GitHubRepositoryObservation {
  return createRepositoryObservation({
    defaultBranch: "main",
    headSha: sha,
    headTree: tree,
    installationIdentityDigest: identity.digest,
    name: "example-app",
    owner: "withAutograph",
    releaseGate: {
      configured: false,
      name: "REPOSITORY_RELEASE_ENABLED",
    },
    repositoryId: "100",
    visibility: "private",
    ...overrides,
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function freshReadBack(
  proposal: FreshRepositoryProposal,
  identity: GitHubInstallationIdentity,
): FreshRepositoryReadBack {
  const repo = repository(identity, {
    headSha: branchSha,
    headTree: proposal.sourceTree,
    name: proposal.destinationName,
    owner: proposal.destinationOwner,
    repositoryId: "101",
  });
  const unsigned = {
    idempotencyKey: proposal.idempotencyKey,
    initialCommit: {
      parents: [] as const,
      sha: branchSha,
      tree: proposal.sourceTree,
    },
    repository: repo,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: hash(unsigned) };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function draftReadBack(
  proposal: DraftPullRequestProposal,
  repo: GitHubRepositoryObservation,
  state: "absent" | "complete" | "branch-only" = "absent",
): DraftPublicationReadBack {
  const branch =
    state === "absent"
      ? ({ status: "absent" } as const)
      : ({
          branchName: proposal.branchName,
          branchSha,
          branchTree,
          changedContentDigest: proposal.changedContentDigest,
          idempotencyKey: proposal.idempotencyKey,
          normalizedChangedPaths: proposal.approvedPaths,
          status: "present",
        } as const);
  const pullRequest =
    state === "complete"
      ? ({
          baseBranch: proposal.baseBranch,
          baseRepositoryId: proposal.repositoryId,
          baseSha: proposal.baseSha,
          changeSetDigest: proposal.changeSetDigest,
          draft: true,
          headBranch: proposal.branchName,
          headRepositoryId: proposal.repositoryId,
          headSha: branchSha,
          idempotencyKey: proposal.idempotencyKey,
          pullRequestId: "400",
          pullRequestNumber: 7,
          status: "present",
        } as const)
      : ({ status: "absent" } as const);
  const unsigned = {
    branch,
    changedPathsSinceBase: [] as readonly string[],
    idempotencyKey: proposal.idempotencyKey,
    pullRequest,
    repository: repo,
    version: GITHUB_PUBLICATION_VERSION,
  };
  return { ...unsigned, digest: hash(unsigned) };
}

class Adapter implements GitHubPublicationAdapter {
  readonly identities = {
    create: installation("create-fresh-repository"),
    publish: installation("publish-draft-pull-request"),
    resolve: installation("resolve-existing-source"),
  };
  resolveRepo = repository(this.identities.resolve);
  publishRepo = repository(this.identities.publish);
  destination: "absent" | GitHubRepositoryObservation = "absent";
  freshOutcome: FreshRepositoryReadBack | undefined;
  draftOutcome: DraftPublicationReadBack | undefined;
  freshCalls = 0;
  draftCalls = 0;
  freshAcknowledgement: GitHubMutationAcknowledgement = {
    requestId: "fresh-request",
    status: "accepted",
  };
  draftAcknowledgement: GitHubMutationAcknowledgement = {
    requestId: "draft-request",
    status: "accepted",
  };
  throwFreshMutation = false;
  throwDraftMutation = false;
  throwFreshReadBack = false;
  throwDraftReadBack = false;
  freshContent: GitHubFreshRepositoryContent | undefined;
  draftContent: GitHubDraftPullRequestContent | undefined;

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectInstallation(operation: GitHubOperation) {
    if (operation === "resolve-existing-source") {return this.identities.resolve;}
    if (operation === "create-fresh-repository") {return this.identities.create;}
    return this.identities.publish;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectRepository() {
    return this.resolveRepo;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectDestination() {
    return this.destination;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectFreshRepositoryOutcome() {
    if (this.throwFreshReadBack) {throw new Error("read-back-failed");}
    return this.freshOutcome;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async createPrivateFreshHistoryRepository(
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ) {
    this.freshCalls += 1;
    this.freshContent = content;
    if (this.throwFreshMutation) {throw new Error("transport-failed");}
    if (this.freshAcknowledgement.status === "accepted")
      {this.freshOutcome = freshReadBack(proposal, this.identities.create);}
    return this.freshAcknowledgement;
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async inspectDraftPublication(proposal: DraftPullRequestProposal) {
    if (this.throwDraftReadBack) {throw new Error("read-back-failed");}
    return this.draftOutcome ?? draftReadBack(proposal, this.publishRepo);
  }

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  async publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ) {
    this.draftCalls += 1;
    this.draftContent = content;
    if (this.throwDraftMutation) {throw new Error("transport-failed");}
    if (this.draftAcknowledgement.status === "accepted")
      {this.draftOutcome = draftReadBack(proposal, this.publishRepo, "complete");}
    return this.draftAcknowledgement;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function freshProposal(adapter: Adapter) {
  return createFreshRepositoryProposal({
    destinationName: "new-app",
    destinationOwner: "withAutograph",
    installation: adapter.identities.create,
    review: review(),
    source: source(),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function draftProposal(adapter: Adapter) {
  return createDraftPullRequestProposal({
    changedPathsSinceBase: [],
    installation: adapter.identities.publish,
    repository: adapter.publishRepo,
    review: review(),
    title: "Add demo",
  });
}

describe("closed GitHub publication contract", () => {
  it("round-trips UTF-8 ordered review paths into GitHub publication", () => {
    const adapter = new Adapter();
    const canonicalReview = review([
      {
        after: reviewedAfter(),
        kind: "added",
        path: "apps/demo/\u{10000}.tsx",
      },
      {
        after: reviewedAfter(),
        kind: "added",
        path: ".codex/skills/example/agents/openai.yaml",
      },
      {
        after: reviewedAfter(),
        kind: "added",
        path: "apps/demo/\u{E000}.tsx",
      },
      {
        after: reviewedAfter(),
        kind: "added",
        path: ".codex/skills/example/SKILL.md",
      },
    ]);
    const roundTripped = structuredClone(canonicalReview);
    const proposal = createDraftPullRequestProposal({
      changedPathsSinceBase: [],
      installation: adapter.identities.publish,
      repository: adapter.publishRepo,
      review: roundTripped,
      title: "Add demo",
    });

    expect(proposal.approvedPaths).toEqual([
      ".codex/skills/example/SKILL.md",
      ".codex/skills/example/agents/openai.yaml",
      "apps/demo/\u{E000}.tsx",
      "apps/demo/\u{10000}.tsx",
    ]);
    expect(() => assertExactDraftPullRequestProposal(proposal)).not.toThrow();
  });

  it("derives operation-specific least-privilege identities", () => {
    const resolve = installation("resolve-existing-source");
    const create = installation("create-fresh-repository");
    const publish = installation("publish-draft-pull-request");
    expect(resolve.permissions).toEqual({
      administration: "none",
      contents: "read",
      metadata: "read",
      pullRequests: "none",
      variables: "read",
      workflows: "none",
    });
    expect(create.permissions.pullRequests).toBe("none");
    expect(create.permissions.administration).toBe("write");
    expect(create.permissions.workflows).toBe("write");
    expect(publish.permissions.administration).toBe("none");
    expect(publish.permissions.pullRequests).toBe("write");
    expect(publish.permissions.workflows).toBe("write");
  });

  it("preserves all-repository selection in the closed installation identity", () => {
    const identity = createGitHubInstallationIdentity({
      accountId: "20",
      accountLogin: "withAutograph",
      accountType: "Organization",
      installationId: "10",
      operation: "resolve-existing-source",
      repositorySelection: "all",
      selectedRepositoryIds: ["100"],
    });

    expect(identity.repositorySelection).toBe("all");
    expect(() => assertExactInstallationIdentity(identity)).not.toThrow();
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
      expectedInstallationId: "10",
      expectedSha: sha,
      expectedTree: tree,
      ref: "refs/heads/main",
      repositoryId: "100",
      resolvedByCallId: "resolve-call",
    });
    expect(result.repository.repositoryId).toBe("100");
    await expect(
      resolveImmutableExistingSource({
        adapter,
        expectedInstallationId: "11",
        expectedSha: sha,
        expectedTree: tree,
        ref: "refs/heads/main",
        repositoryId: "100",
        resolvedByCallId: "resolve-call",
      }),
    ).rejects.toThrow(/installation is not selected/u);
    for (const ref of ["main", "refs/tags/v1", "refs/heads/../main", "refs/heads/x.lock"])
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      {await expect(
        resolveImmutableExistingSource({
          adapter,
          expectedInstallationId: "10",
          expectedSha: sha,
          expectedTree: tree,
          ref,
          repositoryId: "100",
          resolvedByCallId: "resolve-call",
        }),
      ).rejects.toThrow(/invalid/u);}
  });

  it("accepts exact active release-gate observations and rejects schema or digest drift", () => {
    const repo = repository(installation("resolve-existing-source"));
    expect(() => assertExactRepositoryObservation({ ...repo, url: "private" } as never)).toThrow(
      /schema/u,
    );
    expect(() => assertExactRepositoryObservation({ ...repo, headTree: "9".repeat(40) })).toThrow(
      /non-canonical/u,
    );
    const active = repository(installation("resolve-existing-source"), {
      releaseGate: { configured: true, name: "REPOSITORY_RELEASE_ENABLED" },
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
        configured: true,
        name: "REPOSITORY_RELEASE_ENABLED" as const,
      },
    };
    delete (unsigned as Partial<typeof proposal>).digest;
    const releaseEnabled = {
      ...unsigned,
      digest: hash(unsigned),
    };
    expect(() => assertExactFreshRepositoryProposal(releaseEnabled as never)).toThrow(/malformed/u);
  });

  it("binds a fresh proposal to the exact reviewed source receipt", () => {
    const adapter = new Adapter();
    expect(() =>
      createFreshRepositoryProposal({
        destinationName: "new-app",
        destinationOwner: "withAutograph",
        installation: adapter.identities.create,
        review: review(undefined, {
          sourceReceiptDigest: "0".repeat(64),
        }),
        source: source(),
      }),
    ).toThrow(/exact source receipt/u);
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
        destinationName: "../bad",
        destinationOwner: "withAutograph",
        installation: adapter.identities.create,
        review: review(),
        source: source(),
      }),
    ).toThrow(/outside/u);
    expect(() =>
      createDraftPullRequestProposal({
        changedPathsSinceBase: [],
        installation: adapter.identities.publish,
        repository: adapter.publishRepo,
        review: review(),
        title: "bad\nbody",
      }),
    ).toThrow(/unauthorized/u);
    const canonicalReview = review();
    expect(() =>
      createDraftPullRequestProposal({
        changedPathsSinceBase: [],
        installation: adapter.identities.publish,
        repository: adapter.publishRepo,
        review: {
          ...canonicalReview,
          changedContentDigest: "9".repeat(64),
        },
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
      approvedByCallId: "approve",
      contentSource: publicationContentSource(),
      proposal,
      review: review(),
      store,
    });
    expect(result.parentCount).toBe(0);
    expect(result.initialCommitTree).toBe(proposal.sourceTree);
    expect(result.repository.defaultBranch).toBe("main");
    expect(result.releaseGateAbsent).toBe(true);
    expect(adapter.freshContent?.files).toEqual([
      {
        bytes: templateBytes,
        digest: templateDigest,
        mode: "100644",
        objectId: templateObjectId,
        path: "README.md",
      },
    ]);
    assertCanonicalGitHubMutationReceipt(result);
  });

  it("constructs a closed content bundle without retaining mutable source bytes", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const sourceBytes = new Uint8Array(reviewedBytes);
    const content = await readExactGitHubPublicationContent({
      proposal,
      review: review(),
      source: publicationContentSource(sourceBytes),
    });
    sourceBytes.fill(0);
    const [change] = content.changes;
    expect(change?.kind).toBe("added");
    if (change?.kind === "added") {expect(change.after.bytes).toEqual(reviewedBytes);}
    expect(() =>
      assertExactGitHubPublicationContent({
        content: { ...content, token: "secret" } as never,
        proposal,
        review: review(),
      }),
    ).toThrow(/schema is not closed/u);
  });

  it("accepts only the exact immutable source manifest and defensively copies fresh bytes", async () => {
    const adapter = new Adapter();
    const proposal = freshProposal(adapter);
    const mutable = new Uint8Array(templateBytes);
    const content = await readExactGitHubFreshRepositoryContent({
      proposal,
      source: {
        async readFreshTree() {
          const exact = await publicationContentSource().readFreshTree();
          const [file] = exact.files;
          if (file === undefined) {throw new Error("missing fixture file");}
          return {
            ...exact,
            files: [
              {
                ...file,
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
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(
        readExactGitHubFreshRepositoryContent({
          proposal,
          source: {
            async readFreshTree() {
              const exact = await publicationContentSource().readFreshTree();
              const [file] = exact.files;
              if (file === undefined) {throw new Error("missing fixture file");}
              return {
                ...exact,
                ...(drift === "tree" ? { sourceTree: "0".repeat(40) } : {}),
                files: [
                  {
                    ...file,
                    ...(drift === "mode" ? { mode: "100755" as const } : {}),
                    ...(drift === "object" ? { objectId: "0".repeat(40) } : {}),
                    ...(drift === "bytes" ? { bytes: new TextEncoder().encode("drift\n") } : {}),
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
      approvedByCallId: "approve",
      contentSource: publicationContentSource(),
      proposal,
      review: review(),
      store,
    });
    const second = await createApprovedFreshRepository({
      adapter,
      approvedByCallId: "different-call",
      contentSource: publicationContentSource(),
      proposal,
      review: review(),
      store,
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
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    const pending = await store.read(proposal.digest);
    expect(pending?.status).toBe("pending");
    adapter.throwFreshMutation = false;
    adapter.freshOutcome = freshReadBack(proposal, adapter.identities.create);
    let recoveryReads = 0;
    const recovered = await createApprovedFreshRepository({
      adapter,
      approvedByCallId: "retry",
      contentSource: publicationContentSource(reviewedBytes, () => {
        recoveryReads += 1;
      }),
      proposal,
      review: review(),
      store,
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
      if (failure === "read-back") {adapter.throwFreshReadBack = true;}
      else {store.rejectTerminal = true;}
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(
        createApprovedFreshRepository({
          adapter,
          approvedByCallId: "approve",
          contentSource: publicationContentSource(),
          proposal,
          review: review(),
          store,
        }),
      ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const pending = await store.read(proposal.digest);
      expect(pending?.status).toBe("pending");
    }
  });

  it("distinguishes explicit provider rejection and sanitizes its code", async () => {
    const adapter = new Adapter();
    adapter.freshAcknowledgement = {
      code: "secret raw provider message",
      status: "rejected",
    };
    const store = new Store();
    const proposal = freshProposal(adapter);
    await expect(
      createApprovedFreshRepository({
        adapter,
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toThrow(/rejected/u);
    const failure = await store.read(proposal.digest);
    expect(failure?.status).toBe("failed");
    expect(JSON.stringify(failure)).not.toContain("secret raw provider message");
  });

  it("proves exact branch tree/content/paths and PR head/base/draft read-back", async () => {
    const adapter = new Adapter();
    const store = new Store();
    const proposal = draftProposal(adapter);
    const result = await publishApprovedDraftPullRequest({
      adapter,
      approvedByCallId: "approve",
      contentSource: publicationContentSource(),
      proposal,
      review: review(),
      store,
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
        configured: true,
        name: "REPOSITORY_RELEASE_ENABLED",
      },
    });
    const store = new Store();
    const proposal = draftProposal(adapter);
    expect(proposal.releaseGate.configured).toBe(true);

    const result = await publishApprovedDraftPullRequest({
      adapter,
      approvedByCallId: "approve-active-repository",
      contentSource: publicationContentSource(),
      proposal,
      review: review(),
      store,
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
        configured: true,
        name: "REPOSITORY_RELEASE_ENABLED",
      },
    });
    adapter.draftOutcome = draftReadBack(proposal, changedGate);

    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: "approve-stale-gate",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store: new Store(),
      }),
    ).rejects.toThrow(/stale or overlapping/u);
    expect(adapter.draftCalls).toBe(0);
  });

  it("keeps content-source failures pending without provider dispatch and permits explicit recovery", async () => {
    const cases = [
      {
        message: /postimage is missing/u,
        name: "missing",
        source: publicationContentSource(null),
      },
      {
        message: /postimage changed/u,
        name: "mode-drift",
        source: publicationContentSource(reviewedBytes, undefined, "755"),
      },
      {
        message: /postimage changed/u,
        name: "byte-drift",
        source: publicationContentSource(new TextEncoder().encode("stale bytes\n")),
      },
      {
        message: /content source failed/u,
        name: "source-error",
        source: {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
          async readFile(): Promise<never> {
            throw new Error("raw-content-source-secret");
          },
        },
      },
    ];
    for (const fixture of cases) {
      const adapter = new Adapter();
      const store = new Store();
      const proposal = draftProposal(adapter);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const failure = await publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: `approve-${fixture.name}`,
        contentSource: fixture.source,
        proposal,
        review: review(),
        store,
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toMatch(fixture.message);
      expect(JSON.stringify(failure)).not.toContain("raw-content-source-secret");
      expect(adapter.draftCalls).toBe(0);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const pending = await store.read(proposal.digest);
      expect(pending?.status).toBe("pending");

      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const recovered = await publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: `recover-${fixture.name}`,
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      });
      expect(recovered.status).toBe("succeeded");
      expect(recovered.recoveredFromPending).toBe(false);
      expect(adapter.draftCalls).toBe(1);
    }
  });

  it("refuses stale, overlapping, and branch-collision read-back before mutation", async () => {
    const mutations: ((adapter: Adapter, proposal: DraftPullRequestProposal) => void)[] = [
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
        adapter.draftOutcome = draftReadBack(proposal, adapter.publishRepo, "branch-only");
      },
    ];
    for (const mutate of mutations) {
      const adapter = new Adapter();
      const proposal = draftProposal(adapter);
      mutate(adapter, proposal);
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(
        publishApprovedDraftPullRequest({
          adapter,
          approvedByCallId: "approve",
          contentSource: publicationContentSource(),
          proposal,
          review: review(),
          store: new Store(),
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
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    const pending = await store.read(proposal.digest);
    expect(pending?.status).toBe("pending");
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
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    const pending = await store.read(proposal.digest);
    expect(pending?.status).toBe("pending");
  });

  it("recovers a lost draft response without a duplicate branch or PR", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    adapter.throwDraftMutation = true;
    const store = new Store();
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toBeInstanceOf(GitHubOutcomeUnknownError);
    adapter.throwDraftMutation = false;
    adapter.draftOutcome = draftReadBack(proposal, adapter.publishRepo, "complete");
    let recoveryReads = 0;
    const recovered = await publishApprovedDraftPullRequest({
      adapter,
      approvedByCallId: "retry",
      contentSource: publicationContentSource(reviewedBytes, () => {
        recoveryReads += 1;
      }),
      proposal,
      review: review(),
      store,
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
      approvedByCallId: "approve",
      digest: "8".repeat(64),
      idempotencyKey: "9".repeat(64),
      kind: "draft-pull-request",
      proposalDigest: proposal.digest,
      status: "pending",
      version: GITHUB_PUBLICATION_VERSION,
    });
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
      }),
    ).rejects.toThrow(/digest|proposal/u);
    expect(adapter.draftCalls).toBe(0);
  });

  it("rejects a digest-valid journal carrying an unknown key", async () => {
    const adapter = new Adapter();
    const proposal = draftProposal(adapter);
    const store = new Store();
    const unsigned = {
      approvedByCallId: "approve",
      idempotencyKey: proposal.idempotencyKey,
      kind: "draft-pull-request" as const,
      proposalDigest: proposal.digest,
      rawProviderPayload: "must-not-be-accepted",
      status: "pending" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    store.values.set(proposal.digest, {
      ...unsigned,
      digest: hash(unsigned),
    } as GitHubMutationReceipt);
    await expect(
      publishApprovedDraftPullRequest({
        adapter,
        approvedByCallId: "approve",
        contentSource: publicationContentSource(),
        proposal,
        review: review(),
        store,
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
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      await expect(
        publishApprovedDraftPullRequest({
          adapter,
          approvedByCallId: "approve",
          contentSource: publicationContentSource(),
          proposal: tampered,
          review: review(),
          store: new Store(),
        }),
      ).rejects.toThrow();
    }
    expect(adapter.draftCalls).toBe(0);
  });
});
