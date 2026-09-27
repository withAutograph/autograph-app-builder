import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import type * as databaseSchema from "../db/schema";
import { hostedGitHubPublicationJournals, hostedGitHubPublicationProposals } from "../db/schema";
import type { DraftPullRequestProposal, GitHubMutationReceipt } from "./github-publication";
import { GITHUB_PUBLICATION_VERSION, createRepositoryObservation } from "./github-publication";
import {
  createPostgresGitHubPublicationReceiptStore,
  parseGitHubPublicationJournalRow,
} from "./postgres-github-publication-receipt-store";
import {
  createPostgresGitHubPublicationStores,
  sameProposalExceptTitle,
} from "./postgres-github-publication-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
} as const;

const sha256 = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function pendingReceipt(
  overrides: Partial<Omit<GitHubMutationReceipt, "version" | "kind" | "status" | "digest">> = {},
) {
  const unsigned = {
    approvedByCallId: "approval-call",
    idempotencyKey: "b".repeat(64),
    kind: "draft-pull-request" as const,
    proposalDigest: "a".repeat(64),
    status: "pending" as const,
    version: GITHUB_PUBLICATION_VERSION,
    ...overrides,
  };
  return { ...unsigned, digest: sha256(unsigned) };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function journalRow(receipt: GitHubMutationReceipt = pendingReceipt()) {
  return {
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    idempotencyKey: receipt.idempotencyKey,
    kind: receipt.kind,
    proposalDigest: receipt.proposalDigest,
    receiptDigest: receipt.digest,
    record: receipt,
    status: receipt.status,
    updatedAt: new Date("2026-08-27T00:01:00.000Z"),
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function databaseFixture(input: {
  selected?: unknown[];
  inserted?: unknown[];
  updated?: unknown[];
}) {
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const limit = vi.fn(async () => input.selected ?? []);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const returningInsert = vi.fn(async () => input.inserted ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning: returningInsert }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
  const returningUpdate = vi.fn(async () => input.updated ?? []);
  const whereUpdate = vi.fn(() => ({ returning: returningUpdate }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));

  return {
    database: { insert, select, update } as unknown as Database,
    insert,
    limit,
    onConflictDoNothing,
    select,
    set,
    update,
    values,
    whereUpdate,
  };
}

describe("PostgreSQL GitHub publication receipt journal", () => {
  it("finds one tenant-scoped successful draft receipt by repository and PR number", async () => {
    const unsigned = {
      approvedByCallId: "approval-call",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      branchName: "app-builder/review-test",
      branchSha: "b".repeat(40),
      branchTree: "c".repeat(40),
      changeSetDigest: "d".repeat(64),
      changedContentDigest: "e".repeat(64),
      draft: true as const,
      idempotencyKey: "f".repeat(64),
      installationIdentityDigest: "1".repeat(64),
      kind: "draft-pull-request" as const,
      normalizedChangedPaths: ["apps/example/app/page.tsx"],
      proposalDigest: "2".repeat(64),
      providerReadBackDigest: "3".repeat(64),
      pullRequestId: "400",
      pullRequestNumber: 7,
      recoveredFromPending: false,
      releaseGateUnchanged: true as const,
      repositoryId: "100",
      status: "succeeded" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    const receipt = { ...unsigned, digest: sha256(unsigned) };
    const fixture = databaseFixture({ selected: [journalRow(receipt)] });
    const store = createPostgresGitHubPublicationReceiptStore(fixture.database, authority);
    await expect(store.findDraftByPullRequest?.("100", 7)).resolves.toEqual(receipt);
    expect(fixture.limit).toHaveBeenCalledWith(2);
    await expect(store.findDraftByPullRequest?.("100", 0)).rejects.toThrow(
      "verified repository ID and positive PR number",
    );
    const ambiguous = databaseFixture({ selected: [journalRow(receipt), journalRow(receipt)] });
    await expect(
      createPostgresGitHubPublicationReceiptStore(
        ambiguous.database,
        authority,
      ).findDraftByPullRequest?.("100", 7),
    ).rejects.toThrow("Multiple Builder publication receipts");
  });

  it("reuses an identical sealed proposal when only its requested title changes", () => {
    const proposal: DraftPullRequestProposal = {
      approvedPaths: ["apps/example/app/page.tsx"],
      baseBranch: "main",
      baseSha: "a".repeat(40),
      baseTree: "b".repeat(40),
      branchName: "app-builder/review-test",
      changeSetDigest: "c".repeat(64),
      changedContentDigest: "d".repeat(64),
      digest: "e".repeat(64),
      draft: true,
      idempotencyKey: "f".repeat(64),
      installationIdentityDigest: "1".repeat(64),
      intendedOutcome: "publish-reviewed-change-set-as-draft-pull-request",
      name: "example",
      owner: "withAutograph",
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: "100",
      repositoryObservationDigest: "2".repeat(64),
      reviewDigest: "3".repeat(64),
      title: "Original title",
      version: GITHUB_PUBLICATION_VERSION,
      visibility: "private",
    };
    expect(
      sameProposalExceptTitle(proposal, {
        ...proposal,
        digest: "4".repeat(64),
        title: "Revised title",
      }),
    ).toBe(true);
    expect(
      sameProposalExceptTitle(proposal, { ...proposal, approvedPaths: ["apps/other/page.tsx"] }),
    ).toBe(false);
    expect(sameProposalExceptTitle(proposal, { ...proposal, baseSha: "5".repeat(40) })).toBe(false);
  });
  it("accepts only a canonically rebound closed receipt row", () => {
    const receipt = pendingReceipt();
    expect(parseGitHubPublicationJournalRow(journalRow(receipt))).toEqual(receipt);
    expect(() =>
      parseGitHubPublicationJournalRow({
        ...journalRow(receipt),
        receiptDigest: "c".repeat(64),
      }),
    ).toThrow("canonically bound");
    expect(() =>
      parseGitHubPublicationJournalRow({
        ...journalRow(receipt),
        updatedAt: new Date("2026-08-26T23:59:00.000Z"),
      }),
    ).toThrow("canonically bound");
    expect(() =>
      parseGitHubPublicationJournalRow({
        ...journalRow(receipt),
        record: { ...receipt, ambientToken: "forbidden" },
      }),
    ).toThrow("fields are missing or unexpected");
  });

  it("restores JSONB key order for pending and terminal publication receipts", () => {
    const pending = pendingReceipt();
    const failedUnsigned = {
      approvedByCallId: "approval-call",
      failureCode: "provider-rejected" as const,
      idempotencyKey: pending.idempotencyKey,
      kind: "draft-pull-request" as const,
      proposalDigest: pending.proposalDigest,
      providerCode: "missing-access",
      recoveryRequired: true as const,
      status: "failed" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    const failed = { ...failedUnsigned, digest: sha256(failedUnsigned) };
    const base = {
      approvedByCallId: "approval-call",
      baseBranch: "main",
      baseSha: "a".repeat(40),
      branchName: "app-builder/review-test",
      branchSha: "b".repeat(40),
      branchTree: "c".repeat(40),
      changeSetDigest: "d".repeat(64),
      changedContentDigest: "e".repeat(64),
      draft: true as const,
      idempotencyKey: pending.idempotencyKey,
      installationIdentityDigest: "f".repeat(64),
      kind: "draft-pull-request" as const,
      normalizedChangedPaths: ["apps/example/app/page.tsx"],
      proposalDigest: pending.proposalDigest,
      providerReadBackDigest: "1".repeat(64),
      pullRequestId: "400",
      pullRequestNumber: 7,
      recoveredFromPending: false,
      releaseGateUnchanged: true as const,
      repositoryId: "100",
      status: "succeeded" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    const draft = { ...base, digest: sha256(base) };
    const repository = createRepositoryObservation({
      defaultBranch: "main",
      headSha: "b".repeat(40),
      headTree: "c".repeat(40),
      installationIdentityDigest: "f".repeat(64),
      name: "example",
      owner: "withAutograph",
      releaseGate: { configured: false, name: "REPOSITORY_RELEASE_ENABLED" },
      repositoryId: "100",
      visibility: "private",
    });
    const freshUnsigned = {
      approvedByCallId: "approval-call",
      freshHistory: true as const,
      idempotencyKey: pending.idempotencyKey,
      initialCommitSha: repository.headSha,
      initialCommitTree: repository.headTree,
      installationIdentityDigest: repository.installationIdentityDigest,
      kind: "fresh-repository" as const,
      parentCount: 0 as const,
      proposalDigest: pending.proposalDigest,
      providerReadBackDigest: "1".repeat(64),
      recoveredFromPending: false,
      releaseGateAbsent: true as const,
      repository,
      status: "succeeded" as const,
      version: GITHUB_PUBLICATION_VERSION,
    };
    const fresh = { ...freshUnsigned, digest: sha256(freshUnsigned) };
    for (const receipt of [pending, failed, draft, fresh]) {
      const reordered = Object.fromEntries(Object.entries(receipt).toReversed());
      if (receipt.kind === "fresh-repository" && receipt.status === "succeeded") {
        reordered.repository = {
          ...Object.fromEntries(Object.entries(receipt.repository).toReversed()),
          releaseGate: Object.fromEntries(
            Object.entries(receipt.repository.releaseGate).toReversed(),
          ),
        };
      }
      expect(
        parseGitHubPublicationJournalRow({
          ...journalRow(),
          idempotencyKey: receipt.idempotencyKey,
          kind: receipt.kind,
          proposalDigest: receipt.proposalDigest,
          receiptDigest: receipt.digest,
          record: reordered,
          status: receipt.status,
        }),
      ).toEqual(receipt);
    }
  });

  it("reads only one exact proposal-digest row", async () => {
    const receipt = pendingReceipt();
    const fixture = databaseFixture({ selected: [journalRow(receipt)] });
    const store = createPostgresGitHubPublicationReceiptStore(fixture.database, authority);
    await expect(store.read(receipt.proposalDigest)).resolves.toEqual(receipt);
    expect(fixture.select).toHaveBeenCalledTimes(1);
    expect(fixture.select).toHaveBeenCalledWith({
      createdAt: hostedGitHubPublicationJournals.createdAt,
      idempotencyKey: hostedGitHubPublicationJournals.idempotencyKey,
      kind: hostedGitHubPublicationJournals.kind,
      proposalDigest: hostedGitHubPublicationJournals.proposalDigest,
      receiptDigest: hostedGitHubPublicationJournals.receiptDigest,
      record: hostedGitHubPublicationJournals.record,
      status: hostedGitHubPublicationJournals.status,
      updatedAt: hostedGitHubPublicationJournals.updatedAt,
    });
    expect(fixture.limit).toHaveBeenCalledWith(1);
    await expect(store.read("not-a-digest")).rejects.toThrow("proposal digest");
  });

  it("projects a closed proposal row without tenant metadata", async () => {
    const fixture = databaseFixture({
      selected: [
        {
          createdAt: new Date("2026-08-27T00:00:00.000Z"),
          idempotencyKey: "b".repeat(64),
          kind: "draft-pull-request",
          proposal: null,
          proposalDigest: "a".repeat(64),
        },
      ],
    });
    const stores = createPostgresGitHubPublicationStores(fixture.database, authority);
    await expect(stores.proposals.read("a".repeat(64))).rejects.toThrow(
      "GitHub publication proposal JSON is malformed",
    );
    expect(fixture.select).toHaveBeenCalledWith({
      createdAt: hostedGitHubPublicationProposals.createdAt,
      idempotencyKey: hostedGitHubPublicationProposals.idempotencyKey,
      kind: hostedGitHubPublicationProposals.kind,
      proposal: hostedGitHubPublicationProposals.proposal,
      proposalDigest: hostedGitHubPublicationProposals.proposalDigest,
    });
  });

  it("claims absent intent with insert-only conflict handling", async () => {
    const receipt = pendingReceipt();
    const successful = databaseFixture({
      inserted: [{ proposalDigest: receipt.proposalDigest }],
    });
    const store = createPostgresGitHubPublicationReceiptStore(
      successful.database,
      authority,
      () => new Date("2026-08-27T00:00:00.000Z"),
    );
    await expect(store.compareAndSet(receipt.proposalDigest, undefined, receipt)).resolves.toBe(
      true,
    );
    expect(successful.insert).toHaveBeenCalledTimes(1);
    expect(successful.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(successful.update).not.toHaveBeenCalled();

    const collided = databaseFixture({ inserted: [] });
    await expect(
      createPostgresGitHubPublicationReceiptStore(collided.database, authority).compareAndSet(
        receipt.proposalDigest,
        undefined,
        receipt,
      ),
    ).resolves.toBe(false);
  });

  it("settles only the exact prior receipt digest", async () => {
    const receipt = pendingReceipt();
    const fixture = databaseFixture({
      updated: [{ proposalDigest: receipt.proposalDigest }],
    });
    const store = createPostgresGitHubPublicationReceiptStore(fixture.database, authority);
    await expect(
      store.compareAndSet(receipt.proposalDigest, "c".repeat(64), receipt),
    ).resolves.toBe(true);
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.whereUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.insert).not.toHaveBeenCalled();
    await expect(store.compareAndSet("d".repeat(64), "c".repeat(64), receipt)).rejects.toThrow(
      "CAS binding",
    );
  });

  it("keeps CAS predicates and the durable migration closed", async () => {
    const [adapter, migration] = await Promise.all([
      readFile("lib/repository/postgres-github-publication-receipt-store.ts", "utf-8"),
      readFile("drizzle/0006_tenant_github_publication.sql", "utf-8"),
    ]);
    expect(adapter).toContain("eq(hostedGitHubPublicationJournals.proposalDigest, proposalDigest)");
    expect(adapter).toContain("eq(hostedGitHubPublicationJournals.receiptDigest, expectedDigest)");
    expect(adapter).toContain("eq(hostedGitHubPublicationJournals.kind, receipt.kind)");
    expect(adapter).toContain("hostedGitHubPublicationJournals.idempotencyKey");
    expect(adapter).toContain("hostedGitHubPublicationJournals.issuer");
    expect(adapter).toContain("hostedGitHubPublicationJournals.workspaceId");
    expect(migration).toContain('CREATE TABLE "hosted_github_publication_journal"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "hosted_github_publication_journal_idempotency_uidx"',
    );
    expect(migration).toContain("CHECK (\"status\" IN ('pending', 'failed', 'succeeded'))");
  });
});
