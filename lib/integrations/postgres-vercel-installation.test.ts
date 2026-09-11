import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it, vi } from "vitest";

import {
  createPostgresVercelAuthorizationStateStore,
  readActiveVercelInstallationToken,
} from "./postgres-vercel-installation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};
const returnTo = "/handoff/ed5bc83d-a08f-42be-9635-4677fa7bdb32";
const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

function databaseFixture(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    limit: vi.fn(async () => rows),
    returning: vi.fn(async () => rows),
    select: vi.fn(),
    set: vi.fn(),
    update: vi.fn(),
    where: vi.fn(),
  };
  for (const key of ["select", "update", "from", "set", "where"] as const) {
    query[key].mockReturnValue(query);
  }
  return {
    database: query as unknown as Parameters<
      typeof createPostgresVercelAuthorizationStateStore
    >[0],
    query,
  };
}

describe("durable Vercel connection return", () => {
  it("retains the handoff route and resume key on consume and recovery", async () => {
    const { database, query } = databaseFixture([{ resumeKey, returnTo }]);
    const store = createPostgresVercelAuthorizationStateStore(database);
    const input = {
      authority,
      authorityDigest: "b".repeat(64),
      now: new Date(),
      stateDigest: "a".repeat(64),
    };
    expect(await store.consume(input)).toEqual({ resumeKey, returnTo });
    expect(await store.recover(input)).toEqual({ resumeKey, returnTo });
    const dialect = new PgDialect();
    for (const [where] of query.where.mock.calls) {
      const observed = dialect.sqlToQuery(where);
      expect(observed.params).toEqual(
        expect.arrayContaining(Object.values(authority))
      );
      expect(observed.params).toContain(input.stateDigest);
      expect(observed.params).toContain(input.authorityDigest);
    }
  });

  it("rejects unsafe persisted redirects and returns no result for missing state", async () => {
    const invalid = createPostgresVercelAuthorizationStateStore(
      databaseFixture([{ resumeKey, returnTo: "https://evil.example" }])
        .database
    );
    const input = {
      authority,
      authorityDigest: "b".repeat(64),
      now: new Date(),
      stateDigest: "a".repeat(64),
    };
    await expect(invalid.consume(input)).rejects.toThrow();
    await expect(invalid.recover(input)).rejects.toThrow();
    const empty = createPostgresVercelAuthorizationStateStore(
      databaseFixture([]).database
    );
    expect(await empty.consume(input)).toBeUndefined();
    expect(await empty.recover(input)).toBeUndefined();
  });

  it("narrows credential reads to all four tenant fields, active status, and selected installation", async () => {
    const { database, query } = databaseFixture([]);
    expect(
      await readActiveVercelInstallationToken({
        authority,
        config: {
          clientId: "public",
          clientSecret: "secret",
          issuer: authority.issuer,
          resource: authority.audience,
          slug: "autograph",
          tokenKey: Buffer.alloc(32),
          tokenKeyVersion: "v1",
        },
        database,
        installationId: "icfg_selected",
      })
    ).toBeUndefined();
    const observed = new PgDialect().sqlToQuery(query.where.mock.calls[0]![0]);
    expect(observed.params).toEqual([
      ...Object.values(authority).slice(0, 2),
      authority.workspaceId,
      authority.ownerUserId,
      "icfg_selected",
      true,
    ]);
  });
});
