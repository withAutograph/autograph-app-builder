import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { composeGitHubPublicationRuntime } from "../agent/github-publication-runtime";
import { createGitHubAppPublicationAdapter } from "./github-app-adapter";
import {
  GITHUB_PUBLICATION_VERSION,
  createDraftPullRequestProposal,
  createFreshRepositoryProposal,
  createGitHubInstallationIdentity,
  type DraftPullRequestProposal,
  type FreshRepositoryProposal,
  type GitHubMutationReceipt,
  type GitHubOperation,
  type GitHubDraftPullRequestContent,
  type GitHubFreshRepositoryContent,
  type GitHubPublicationReceiptStore,
} from "./github-publication";
import {
  parseGitHubPublicationProposalRow,
  type GitHubPublicationProposal,
  type GitHubPublicationProposalStore,
} from "./postgres-github-publication-store";
import { parseGitHubPublicationJournalRow } from "./postgres-github-publication-receipt-store";
import {
  createReviewedChangeSetReceipt,
  type NormalizedChangeSet,
} from "./reviewed-change-set";
import type { SourceReceiptEvidence } from "./source-receipt";
import { SUPPORTED_TEMPLATE_ADAPTER } from "./supported-template";

const hash = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sourceSha = "1".repeat(40);
const templateBytes = new TextEncoder().encode("# Template\n");
const templateDigest = createHash("sha256").update(templateBytes).digest("hex");
const templateObjectId = createHash("sha1")
  .update(Buffer.from(`blob ${templateBytes.byteLength}\0`))
  .update(templateBytes)
  .digest("hex");
const templateTreeContent = Buffer.concat([
  Buffer.from("100644 README.md\0"),
  Buffer.from(templateObjectId, "hex"),
]);
const sourceTree = createHash("sha1")
  .update(Buffer.from(`tree ${templateTreeContent.byteLength}\0`))
  .update(templateTreeContent)
  .digest("hex");
const branchSha = "3".repeat(40);
const branchTree = "4".repeat(40);
const reviewedBytes = new TextEncoder().encode("export default 'demo';\n");
const reviewedBytesDigest = createHash("sha256")
  .update(reviewedBytes)
  .digest("hex");

const publicationContentSource = () => ({
  async readFreshTree() {
    return {
      version: 1 as const,
      kind: "fresh-repository-source-tree" as const,
      sourceSha,
      sourceTree,
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
  async readFile() {
    return {
      mode: "644",
      digest: reviewedBytesDigest,
      bytes: reviewedBytes,
    };
  },
});

const approvalReceipt = (proposal: DraftPullRequestProposal) => ({
  format: "autograph-eve-approval-receipt-v2" as const,
  phase: "publication" as const,
  outcome: "create-draft-pr" as const,
  repositoryId: proposal.repositoryId,
  repository: `${proposal.owner}/${proposal.name}`,
  baseRef: `refs/heads/${proposal.baseBranch}`,
  baseSha: proposal.baseSha,
  subjectDigest: proposal.digest,
});

function source(
  sourceKind: SourceReceiptEvidence["sourceKind"] = "fresh-template",
): SourceReceiptEvidence {
  const unsigned = {
    version: 3 as const,
    sourceKind,
    sourceSha,
    sourceTree,
    adapter: SUPPORTED_TEMPLATE_ADAPTER,
    eligibilityDigest: "4".repeat(64),
    contractDigest: "5".repeat(64),
    releaseEnabled: false as const,
  } as const;
  return { ...unsigned, digest: hash(unsigned) };
}

function review() {
  const changes = [
    {
      path: "apps/demo/page.tsx",
      kind: "added" as const,
      after: { mode: "644", digest: reviewedBytesDigest },
    },
  ];
  const unsigned = {
    version: 2 as const,
    validationDigest: "6".repeat(64),
    applyDigest: "7".repeat(64),
    proposalDigest: "8".repeat(64),
    contractDigest: "9".repeat(64),
    repositoryContractDigest: "5".repeat(64),
    sourceSha,
    sourceTree,
    sourceReceiptDigest: source().digest,
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
    approvedPaths: ["apps/demo/page.tsx"],
  };
  const changeSet: NormalizedChangeSet = {
    ...unsigned,
    digest: hash(unsigned),
  };
  return createReviewedChangeSetReceipt(changeSet, "review-call");
}

function installation(operation: GitHubOperation) {
  return createGitHubInstallationIdentity({
    operation,
    installationId: "10",
    accountId: "20",
    accountLogin: "withAutograph",
    accountType: "Organization",
    repositorySelection: "selected",
    selectedRepositoryIds: ["100"],
  });
}

function freshProposal() {
  return createFreshRepositoryProposal({
    installation: installation("create-fresh-repository"),
    source: source(),
    review: review(),
    destinationOwner: "withAutograph",
    destinationName: "new-app",
  });
}

function draftProposal() {
  const identity = installation("publish-draft-pull-request");
  const repository = {
    version: GITHUB_PUBLICATION_VERSION,
    repositoryId: "100",
    owner: "withAutograph",
    name: "example-app",
    visibility: "private" as const,
    defaultBranch: "main",
    headSha: sourceSha,
    headTree: sourceTree,
    installationIdentityDigest: identity.digest,
    releaseGate: {
      name: "REPOSITORY_RELEASE_ENABLED" as const,
      configured: false as const,
    },
  };
  const canonicalRepository = {
    ...repository,
    digest: hash(repository),
  };
  return createDraftPullRequestProposal({
    installation: identity,
    repository: canonicalRepository,
    review: review(),
    changedPathsSinceBase: [],
    title: "Add demo",
  });
}

class MemoryStores {
  readonly proposals = new Map<string, GitHubPublicationProposal>();
  readonly receipts = new Map<string, GitHubMutationReceipt>();

  readonly proposalStore: GitHubPublicationProposalStore = {
    read: async (key) => this.proposals.get(key),
    save: async (proposal) => {
      this.proposals.set(proposal.digest, proposal);
    },
  };

  readonly receiptStore: GitHubPublicationReceiptStore = {
    read: async (key) => this.receipts.get(key),
    compareAndSet: async (key, expected, receipt) => {
      if (this.receipts.get(key)?.digest !== expected) return false;
      this.receipts.set(key, receipt);
      return true;
    },
  };

  async save(proposal: GitHubPublicationProposal) {
    await this.proposalStore.save(proposal);
  }
}

class Provider {
  readonly permissionRequests: Array<{
    operation: GitHubOperation;
    requestedPermissions: unknown;
  }> = [];
  freshOutcome: unknown;
  draftOutcome: unknown;
  freshMutations = 0;
  draftMutations = 0;
  freshContent: GitHubFreshRepositoryContent | undefined;
  draftContent: GitHubDraftPullRequestContent | undefined;
  readonly repositoryInspections: Array<{
    repositoryId: string;
    ref: string;
  }> = [];
  addPermission = false;
  throwInspection = false;

  async inspectInstallation(input: {
    operation: GitHubOperation;
    requestedPermissions: unknown;
  }) {
    if (this.throwInspection) throw new Error("raw-provider-secret");
    this.permissionRequests.push(input);
    return {
      installationId: "10",
      accountId: "20",
      accountLogin: "withAutograph",
      accountType: "Organization",
      repositorySelection: "selected",
      selectedRepositoryIds: ["100"],
      grantedPermissions: this.addPermission
        ? { ...(input.requestedPermissions as object), administration: "write" }
        : input.requestedPermissions,
    };
  }

  repositorySnapshot(
    name = "example-app",
    repositoryId = "100",
  ): {
    repositoryId: string;
    owner: string;
    name: string;
    visibility: string;
    defaultBranch: string;
    headSha: string;
    headTree: string;
    repositoryVariableNames: string[];
  } {
    return {
      repositoryId,
      owner: "withAutograph",
      name,
      visibility: "private",
      defaultBranch: "main",
      headSha: repositoryId === "100" ? sourceSha : branchSha,
      headTree: sourceTree,
      repositoryVariableNames: [],
    };
  }

  async inspectRepository(input: { repositoryId: string; ref: string }) {
    this.repositoryInspections.push(input);
    return this.repositorySnapshot();
  }

  async inspectDestination() {
    return "absent";
  }

  async inspectFreshRepositoryOutcome() {
    return this.freshOutcome;
  }

  async createPrivateFreshHistoryRepository(
    proposal: FreshRepositoryProposal,
    content: GitHubFreshRepositoryContent,
  ) {
    this.freshMutations += 1;
    this.freshContent = content;
    this.freshOutcome = {
      idempotencyKey: proposal.idempotencyKey,
      repository: this.repositorySnapshot(proposal.destinationName, "101"),
      initialCommit: { sha: branchSha, tree: sourceTree, parents: [] },
    };
    return { status: "accepted", requestId: "create-request" };
  }

  async inspectDraftPublication(proposal: DraftPullRequestProposal) {
    return (
      this.draftOutcome ?? {
        idempotencyKey: proposal.idempotencyKey,
        repository: this.repositorySnapshot(),
        changedPathsSinceBase: [],
        branch: { status: "absent" },
        pullRequest: { status: "absent" },
      }
    );
  }

  async publishDraftPullRequest(
    proposal: DraftPullRequestProposal,
    content: GitHubDraftPullRequestContent,
  ) {
    this.draftMutations += 1;
    this.draftContent = content;
    this.draftOutcome = {
      idempotencyKey: proposal.idempotencyKey,
      repository: this.repositorySnapshot(),
      changedPathsSinceBase: [],
      branch: {
        status: "present",
        branchName: proposal.branchName,
        branchSha,
        branchTree,
        normalizedChangedPaths: proposal.approvedPaths,
        changedContentDigest: proposal.changedContentDigest,
        idempotencyKey: proposal.idempotencyKey,
      },
      pullRequest: {
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
      },
    };
    return { status: "accepted", requestId: "publish-request" };
  }
}

describe("GitHub runtime adapter and durable-store composition", () => {
  it("keeps the shipped runtime disabled and requires every explicit dependency", async () => {
    const disabled = composeGitHubPublicationRuntime({ enabled: false });
    await expect(disabled.status()).resolves.toMatchObject({
      version: 3,
      enabled: false,
      adapterConfigured: false,
      durableStoreConfigured: false,
      liveGitHubCallsAvailable: false,
      genericShellAuthority: false,
    });
    await expect(
      disabled.createFreshRepository({
        expectedProposalDigest: "a".repeat(64),
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "call",
      }),
    ).rejects.toThrow(/disabled/u);
    expect(() => composeGitHubPublicationRuntime({ enabled: true })).toThrow(
      /typed adapter and durable stores/u,
    );
  });

  it("reports operation-specific release-gate policy", async () => {
    const status = await composeGitHubPublicationRuntime({
      enabled: false,
    }).status();

    expect(status.releaseGate).toEqual({
      name: "REPOSITORY_RELEASE_ENABLED",
      policies: {
        "create-approved-private-fresh-history-repository": {
          requiredConfiguredState: false,
        },
        "publish-approved-branch-and-draft-pull-request": {
          requiredConfiguredState: "sealed-proposal-value",
          rejectsDrift: true,
        },
      },
    });
    expect(status.releaseGate).not.toHaveProperty("requiredState");
  });

  it("requests only operation-scoped permissions and rejects escalation", async () => {
    const provider = new Provider();
    const adapter = createGitHubAppPublicationAdapter(provider);
    const identity = await adapter.inspectInstallation(
      "publish-draft-pull-request",
    );
    expect(identity.permissions).toEqual({
      metadata: "read",
      contents: "write",
      workflows: "write",
      pullRequests: "write",
      administration: "none",
      variables: "read",
    });
    provider.addPermission = true;
    await expect(
      adapter.inspectInstallation("resolve-existing-source"),
    ).rejects.toThrow();
  });

  it("sanitizes provider errors and records a configured release gate", async () => {
    const provider = new Provider();
    provider.throwInspection = true;
    const adapter = createGitHubAppPublicationAdapter(provider);
    await expect(
      adapter.inspectInstallation("resolve-existing-source"),
    ).rejects.toThrow("GitHub provider operation failed.");
    await expect(
      adapter.inspectInstallation("resolve-existing-source"),
    ).rejects.not.toThrow(/raw-provider-secret/u);

    provider.throwInspection = false;
    provider.inspectRepository = async () => ({
      ...provider.repositorySnapshot(),
      repositoryVariableNames: ["REPOSITORY_RELEASE_ENABLED"],
    });
    await expect(
      adapter.inspectRepository({
        operation: "resolve-existing-source",
        repositoryId: "100",
        ref: "refs/heads/main",
      }),
    ).resolves.toMatchObject({
      releaseGate: {
        name: "REPOSITORY_RELEASE_ENABLED",
        configured: true,
      },
    });

    provider.inspectRepository = async () => ({
      ...provider.repositorySnapshot(),
      credential_value: "provider-secret-marker",
    });
    const invalidResponse = await adapter
      .inspectRepository({
        operation: "resolve-existing-source",
        repositoryId: "100",
        ref: "refs/heads/main",
      })
      .catch((error: unknown) => error);
    expect(invalidResponse).toBeInstanceOf(Error);
    expect((invalidResponse as Error).message).toBe(
      "GitHub provider response was invalid.",
    );
    expect(JSON.stringify(invalidResponse)).not.toContain(
      "provider-secret-marker",
    );
  });

  it("runs exact source, fresh creation, recovery, and draft publication through composed ports", async () => {
    const provider = new Provider();
    const adapter = createGitHubAppPublicationAdapter(provider);
    const stores = new MemoryStores();
    const fresh = freshProposal();
    const draft = draftProposal();
    await stores.save(fresh);
    await stores.save(draft);
    const runtime = composeGitHubPublicationRuntime({
      enabled: true,
      adapter,
      proposals: stores.proposalStore,
      receipts: stores.receiptStore,
    });

    const resolved = await runtime.resolveImmutableSource({
      expectedInstallationId: "10",
      repositoryId: "100",
      ref: "refs/heads/main",
      expectedSha: sourceSha,
      expectedTree: sourceTree,
      approvedByCallId: "resolve-call",
    });
    expect(resolved.resolvedSha).toBe(sourceSha);

    const created = await runtime.createFreshRepository({
      expectedProposalDigest: fresh.digest,
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "create-call",
    });
    const retried = await runtime.createFreshRepository({
      expectedProposalDigest: fresh.digest,
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "retry-call",
    });
    expect(created.parentCount).toBe(0);
    expect(retried).toEqual(created);
    expect(provider.freshMutations).toBe(1);
    expect(provider.freshContent?.files[0]).toMatchObject({
      path: "README.md",
      mode: "100644",
      objectId: templateObjectId,
      digest: templateDigest,
    });

    const published = await runtime.publishDraftPullRequest({
      expectedProposalDigest: draft.digest,
      approvalReceipt: approvalReceipt(draft),
      review: review(),
      contentSource: publicationContentSource(),
      approvedByCallId: "publish-call",
    });
    expect(published.draft).toBe(true);
    expect(published.normalizedChangedPaths).toEqual(draft.approvedPaths);
    expect(provider.draftMutations).toBe(1);
    expect(provider.draftContent?.changes[0]).toMatchObject({
      path: "apps/demo/page.tsx",
      kind: "added",
      after: { mode: "644", digest: reviewedBytesDigest },
    });
    expect(stores.proposals.get(fresh.digest)).toEqual(fresh);
    expect(stores.proposals.get(draft.digest)).toEqual(draft);
    expect(JSON.stringify([...stores.proposals.values()])).not.toContain(
      '"bytes"',
    );
    expect(JSON.stringify([...stores.receipts.values()])).not.toContain(
      '"bytes"',
    );
  });

  it("seals and durably reads back a default-branch proposal without provider mutation", async () => {
    const provider = new Provider();
    const stores = new MemoryStores();
    const runtime = composeGitHubPublicationRuntime({
      enabled: true,
      adapter: createGitHubAppPublicationAdapter(provider),
      proposals: stores.proposalStore,
      receipts: stores.receiptStore,
    });
    const githubSource = await runtime.resolveImmutableSource({
      expectedInstallationId: "10",
      repositoryId: "100",
      ref: "refs/heads/main",
      expectedSha: sourceSha,
      expectedTree: sourceTree,
      approvedByCallId: "resolve-call",
    });

    const proposal = await runtime.sealDraftPullRequestProposal({
      githubSource,
      source: source("existing-repository"),
      review: review(),
      title: "Add demo",
    });

    await expect(stores.proposalStore.read(proposal.digest)).resolves.toEqual(
      proposal,
    );
    expect(proposal.baseBranch).toBe("main");
    expect(proposal.baseSha).toBe(sourceSha);
    expect(proposal.baseTree).toBe(sourceTree);
    expect(provider.repositoryInspections).toEqual([
      { repositoryId: "100", ref: "refs/heads/main" },
      { repositoryId: "100", ref: "refs/heads/main" },
    ]);
    expect(provider.draftMutations).toBe(0);
  });

  it("refuses to seal a proposal from a non-default immutable ref", async () => {
    const provider = new Provider();
    const stores = new MemoryStores();
    const runtime = composeGitHubPublicationRuntime({
      enabled: true,
      adapter: createGitHubAppPublicationAdapter(provider),
      proposals: stores.proposalStore,
      receipts: stores.receiptStore,
    });
    const githubSource = await runtime.resolveImmutableSource({
      expectedInstallationId: "10",
      repositoryId: "100",
      ref: "refs/heads/feature",
      expectedSha: sourceSha,
      expectedTree: sourceTree,
      approvedByCallId: "resolve-call",
    });

    await expect(
      runtime.sealDraftPullRequestProposal({
        githubSource,
        source: source("existing-repository"),
        review: review(),
        title: "Add demo",
      }),
    ).rejects.toThrow(/immutable default-branch source/u);
    expect(provider.repositoryInspections).toHaveLength(1);
    expect(stores.proposals.size).toBe(0);
    expect(provider.draftMutations).toBe(0);
  });

  it("records the current default-branch observation when it advanced after source resolution", async () => {
    const provider = new Provider();
    const stores = new MemoryStores();
    const runtime = composeGitHubPublicationRuntime({
      enabled: true,
      adapter: createGitHubAppPublicationAdapter(provider),
      proposals: stores.proposalStore,
      receipts: stores.receiptStore,
    });
    const githubSource = await runtime.resolveImmutableSource({
      expectedInstallationId: "10",
      repositoryId: "100",
      ref: "refs/heads/main",
      expectedSha: sourceSha,
      expectedTree: sourceTree,
      approvedByCallId: "resolve-call",
    });
    provider.inspectRepository = async (input) => {
      provider.repositoryInspections.push(input);
      return {
        ...provider.repositorySnapshot(),
        headSha: branchSha,
      };
    };

    await expect(
      runtime.sealDraftPullRequestProposal({
        githubSource,
        source: source("existing-repository"),
        review: review(),
        title: "Add demo",
      }),
    ).rejects.toThrow(/stale, overlapping, or unauthorized/u);
    expect(stores.proposals.size).toBe(0);
    expect(provider.draftMutations).toBe(0);
  });

  it("rejects cross-kind proposal lookup before any mutation", async () => {
    const provider = new Provider();
    const stores = new MemoryStores();
    const fresh = freshProposal();
    await stores.save(fresh);
    const runtime = composeGitHubPublicationRuntime({
      enabled: true,
      adapter: createGitHubAppPublicationAdapter(provider),
      proposals: stores.proposalStore,
      receipts: stores.receiptStore,
    });
    await expect(
      runtime.publishDraftPullRequest({
        expectedProposalDigest: fresh.digest,
        approvalReceipt: approvalReceipt(draftProposal()),
        review: review(),
        contentSource: publicationContentSource(),
        approvedByCallId: "call",
      }),
    ).rejects.toThrow(/unavailable or changed/u);
    expect(provider.draftMutations).toBe(0);
  });

  it("rebinds every PostgreSQL index column to closed proposal and journal JSON", async () => {
    const proposal = freshProposal();
    const createdAt = new Date(1_000);
    expect(
      parseGitHubPublicationProposalRow({
        proposalDigest: proposal.digest,
        kind: "fresh-repository",
        idempotencyKey: proposal.idempotencyKey,
        proposal,
        createdAt,
      }),
    ).toEqual(proposal);
    expect(() =>
      parseGitHubPublicationProposalRow({
        proposalDigest: proposal.digest,
        kind: "draft-pull-request",
        idempotencyKey: proposal.idempotencyKey,
        proposal,
        createdAt,
      }),
    ).toThrow(/canonically bound/u);
    expect(() =>
      parseGitHubPublicationProposalRow({
        proposalDigest: proposal.digest,
        kind: "fresh-repository",
        idempotencyKey: proposal.idempotencyKey,
        proposal: null,
        createdAt,
      }),
    ).toThrow(/malformed/u);

    const unsigned = {
      version: GITHUB_PUBLICATION_VERSION,
      kind: "fresh-repository" as const,
      status: "pending" as const,
      proposalDigest: proposal.digest,
      idempotencyKey: proposal.idempotencyKey,
      approvedByCallId: "approval-call",
    };
    const receipt = { ...unsigned, digest: hash(unsigned) };
    const row = {
      proposalDigest: proposal.digest,
      kind: receipt.kind,
      idempotencyKey: proposal.idempotencyKey,
      receiptDigest: receipt.digest,
      status: receipt.status,
      record: receipt,
      createdAt,
      updatedAt: createdAt,
    };
    expect(parseGitHubPublicationJournalRow(row)).toEqual(receipt);
    expect(() =>
      parseGitHubPublicationJournalRow({
        ...row,
        receiptDigest: "0".repeat(64),
      }),
    ).toThrow(/canonically bound/u);

    const [migration, journal] = await Promise.all([
      readFile("drizzle/0005_github_publication_journal.sql", "utf8"),
      readFile("drizzle/meta/_journal.json", "utf8"),
    ]);
    expect(migration).toContain('CREATE TABLE "github_publication_proposal"');
    expect(migration).toContain('CREATE TABLE "github_publication_journal"');
    expect(migration).toContain('"proposal_digest" text NOT NULL');
    expect(migration).toContain('"receipt_digest" text NOT NULL');
    expect(journal).toContain('"tag": "0005_github_publication_journal"');
  });
});
