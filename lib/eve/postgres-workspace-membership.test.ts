import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { describe, expect, it, vi } from "vitest";

import type * as databaseSchema from "../db/schema";
import type { HostedPrincipal } from "./hosted-auth";
import {
  createPostgresOAuthMembershipAuthority,
  createPostgresWorkspaceMembership,
} from "./postgres-workspace-membership";

type Database = PostgresJsDatabase<typeof databaseSchema>;

const principal: HostedPrincipal = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://identity.example.test",
  ownerUserId: "user_1",
  scopes: ["autograph:session"],
  workspaceId: "workspace_1",
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
    from,
    innerJoin,
    limit,
    select,
    where,
  };
}

describe("PostgreSQL workspace membership", () => {
  it.each([
    [[], false],
    [[{ banned: false, role: "revoked" }], false],
    [[{ banned: true, role: "member" }], false],
    [[{ banned: false, role: "member" }], true],
    [[{ banned: false, role: "admin" }], true],
    [[{ banned: false, role: "owner" }], true],
    [
      [
        { banned: false, role: "member" },
        { banned: false, role: "member" },
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
        })
      ).resolves.toBe(expected);
      expect(fixture.limit).toHaveBeenCalledWith(2);
    }
  );

  it("rejects a non-claim workspace before querying storage", async () => {
    const fixture = databaseReturning([{ active: true }]);
    await expect(
      createPostgresWorkspaceMembership(fixture.database).isMember({
        principal,
        workspaceId: "workspace_other",
      })
    ).resolves.toBe(false);
    expect(fixture.select).not.toHaveBeenCalled();
  });

  it.each([
    [[], undefined],
    [
      [{ banned: false, role: "owner", workspaceId: "workspace_1" }],
      "workspace_1",
    ],
    [[{ banned: true, role: "member", workspaceId: "workspace_1" }], undefined],
    [
      [{ banned: false, role: "revoked", workspaceId: "workspace_1" }],
      undefined,
    ],
    [
      [
        { banned: false, role: "member", workspaceId: "workspace_1" },
        { banned: false, role: "member", workspaceId: "workspace_2" },
      ],
      undefined,
    ],
  ] as const)(
    "selects only one exact active OAuth workspace",
    async (rows, expected) => {
      const fixture = databaseReturning([...rows]);
      await expect(
        createPostgresOAuthMembershipAuthority(
          fixture.database
        ).activeWorkspaceForUser({
          audience: principal.audience,
          issuer: principal.issuer,
          ownerUserId: principal.ownerUserId,
        })
      ).resolves.toBe(expected);
      expect(fixture.limit).toHaveBeenCalledWith(2);
    }
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
      })
    ).rejects.toThrow("database unavailable");
  });
});
