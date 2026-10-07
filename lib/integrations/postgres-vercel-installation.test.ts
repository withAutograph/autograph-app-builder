import { describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { decryptVersionedVercelToken, encryptVercelToken } from "./vercel-installation";
import {
  createPostgresVercelAuthorizationStateStore,
  createPostgresVercelInstallationStore,
  readActiveVercelInstallationToken,
  readVercelInstallationBindings,
} from "./postgres-vercel-installation";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  workspaceId: "workspace_one",
};
const returnTo = "/handoff/ed5bc83d-a08f-42be-9635-4677fa7bdb32";
const resumeKey = "1c7ed773-0aa9-4e32-9e65-6eb36e7b5cc0";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function databaseFixture(rows: unknown[]) {
  const query = {
    from: vi.fn(),
    insert: vi.fn(),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    limit: vi.fn(async () => rows),
    onConflictDoUpdate: vi.fn(),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    orderBy: vi.fn(async () => rows),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    returning: vi.fn(async () => rows),
    select: vi.fn(),
    set: vi.fn(),
    update: vi.fn(),
    values: vi.fn(),
    where: vi.fn(),
  };
  for (const key of [
    "select",
    "update",
    "from",
    "set",
    "insert",
    "values",
    "onConflictDoUpdate",
    "where",
  ] as const) {
    query[key].mockReturnValue(query);
  }
  return {
    database: query as unknown as Parameters<typeof createPostgresVercelAuthorizationStateStore>[0],
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
      expect(observed.params).toEqual(expect.arrayContaining(Object.values(authority)));
      expect(observed.params).toContain(input.stateDigest);
      expect(observed.params).toContain(input.authorityDigest);
    }
  });

  it("rejects unsafe persisted redirects and returns no result for missing state", async () => {
    const invalid = createPostgresVercelAuthorizationStateStore(
      databaseFixture([{ resumeKey, returnTo: "https://evil.example" }]).database,
    );
    const input = {
      authority,
      authorityDigest: "b".repeat(64),
      now: new Date(),
      stateDigest: "a".repeat(64),
    };
    await expect(invalid.consume(input)).rejects.toThrow();
    await expect(invalid.recover(input)).rejects.toThrow();
    const empty = createPostgresVercelAuthorizationStateStore(databaseFixture([]).database);
    expect(await empty.consume(input)).toBeUndefined();
    expect(await empty.recover(input)).toBeUndefined();
  });

  it("narrows credential reads to all four tenant fields, active status, and selected installation", async () => {
    const { database, query } = databaseFixture([]);
    expect(
      await readActiveVercelInstallationToken({
        authority,
        config: {
          tokenKey: Buffer.alloc(32),
          tokenKeyVersion: "v1",
        },
        database,
        installationId: "icfg_selected",
      }),
    ).toBeUndefined();
    const observed = new PgDialect().sqlToQuery(query.where.mock.calls[0]?.[0]);
    expect(observed.params).toEqual([
      ...Object.values(authority).slice(0, 2),
      authority.workspaceId,
      authority.ownerUserId,
      "icfg_selected",
      true,
    ]);
  });

  it("lists owner-scoped Vercel bindings without OAuth client or key config", async () => {
    const row = {
      active: true,
      displayName: "Owner team",
      installationId: "icfg_selected",
      plan: "pro",
      scopeId: "team_1",
      scopeType: "team",
      slug: "owner-team",
      updatedAt: new Date(),
    };
    const { database, query } = databaseFixture([row]);
    expect(await readVercelInstallationBindings({ authority, database })).toEqual([row]);
    const observed = new PgDialect().sqlToQuery(query.where.mock.calls[0]?.[0]);
    expect(observed.params).toEqual([
      authority.audience,
      authority.issuer,
      authority.workspaceId,
      authority.ownerUserId,
    ]);
  });

  it("reads an installation token encrypted under a retained version with tenant-bound AAD", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const activeKey = Buffer.alloc(32, 4);
    const installationId = "icfg_rotated";
    const encrypted = encryptVercelToken({
      associatedData: JSON.stringify({ ...authority, installationId }),
      key: oldKey,
      token: "provider-token-sentinel",
    });
    const { database } = databaseFixture([
      {
        ...authority,
        ...encrypted,
        active: true,
        displayName: "Owner",
        installationId,
        plan: "pro",
        scopeId: "team_1",
        scopeType: "team",
        slug: "owner",
        tokenKeyVersion: "previous_v1",
        updatedAt: new Date(),
      },
    ]);
    const config = {
      previousTokenKeys: [{ key: oldKey, version: "previous_v1" }],
      tokenKey: activeKey,
      tokenKeyVersion: "current_v2",
    };
    expect(
      await readActiveVercelInstallationToken({
        authority,
        config,
        database,
        installationId,
      }),
    ).toMatchObject({
      binding: { active: true, installationId },
      token: "provider-token-sentinel",
    });
    await expect(
      readActiveVercelInstallationToken({
        authority: { ...authority, workspaceId: "other_workspace" },
        config,
        database,
        installationId,
      }),
    ).rejects.toThrow();
  });

  it("writes new installation tokens with the active key version", async () => {
    const oldKey = Buffer.alloc(32, 3);
    const currentKey = Buffer.alloc(32, 4);
    const { database, query } = databaseFixture([
      {
        active: true,
        displayName: "Owner",
        installationId: "icfg_current",
        plan: "pro",
        scopeId: "team_1",
        scopeType: "team",
        slug: "owner",
        updatedAt: new Date(),
      },
    ]);
    const config = {
      clientId: "public",
      clientSecret: "secret",
      issuer: authority.issuer,
      previousTokenKeys: [{ key: oldKey, version: "previous_v1" }],
      resource: authority.audience,
      slug: "autograph",
      tokenKey: currentKey,
      tokenKeyVersion: "current_v2",
    };
    await createPostgresVercelInstallationStore({ config, database }).bind({
      authority,
      binding: {
        displayName: "Owner",
        installationId: "icfg_current",
        plan: "pro",
        scopeId: "team_1",
        scopeType: "team",
        slug: "owner",
      },
      now: new Date(),
      token: "new-provider-token",
    });
    const stored: unknown = query.values.mock.calls[0]?.[0];
    expect(stored).toMatchObject({ tokenKeyVersion: "current_v2" });
    expect(
      decryptVersionedVercelToken({
        ...(stored as {
          encryptedToken: string;
          tokenIv: string;
          tokenTag: string;
          tokenKeyVersion: string;
        }),
        associatedData: JSON.stringify({ ...authority, installationId: "icfg_current" }),
        config: {
          previousTokenKeys: config.previousTokenKeys,
          tokenKey: config.tokenKey,
          tokenKeyVersion: config.tokenKeyVersion,
        },
        keyVersion: (stored as { tokenKeyVersion: string }).tokenKeyVersion,
      }),
    ).toBe("new-provider-token");
  });
});
