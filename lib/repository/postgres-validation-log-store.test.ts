import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { describe, expect, it } from "vitest";

import type { HostedPrincipal } from "../eve/hosted-auth";
import { postgresValidationLogStore } from "./postgres-validation-log-store";
import type { ValidationLogKey, ValidationLogReference } from "./validation-log";

const authority: HostedPrincipal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "user_one",
  scopes: ["autograph:get"],
  workspaceId: "workspace_one",
};
const key: ValidationLogKey = {
  attemptDigest: "a".repeat(64),
  channel: "stdout",
  command: "check-build",
  logId: "ed5bc83d-a08f-42be-9635-4677fa7bdb32",
  sessionId: "session_one",
};
type InsertedValues = Record<string, string | number | Date | null>;

// oxlint-disable-next-line eslint/func-style -- Test fixture initialization uses function hoisting.
function databaseFixture(rows: unknown[] = []) {
  const whereConditions: SQL[] = [];
  const insertedValues: InsertedValues[] = [];
  interface FixtureQuery {
    from: () => FixtureQuery;
    insert: () => FixtureQuery;
    select: () => FixtureQuery;
    values: (value: InsertedValues) => Promise<void>;
    where: (condition: SQL) => Promise<unknown[]>;
  }
  class FixtureQueryMock implements FixtureQuery {
    private readonly fixtureRows: unknown[];
    private readonly capturedConditions: SQL[];
    private readonly savedValues: InsertedValues[];

    constructor(sourceRows: unknown[], conditions: SQL[], values: InsertedValues[]) {
      this.fixtureRows = sourceRows;
      this.capturedConditions = conditions;
      this.savedValues = values;
    }

    from() {
      return this;
    }

    insert() {
      return this;
    }

    select() {
      return this;
    }

    // oxlint-disable-next-line eslint/require-await -- Preserve the Promise-returning Drizzle chain.
    async values(value: InsertedValues) {
      this.savedValues.push(value);
    }

    // oxlint-disable-next-line eslint/require-await -- Preserve the Promise-returning Drizzle chain.
    async where(condition: SQL) {
      this.capturedConditions.push(condition);
      return this.fixtureRows;
    }
  }
  const query = new FixtureQueryMock(rows, whereConditions, insertedValues);
  // SAFETY: the fixture implements only the fluent Drizzle methods used by this store.
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion
  const database = query as unknown as Parameters<typeof postgresValidationLogStore>[0];
  return { database, insertedValues, whereConditions };
}

describe("PostgreSQL validation log store", () => {
  it("preserves legacy references and returns persisted completion metadata", async () => {
    const legacyRow = {
      byteLength: 12,
      chunkCount: 1,
      completion: null,
      digest: "b".repeat(64),
    };
    const { database } = databaseFixture([legacyRow]);
    const store = postgresValidationLogStore(database, authority, key.sessionId);

    const savedLegacy = await store.getReference(key);
    expect(savedLegacy).not.toHaveProperty("completion");
    expect(savedLegacy).toMatchObject({
      bytes: 12,
      digest: legacyRow.digest,
    });

    const { database: interruptedDb } = databaseFixture([
      { ...legacyRow, completion: "interrupted" },
    ]);
    const interrupted = postgresValidationLogStore(interruptedDb, authority, key.sessionId);
    await expect(interrupted.getReference(key)).resolves.toMatchObject({
      completion: "interrupted",
    });
  });

  it("writes completion while preserving all tenant and attempt predicates on reads", async () => {
    const { database, insertedValues, whereConditions } = databaseFixture([]);
    const store = postgresValidationLogStore(database, authority, key.sessionId);
    const reference = {
      bytes: 0,
      channel: "stdout",
      chunkCount: 0,
      completion: "unavailable",
      digest: "b".repeat(64),
      logId: key.logId,
    } satisfies ValidationLogReference & { completion: "unavailable" };

    await store.publish(key, reference);
    expect(insertedValues).toContainEqual(
      expect.objectContaining({ byteLength: 0, completion: "unavailable" }),
    );
    await store.getReference(key);
    const [where] = whereConditions;
    const { params } = new PgDialect().sqlToQuery(where);
    expect(params).toEqual(
      expect.arrayContaining([
        authority.audience,
        authority.issuer,
        authority.workspaceId,
        authority.ownerUserId,
        key.sessionId,
        key.attemptDigest,
        key.command,
        key.channel,
      ]),
    );
  });

  it("does not expose a manifest from another tenant or session", async () => {
    const { database, whereConditions } = databaseFixture([]);
    const otherTenant: HostedPrincipal = {
      ...authority,
      ownerUserId: "user_two",
      workspaceId: "workspace_two",
    };
    const otherSessionStore = postgresValidationLogStore(database, otherTenant, key.sessionId);

    await expect(otherSessionStore.getReference(key)).resolves.toBeUndefined();
    const [where] = whereConditions;
    const { params } = new PgDialect().sqlToQuery(where);
    expect(params).toContain("user_two");
    expect(params).toContain("workspace_two");
    expect(params).not.toContain(authority.ownerUserId);
    expect(params).not.toContain(authority.workspaceId);

    await expect(
      postgresValidationLogStore(database, otherTenant, "session_two").getReference(key),
    ).rejects.toThrow("The validation log key is invalid for this session.");
  });
});
