import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import * as databaseSchema from "../db/schema";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createPostgresOAuthMembershipAuthority,
  createPostgresWorkspaceMembership,
} from "./postgres-workspace-membership";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const principal: HostedPrincipal = {
  issuer: "https://identity.example.test",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_1",
  ownerUserId: "user_1",
  scopes: ["autograph:session"],
};

function databaseReturning<T extends Record<string, unknown>>(rows: T[]) {
  const limit = vi.fn(async () => rows);
  const where = vi.fn(() => ({ limit }));
  const joined = { innerJoin: undefined as unknown, where };
  const innerJoin = vi.fn(() => joined);
  joined.innerJoin = innerJoin;
  const from = vi.fn(() => joined);
  const select = vi.fn(() => ({ from }));
  return {
    database: { select } as unknown as Database,
    select,
    from,
    innerJoin,
    where,
    limit,
  };
}

describe("PostgreSQL workspace membership", () => {
  it.each([
    [[], false],
    [[{ role: "revoked", banned: false }], false],
    [[{ role: "member", banned: true }], false],
    [[{ role: "member", banned: false }], true],
    [[{ role: "admin", banned: false }], true],
    [[{ role: "owner", banned: false }], true],
    [
      [
        { role: "member", banned: false },
        { role: "member", banned: false },
      ],
      false,
    ],
  ] as const)(
    "admits only one canonical Better Auth membership",
    async (rows, expected) => {
      const fixture = databaseReturning([...rows]);
      await expect(
        createPostgresWorkspaceMembership(fixture.database).isMember({
          principal,
          workspaceId: principal.workspaceId,
        }),
      ).resolves.toBe(expected);
      expect(fixture.limit).toHaveBeenCalledWith(2);
    },
  );

  it("rejects a non-claim workspace before querying storage", async () => {
    const fixture = databaseReturning([{ active: true }]);
    await expect(
      createPostgresWorkspaceMembership(fixture.database).isMember({
        principal,
        workspaceId: "workspace_other",
      }),
    ).resolves.toBe(false);
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it.each([
    [[], undefined],
    [
      [{ workspaceId: "workspace_1", role: "owner", banned: false }],
      "workspace_1",
    ],
    [[{ workspaceId: "workspace_1", role: "member", banned: true }], undefined],
    [
      [{ workspaceId: "workspace_1", role: "revoked", banned: false }],
      undefined,
    ],
    [
      [
        { workspaceId: "workspace_1", role: "member", banned: false },
        { workspaceId: "workspace_2", role: "member", banned: false },
      ],
      undefined,
    ],
  ] as const)(
    "selects only one exact active OAuth workspace",
    async (rows, expected) => {
      const fixture = databaseReturning([...rows]);
      await expect(
        createPostgresOAuthMembershipAuthority(
          fixture.database,
        ).activeWorkspaceForUser({
          issuer: principal.issuer,
          audience: principal.audience,
          ownerUserId: principal.ownerUserId,
        }),
      ).resolves.toBe(expected);
      expect(fixture.limit).toHaveBeenCalledWith(2);
    },
  );

  it("propagates database failures for the request boundary to fail closed", async () => {
    const database = {
      select() {
        throw new Error("database unavailable");
      },
    } as unknown as Database;
    await expect(
      createPostgresWorkspaceMembership(database).isMember({
        principal,
        workspaceId: principal.workspaceId,
      }),
    ).rejects.toThrow("database unavailable");
  });
});
