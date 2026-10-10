/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion, anti-slop/no-unknown-returns, anti-slop/no-unknown-parameters -- Query doubles deliberately implement only exercised asynchronous database methods. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createPostgresHostedAdminStore } from "./postgres-hosted-admin";
import { builderProvisioningJournals, hostedWorkspaceMemberships } from "./schema";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const fixture = () => {
  const journalDeletes: SQL[] = [];
  const database = {
    delete: (table: unknown) => {
      const chain = {
        returning: async () =>
          table === hostedWorkspaceMemberships ? [{ workspaceId: "workspace" }] : [],
        where: (query: SQL) => {
          if (table === builderProvisioningJournals) {
            journalDeletes.push(query);
          }
          return chain;
        },
      };
      return chain;
    },
    select: () => {
      const chain = {
        for: async () => [{ workspaceId: "workspace" }],
        from: () => chain,
        limit: () => chain,
        where: () => chain,
      };
      return chain;
    },
    transaction: async (run: (transaction: unknown) => unknown) => run(database),
  };
  // SAFETY: The query double implements all methods exercised by these tests.
  return { journalDeletes, store: createPostgresHostedAdminStore(database as never) };
};
const assertPreservesCustody = (queries: SQL[]) => {
  expect(queries).toHaveLength(1);
  const query = new PgDialect().sqlToQuery(queries[0]);
  expect(query.sql).toContain("->> 'kind' IS DISTINCT FROM 'vercel-token-key-custody-v1'");
  expect(query.params.slice(0, 4)).toEqual([
    authority.issuer,
    authority.audience,
    authority.workspaceId,
    authority.ownerUserId,
  ]);
};

describe("hosted admin custody tombstones", () => {
  it("retention preserves settled custody records while allowing untagged records", async () => {
    const { store, journalDeletes } = fixture();
    await store.applyRetention({ authority, deleteBefore: new Date("2026-10-01T00:00:00Z") });
    assertPreservesCustody(journalDeletes);
    expect(new PgDialect().sqlToQuery(journalDeletes[0]).params).toContain("settled");
  });

  it("tenant deletion preserves pending and settled global custody evidence", async () => {
    const { store, journalDeletes } = fixture();
    await store.deleteTenant({
      authority,
      membershipRevokedBefore: new Date("2026-10-01T00:00:00Z"),
    });
    assertPreservesCustody(journalDeletes);
    expect(new PgDialect().sqlToQuery(journalDeletes[0]).sql).not.toContain('"state"');
  });
});
