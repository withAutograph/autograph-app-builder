import { readFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import type { SQLInputValue } from "node:sqlite";
import postgres from "postgres";
import type { Sql } from "postgres";
import { createInvitedUserProvisioner } from "./preview-activation-invited-user";

import { describe, expect, it, vi } from "vitest";

import {
  assertRuntimeRoleReadback,
  executePreviewActivation,
  planPreviewActivation,
  previewActivationApplyRequestSchema,
} from "./preview-activation";
import type { PreviewActivationStore } from "./preview-activation";

// Execute the provisioner's parameterized queries against an in-memory relational
// database. PostgreSQL row locks are removed because SQLite serializes this
// single-connection fixture; all writes still run inside the same transaction.
const activationDatabase = async () => {
  const db = new DatabaseSync(":memory:");
  db.exec(`
    PRAGMA foreign_keys = ON;
    CREATE TABLE "user" (id text PRIMARY KEY, name text NOT NULL, email text NOT NULL UNIQUE,
      email_verified boolean NOT NULL, created_at text NOT NULL, updated_at text NOT NULL);
    CREATE TABLE account (id text PRIMARY KEY, issuer text NOT NULL, account_id text NOT NULL,
      provider_id text NOT NULL, user_id text NOT NULL REFERENCES "user"(id), password text,
      created_at text NOT NULL, updated_at text NOT NULL, UNIQUE(issuer, account_id));
  `);
  db.exec(await readFile("drizzle/0002_hosted_workspace_membership.sql", "utf-8"));
  const client = postgres("postgres://fixture.invalid/unused");
  let transactionCount = 0;
  const sql = new Proxy(client, {
    get(_target, property) {
      if (property === "begin") {
        // oxlint-disable-next-line anti-slop/no-unknown-returns -- The transaction fixture preserves arbitrary callback results.
        return async (operation: (transaction: Sql) => Promise<unknown>) => {
          transactionCount += 1;
          db.exec("BEGIN");
          try {
            const result = await operation(sql);
            db.exec("COMMIT");
            return result;
          } catch (error) {
            db.exec("ROLLBACK");
            throw error;
          }
        };
      }
      throw new Error(`Unexpected SQL client property: ${String(property)}`);
    },
    apply(_target, _receiver, rawArguments: unknown[]) {
      const [segments, ...parameters] = rawArguments;
      if (!Array.isArray(segments) || !segments.every((part) => typeof part === "string")) {
        throw new Error("Expected a parameterized SQL query");
      }
      const statement = segments.join("?").replace(/\s+for update\s*$/iu, "");
      const bindings: SQLInputValue[] = parameters.map((value: unknown) => {
        if (value instanceof Date) {
          return value.toISOString();
        }
        if (
          typeof value === "string" ||
          typeof value === "number" ||
          typeof value === "bigint" ||
          value === null
        ) {
          return value;
        }
        throw new Error("Unexpected SQL parameter");
      });
      const query = db.prepare(statement);
      if (!statement.trimStart().toLowerCase().startsWith("select")) {
        query.run(...bindings);
        return Promise.resolve([]);
      }
      return Promise.resolve(
        query.all(...bindings).map((row) => ({
          ...row,
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...("email_verified" in row ? { email_verified: row.email_verified === 1 } : {}),
          // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
          ...("active" in row ? { active: row.active === 1 } : {}),
        })),
      );
    },
  });
  return { db, provision: createInvitedUserProvisioner(sql), transactions: () => transactionCount };
};

const now = Date.parse("2026-08-27T12:00:00.000Z");

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function store(): PreviewActivationStore {
  return {
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    configureRuntimeRole: vi.fn(async () => ({
      runtimeRoleAttributesExact: true,
      runtimeRoleCanConnect: true,
      runtimeRoleCanCreateSchemaObjects: false as const,
      runtimeRoleCanUseSchema: true,
      runtimeRoleCreated: true,
      runtimeRoleLogin: true,
      runtimeRoleMembershipCount: 0 as const,
      runtimeRoleSequencePrivilegesExact: true,
      runtimeRoleTablePrivilegesExact: true,
    })),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    initializeOAuth: vi.fn(async () => ({
      jwksRowsAfter: 1,
      jwksRowsBefore: 0,
      resourceRowsAfter: 1,
      resourceRowsBefore: 0,
    })),
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    provisionInvitedUser: vi.fn(async () => ({
      accountRowsAffected: 1,
      membershipRowsAffected: 1,
      userRowsAffected: 1,
    })),
  };
}

const invite = {
  action: "invited-user.provision" as const,
  email: "User@One.Example",
  githubAccountId: "128727",
  githubLogin: "jasonmorganson",
  issuer: "https://builder.example.test/api/auth",
  requestedAt: new Date(now).toISOString(),
  resource: "https://builder.example.test/mcp",
  userId: "user_one",
  version: 1 as const,
  workspaceId: "workspace_one",
};

describe("Preview activation prerequisite contract", () => {
  it("plans and executes invited GitHub users without disclosing identity", async () => {
    const plan = planPreviewActivation(invite);
    expect(JSON.stringify(plan)).not.toContain(invite.email);
    const receipt = await executePreviewActivation({
      now: () => now,
      request: {
        ...invite,
        confirmationDigest: plan.requiredConfirmationDigest,
      },
      store: store(),
    });
    expect(receipt.effects).toMatchObject({
      accountRowsAffected: 1,
      membershipRowsAffected: 1,
      userRowsAffected: 1,
    });
    const serialized = JSON.stringify(receipt);
    expect(serialized).not.toContain(invite.email);
    expect(serialized).not.toContain(invite.workspaceId);
  });

  it.each([
    {
      action: "runtime-role.configure",
      password: "runtime role password",
      requestedAt: new Date(now).toISOString(),
      roleName: "app_builder_runtime",
      version: 1,
    },
    {
      action: "oauth.initialize",
      authSecret: "a".repeat(32),
      issuer: "https://builder.example.test/api/auth",
      requestedAt: new Date(now).toISOString(),
      resource: "https://builder.example.test/mcp",
      version: 1,
    },
  ])("supports a closed confirmation-bound $action receipt", async (request) => {
    const plan = planPreviewActivation(request);
    const receipt = await executePreviewActivation({
      now: () => now,
      request: {
        ...request,
        confirmationDigest: plan.requiredConfirmationDigest,
      },
      store: store(),
    });
    expect(receipt.action).toBe(request.action);
    expect(receipt.status).toBe("applied");
  });

  it("rejects stale, mismatched, unknown, and cross-origin inputs", async () => {
    const plan = planPreviewActivation(invite);
    await expect(
      executePreviewActivation({
        now: () => now,
        request: { ...invite, confirmationDigest: `sha256:${"0".repeat(64)}` },
        store: store(),
      }),
    ).rejects.toThrow("confirmation");
    await expect(
      executePreviewActivation({
        now: () => now + 16 * 60_000,
        request: {
          ...invite,
          confirmationDigest: plan.requiredConfirmationDigest,
        },
        store: store(),
      }),
    ).rejects.toThrow("stale");
    expect(() =>
      planPreviewActivation({
        ...invite,
        resource: "https://other.example.test/mcp",
      }),
    ).toThrow("same-origin");
    expect(() =>
      previewActivationApplyRequestSchema.parse({
        ...invite,
        confirmationDigest: plan.requiredConfirmationDigest,
        publicSignup: true,
      }),
    ).toThrow();
  });

  it("rejects every extra runtime role authority and role membership", () => {
    const exact = {
      bypassRls: false,
      canConnect: true,
      canCreateSchemaObjects: false,
      canLogin: true,
      canUseSchema: true,
      createDatabase: false,
      createRole: false,
      inherits: false,
      membershipCount: 0,
      replication: false,
      sequencePrivilegesExact: true,
      superuser: false,
      tablePrivilegesExact: true,
    } as const;
    expect(assertRuntimeRoleReadback(exact)).toEqual(exact);
    for (const drift of [
      { inherits: true },
      { superuser: true },
      { createDatabase: true },
      { createRole: true },
      { replication: true },
      { bypassRls: true },
      { membershipCount: 1 },
      { canCreateSchemaObjects: true },
      { tablePrivilegesExact: false },
      { sequencePrivilegesExact: false },
    ]) {
      expect(() => assertRuntimeRoleReadback({ ...exact, ...drift })).toThrow();
    }
  });

  it("has PostgreSQL quote the validated role credential without exposing failed SQL", async () => {
    const cli = await readFile("lib/db/preview-activation-cli.mts", "utf-8");
    expect(cli).toContain(
      `select format(\${template}::text, \${roleName}::text, \${password}::text)`,
    );
    expect(cli).toContain("await sql.unsafe(statement)");
    expect(cli).toContain("Runtime database role configuration failed.");
    expect(cli).not.toContain("sql.unsafe(input.password)");
  });

  it("provisions and reuses the tenant-bound GitHub membership atomically", async () => {
    const fixture = await activationDatabase();
    const input = { ...invite, email: "user@one.example" };
    try {
      await expect(fixture.provision(input)).resolves.toEqual({
        accountRowsAffected: 1,
        membershipRowsAffected: 1,
        userRowsAffected: 1,
      });
      expect(fixture.transactions()).toBe(1);
      expect(
        fixture.db.prepare('select id, email, name, email_verified from "user"').get(),
      ).toMatchObject({
        id: input.userId,
        email: input.email,
        name: input.githubLogin,
        email_verified: 1,
      });
      expect(
        fixture.db
          .prepare("select issuer, account_id, provider_id, user_id, password from account")
          .get(),
      ).toMatchObject({
        issuer: "local:oauth:github",
        account_id: input.githubAccountId,
        provider_id: "github",
        user_id: input.userId,
        password: null,
      });
      expect(
        fixture.db
          .prepare(
            "select issuer, audience, workspace_id, owner_user_id, active, updated_at from hosted_workspace_membership",
          )
          .get(),
      ).toMatchObject({
        issuer: input.issuer,
        audience: input.resource,
        workspace_id: input.workspaceId,
        owner_user_id: input.userId,
        active: 1,
        updated_at: input.requestedAt,
      });
      await expect(fixture.provision(input)).resolves.toEqual({
        accountRowsAffected: 0,
        membershipRowsAffected: 0,
        userRowsAffected: 0,
      });
      expect(fixture.transactions()).toBe(2);
    } finally {
      fixture.db.close();
    }
  });

  it("rolls back identity writes when the existing tenant membership is inactive", async () => {
    const fixture = await activationDatabase();
    const input = { ...invite, email: "user@one.example" };
    try {
      fixture.db
        .prepare(
          "insert into hosted_workspace_membership (issuer, audience, workspace_id, owner_user_id, active, updated_at) values (?, ?, ?, ?, false, ?)",
        )
        .run(input.issuer, input.resource, input.workspaceId, input.userId, input.requestedAt);
      await expect(fixture.provision(input)).rejects.toThrow(
        "Invited user membership conflicts with an existing row.",
      );
      expect(fixture.transactions()).toBe(1);
      expect(fixture.db.prepare('select count(*) as count from "user"').get()).toMatchObject({
        count: 0,
      });
      expect(fixture.db.prepare("select count(*) as count from account").get()).toMatchObject({
        count: 0,
      });
      expect(
        fixture.db.prepare("select active from hosted_workspace_membership").get(),
      ).toMatchObject({ active: 0 });
    } finally {
      fixture.db.close();
    }
  });
});
