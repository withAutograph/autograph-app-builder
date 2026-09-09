import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import {
  createPostgresVercelAuthorizationStateStore,
  readActiveVercelInstallationToken,
} from "./postgres-vercel-installation";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};
const returnTo = "/handoff/ed5bc83d-a08f-42be-9635-4677fa7bdb32";
const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

function databaseFixture(rows: unknown[]) {
  const query = {
    select: vi.fn(),
    update: vi.fn(),
    from: vi.fn(),
    set: vi.fn(),
    where: vi.fn(),
    returning: vi.fn(async () => rows),
    limit: vi.fn(async () => rows),
  };
  for (const key of ["select", "update", "from", "set", "where"] as const)
    query[key].mockReturnValue(query);
  return {
    query,
    database: query as unknown as Parameters<
      typeof createPostgresVercelAuthorizationStateStore
    >[0],
  };
}

describe("durable Vercel connection return", () => {
  it("retains the handoff route and resume key on consume and recovery", async () => {
    const { database, query } = databaseFixture([{ returnTo, resumeKey }]);
    const store = createPostgresVercelAuthorizationStateStore(database);
    const input = {
      stateDigest: "a".repeat(64),
      authorityDigest: "b".repeat(64),
      authority,
      now: new Date(),
    };
    expect(await store.consume(input)).toEqual({ returnTo, resumeKey });
    expect(await store.recover(input)).toEqual({ returnTo, resumeKey });
    const dialect = new PgDialect();
    for (const [where] of query.where.mock.calls) {
      const observed = dialect.sqlToQuery(where);
      expect(observed.params).toEqual(
        expect.arrayContaining(Object.values(authority)),
      );
      expect(observed.params).toContain(input.stateDigest);
      expect(observed.params).toContain(input.authorityDigest);
    }
  });

  it("rejects unsafe persisted redirects and returns no result for missing state", async () => {
    const invalid = createPostgresVercelAuthorizationStateStore(
      databaseFixture([{ returnTo: "https://evil.example", resumeKey }])
        .database,
    );
    const input = {
      stateDigest: "a".repeat(64),
      authorityDigest: "b".repeat(64),
      authority,
      now: new Date(),
    };
    await expect(invalid.consume(input)).rejects.toThrow();
    await expect(invalid.recover(input)).rejects.toThrow();
    const empty = createPostgresVercelAuthorizationStateStore(
      databaseFixture([]).database,
    );
    expect(await empty.consume(input)).toBeUndefined();
    expect(await empty.recover(input)).toBeUndefined();
  });

  it("narrows credential reads to all four tenant fields, active status, and selected installation", async () => {
    const { database, query } = databaseFixture([]);
    expect(
      await readActiveVercelInstallationToken({
        database,
        authority,
        installationId: "icfg_selected",
        config: {
          issuer: authority.issuer,
          resource: authority.audience,
          slug: "autograph",
          clientId: "public",
          clientSecret: "secret",
          tokenKey: Buffer.alloc(32),
          tokenKeyVersion: "v1",
        },
      }),
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
