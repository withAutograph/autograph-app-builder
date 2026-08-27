import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import * as databaseSchema from "../db/schema";
import type { GitHubMutationReceipt } from "./github-publication";
import { GITHUB_PUBLICATION_VERSION } from "./github-publication";
import {
  createPostgresGitHubPublicationReceiptStore,
  parseGitHubPublicationJournalRow,
} from "./postgres-github-publication-receipt-store";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const sha256 = (value: unknown) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");

function pendingReceipt(
  overrides: Partial<
    Omit<GitHubMutationReceipt, "version" | "kind" | "status" | "digest">
  > = {},
) {
  const unsigned = {
    version: GITHUB_PUBLICATION_VERSION,
    kind: "draft-pull-request" as const,
    status: "pending" as const,
    proposalDigest: "a".repeat(64),
    idempotencyKey: "b".repeat(64),
    approvedByCallId: "approval-call",
    ...overrides,
  };
  return { ...unsigned, digest: sha256(unsigned) };
}

function journalRow(receipt = pendingReceipt()) {
  return {
    proposalDigest: receipt.proposalDigest,
    receiptDigest: receipt.digest,
    idempotencyKey: receipt.idempotencyKey,
    kind: receipt.kind,
    status: receipt.status,
    record: receipt,
    createdAt: new Date("2026-08-27T00:00:00.000Z"),
    updatedAt: new Date("2026-08-27T00:01:00.000Z"),
  };
}

function databaseFixture(input: {
  selected?: unknown[];
  inserted?: unknown[];
  updated?: unknown[];
}) {
  const limit = vi.fn(async () => input.selected ?? []);
  const whereSelect = vi.fn(() => ({ limit }));
  const from = vi.fn(() => ({ where: whereSelect }));
  const select = vi.fn(() => ({ from }));

  const returningInsert = vi.fn(async () => input.inserted ?? []);
  const onConflictDoNothing = vi.fn(() => ({ returning: returningInsert }));
  const values = vi.fn(() => ({ onConflictDoNothing }));
  const insert = vi.fn(() => ({ values }));

  const returningUpdate = vi.fn(async () => input.updated ?? []);
  const whereUpdate = vi.fn(() => ({ returning: returningUpdate }));
  const set = vi.fn(() => ({ where: whereUpdate }));
  const update = vi.fn(() => ({ set }));

  return {
    database: { select, insert, update } as unknown as Database,
    select,
    limit,
    insert,
    values,
    onConflictDoNothing,
    update,
    set,
    whereUpdate,
  };
}

describe("PostgreSQL GitHub publication receipt journal", () => {
  it("accepts only a canonically rebound closed receipt row", () => {
    const receipt = pendingReceipt();
    expect(parseGitHubPublicationJournalRow(journalRow(receipt))).toEqual(
      receipt,
    );
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
    ).toThrow("schema is not closed");
  });

  it("reads only one exact proposal-digest row", async () => {
    const receipt = pendingReceipt();
    const fixture = databaseFixture({ selected: [journalRow(receipt)] });
    const store = createPostgresGitHubPublicationReceiptStore(fixture.database);
    await expect(store.read(receipt.proposalDigest)).resolves.toEqual(receipt);
    expect(fixture.select).toHaveBeenCalledTimes(1);
    expect(fixture.limit).toHaveBeenCalledWith(1);
    await expect(store.read("not-a-digest")).rejects.toThrow("proposal digest");
  });

  it("claims absent intent with insert-only conflict handling", async () => {
    const receipt = pendingReceipt();
    const successful = databaseFixture({
      inserted: [{ proposalDigest: receipt.proposalDigest }],
    });
    const store = createPostgresGitHubPublicationReceiptStore(
      successful.database,
      () => new Date("2026-08-27T00:00:00.000Z"),
    );
    await expect(
      store.compareAndSet(receipt.proposalDigest, undefined, receipt),
    ).resolves.toBe(true);
    expect(successful.insert).toHaveBeenCalledTimes(1);
    expect(successful.onConflictDoNothing).toHaveBeenCalledTimes(1);
    expect(successful.update).not.toHaveBeenCalled();

    const collided = databaseFixture({ inserted: [] });
    await expect(
      createPostgresGitHubPublicationReceiptStore(
        collided.database,
      ).compareAndSet(receipt.proposalDigest, undefined, receipt),
    ).resolves.toBe(false);
  });

  it("settles only the exact prior receipt digest", async () => {
    const receipt = pendingReceipt();
    const fixture = databaseFixture({
      updated: [{ proposalDigest: receipt.proposalDigest }],
    });
    const store = createPostgresGitHubPublicationReceiptStore(fixture.database);
    await expect(
      store.compareAndSet(receipt.proposalDigest, "c".repeat(64), receipt),
    ).resolves.toBe(true);
    expect(fixture.update).toHaveBeenCalledTimes(1);
    expect(fixture.whereUpdate).toHaveBeenCalledTimes(1);
    expect(fixture.insert).not.toHaveBeenCalled();
    await expect(
      store.compareAndSet("d".repeat(64), "c".repeat(64), receipt),
    ).rejects.toThrow("CAS binding");
  });

  it("keeps CAS predicates and the durable migration closed", async () => {
    const [adapter, migration] = await Promise.all([
      readFile(
        "lib/repository/postgres-github-publication-receipt-store.ts",
        "utf8",
      ),
      readFile("drizzle/0005_github_publication_journal.sql", "utf8"),
    ]);
    expect(adapter).toContain(
      "eq(githubPublicationJournals.proposalDigest, proposalDigest)",
    );
    expect(adapter).toContain(
      "eq(githubPublicationJournals.receiptDigest, expectedDigest)",
    );
    expect(adapter).toContain(
      "eq(githubPublicationJournals.kind, receipt.kind)",
    );
    expect(adapter).toContain("githubPublicationJournals.idempotencyKey");
    expect(migration).toContain('CREATE TABLE "github_publication_journal"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "github_publication_journal_idempotency_idx"',
    );
    expect(migration).toContain(
      "CHECK (\"status\" IN ('pending', 'failed', 'succeeded'))",
    );
  });
});
