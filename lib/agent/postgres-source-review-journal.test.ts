/* oxlint-disable typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion, eslint/require-await -- Test doubles implement only the exercised Drizzle builder methods and deliberately supply invalid authentication. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createPostgresSourceReviewJournal } from "./postgres-source-review-journal";
import type { SourceReviewJournalRecord } from "./product-source-review-journal";

const applicationRecord: SourceReviewJournalRecord = {
  assessment: {
    basis: "source-review",
    bindingDigest: "a".repeat(64),
    evidenceDigest: "b".repeat(64),
    evidenceNote: "Validated source evidence; runtime behavior remains unassessed.",
    findings: [],
    modelId: "review-model",
    omissions: [],
    reason: "No cited source contradiction was identified.",
    remainingRuntimeChecks: [],
    reviewCompleted: true,
    status: "unassessed",
  },
  kind: "application-completed",
};

const auth = (owner = "owner") => {
  const context = {
    attributes: {
      "mcp:audience": "https://builder.example/mcp",
      "mcp:scopes": ["builder:read", "builder:write"],
      "mcp:workspace-id": "workspace",
    },
    authenticator: "mcp-oauth-jwks",
    issuer: "https://builder.example/api/auth",
    principalId: owner,
    principalType: "user",
    subject: owner,
  };
  return { current: context, initiator: context };
};
const fixture = () => {
  let authorized = true;
  const assertCurrentOwner = vi.fn(async () => {
    if (!authorized) {
      throw new Error("ownership revoked");
    }
  });
  const records = new Map<string, string>();
  const dialect = new PgDialect();
  const where = vi.fn(async (predicate: SQL) => {
    const key = JSON.stringify(dialect.sqlToQuery(predicate).params);
    const record = records.get(key);
    return record === undefined ? [] : [{ record }];
  });
  const values = vi.fn(
    (row: {
      issuer: string;
      audience: string;
      workspaceId: string;
      ownerUserId: string;
      sessionId: string;
      pairKey: string;
      record: string;
    }) => ({
      async onConflictDoNothing() {
        const key = JSON.stringify([
          row.issuer,
          row.audience,
          row.workspaceId,
          row.ownerUserId,
          row.sessionId,
          row.pairKey,
        ]);
        if (!records.has(key)) {
          records.set(key, row.record);
        }
      },
    }),
  );
  const db = { insert: () => ({ values }), select: () => ({ from: () => ({ where }) }) };
  const create = (owner = "owner", sessionId = "session") =>
    createPostgresSourceReviewJournal({
      assertCurrentOwner,
      db: db as never,
      sessionAuth: auth(owner),
      sessionId,
    });
  const journal = create();
  return {
    assertCurrentOwner,
    create,
    journal,
    revoke: () => {
      authorized = false;
    },
    values,
    where,
  };
};
describe("authenticated PostgreSQL source review journal", () => {
  it("checks live evidence authority without loading a completed assessment", async () => {
    const { journal, assertCurrentOwner, where, revoke } = fixture();
    await journal.read("e".repeat(64));
    const lookups = where.mock.calls.length;
    assertCurrentOwner.mockClear();
    await journal.assertCurrentOwner();
    await journal.assertCurrentOwner();
    expect(assertCurrentOwner).toHaveBeenCalledTimes(2);
    expect(where).toHaveBeenCalledTimes(lookups);
    revoke();
    await expect(journal.assertCurrentOwner()).rejects.toThrow("ownership revoked");
    expect(where).toHaveBeenCalledTimes(lookups);
  });
  it("isolates completed application evidence and preserves the legacy winner without relabelling it", async () => {
    const { journal, create } = fixture();
    const key = "e".repeat(64);
    const fragmentKey = "f".repeat(64);
    await journal.put(key, applicationRecord);
    await journal.put(fragmentKey, { kind: "split-source" });
    expect(await create().read(key)).toEqual(applicationRecord);
    expect(await create("other").read(key)).toBeUndefined();
    expect(await create("owner", "other-session").read(key)).toBeUndefined();
    expect(await journal.put(fragmentKey, applicationRecord)).toEqual({ kind: "split-source" });
  });
  it("denies completed application evidence after live authority is revoked", async () => {
    const { journal, revoke } = fixture();
    const key = "e".repeat(64);
    await journal.put(key, applicationRecord);
    revoke();
    await expect(journal.read(key)).rejects.toThrow("ownership revoked");
    await expect(journal.put(key, applicationRecord)).rejects.toThrow("ownership revoked");
  });
  it("writes immutable owner/session rows and verifies retries", async () => {
    const { journal, values, where } = fixture();
    const key = "a".repeat(64);
    expect(await journal.read(key)).toBeUndefined();
    await journal.put(key, { kind: "split-source" });
    await journal.put(key, { kind: "split-source" });
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        audience: "https://builder.example/mcp",
        issuer: "https://builder.example/api/auth",
        ownerUserId: "owner",
        pairKey: key,
        sessionId: "session",
        workspaceId: "workspace",
      }),
    );
    expect(where).toHaveBeenCalled();
    expect(await journal.read(key)).toEqual({ kind: "split-source" });
    expect(await journal.put(key, { kind: "split-context" })).toEqual({ kind: "split-source" });
  });
  it("denies other authenticated principals and sessions the saved row", async () => {
    const { journal, create } = fixture();
    const key = "c".repeat(64);
    await journal.put(key, { kind: "split-context" });
    expect(await create("other").read(key)).toBeUndefined();
    expect(await create("owner", "other-session").read(key)).toBeUndefined();
    expect(await create().read(key)).toEqual({ kind: "split-context" });
  });
  it("checks fresh authority on every read and write", async () => {
    const { journal, revoke } = fixture();
    const key = "d".repeat(64);
    await journal.put(key, { kind: "split-source" });
    revoke();
    await expect(journal.read(key)).rejects.toThrow("ownership revoked");
    await expect(journal.put(key, { kind: "split-context" })).rejects.toThrow("ownership revoked");
  });
  it("rejects mismatched authority and propagates storage failure", async () => {
    expect(() =>
      createPostgresSourceReviewJournal({
        assertCurrentOwner: async () => {},
        db: {} as never,
        sessionAuth: { current: auth().current, initiator: auth("other").initiator },
        sessionId: "session",
      }),
    ).toThrow();
    const { journal, where } = fixture();
    where.mockRejectedValueOnce(new Error("database unavailable"));
    await expect(journal.read("b".repeat(64))).rejects.toThrow("database unavailable");
    await expect(journal.put("invalid", { kind: "split-source" })).rejects.toThrow();
  });
});
