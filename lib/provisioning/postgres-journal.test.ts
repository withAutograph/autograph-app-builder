/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- Query doubles deliberately implement only exercised asynchronous database methods. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";

import { initialBuilderProvisionJournalRecord } from "./journal";
import { createPostgresBuilderProvisionJournalStore } from "./postgres-journal";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const now = new Date("2026-10-10T12:00:00Z");
const request = {
  appName: "App",
  operation: "github" as const,
  providers: { githubInstallationId: "123" },
  repository: { name: "app", private: true },
  requestId: "11111111-1111-4111-8111-111111111111",
  version: 1 as const,
};
const fixture = () => {
  const queries: SQL[] = [];
  const chain = {
    from: vi.fn(() => chain),
    limit: vi.fn(async () => []),
    orderBy: vi.fn(() => chain),
    returning: vi.fn(async () => []),
    set: vi.fn(() => chain),
    where: vi.fn((query: SQL) => {
      queries.push(query);
      return chain;
    }),
  };
  const database = { select: () => chain, update: () => chain };
  // SAFETY: The query double implements all methods exercised by these tests.
  const store = createPostgresBuilderProvisionJournalStore(database as never);
  return { queries, store };
};

describe("legacy provision journal selectors", () => {
  it("reads only untagged rows using every tenant field", async () => {
    const { store, queries } = fixture();
    await store.read({ authority, requestId: request.requestId });
    const query = new PgDialect().sqlToQuery(queries[0]);
    expect(query.sql).toContain("->> 'kind' IS NULL");
    expect(query.params).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      request.requestId,
    ]);
  });

  it("restricts retries to untagged rows before selecting due operations", async () => {
    const { store, queries } = fixture();
    await store.listDue?.({ limit: 10, now });
    const query = new PgDialect().sqlToQuery(queries[0]);
    expect(query.sql).toContain("->> 'kind' IS NULL");
    expect(query.sql).not.toContain("is distinct from 'app-runtime'");
  });

  it("CAS cannot update a tagged custody or runtime row", async () => {
    const { store, queries } = fixture();
    // The exact untagged schema remains the legacy reader's format.
    const record = initialBuilderProvisionJournalRecord(request, now);
    await store.compareAndSet({
      authority,
      expectedRevision: 4,
      now,
      record,
      requestId: request.requestId,
    });
    const query = new PgDialect().sqlToQuery(queries[0]);
    expect(query.sql).toContain("->> 'kind' IS NULL");
    expect(query.params.at(-1)).toBe(4);
  });
});
