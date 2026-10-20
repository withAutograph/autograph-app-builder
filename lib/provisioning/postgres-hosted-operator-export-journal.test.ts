/* oxlint-disable eslint/require-await -- Database query doubles expose only the SELECT/CAS operations exercised here. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it, vi } from "vitest";
import { createPostgresTenantExportJournalStore } from "./postgres-hosted-operator-export-journal";

const authority = {
  issuer: "https://builder.test/api/auth",
  audience: "https://builder.test/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const fixture = () => {
  const queries: SQL[] = [];
  const chain = {
    from: vi.fn(() => chain),
    limit: vi.fn(async () => []),
    set: vi.fn(() => chain),
    returning: vi.fn(async () => []),
    where: vi.fn((value: SQL) => {
      queries.push(value);
      return chain;
    }),
  };
  const database = { select: () => chain, update: () => chain };
  // SAFETY: The controlled query double implements every method used by these read cases.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This existing database-fixture pattern isolates SQL generation without live databases.
  const store = createPostgresTenantExportJournalStore(database as never);
  return { store, queries };
};
describe("separate tenant export journal authority", () => {
  it("selects only app-export records under all owner coordinates and its distinct UUID", async () => {
    const f = fixture();
    const exportId = "10000000-0000-4000-8000-000000000001";
    expect(await f.store.read({ authority, exportId })).toBeUndefined();
    const query = new PgDialect().sqlToQuery(f.queries[0]);
    expect(query.sql).toContain("->> 'kind' = 'app-export'");
    expect(query.params).toEqual([
      authority.issuer,
      authority.audience,
      authority.workspaceId,
      authority.ownerUserId,
      exportId,
    ]);
  });
});
