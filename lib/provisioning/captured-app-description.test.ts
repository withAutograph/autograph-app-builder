/* oxlint-disable eslint/require-await, sonarjs/no-nested-functions -- The in-memory transport mirrors Drizzle's fluent asynchronous query API. */
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createCapturedAppDescriptionStore } from "./captured-app-description";
import type { prototypeArtifactChunks } from "../db/schema";
import type { AppDescription } from "../repository/app-description";

type Row = typeof prototypeArtifactChunks.$inferInsert;
type Database = Parameters<typeof createCapturedAppDescriptionStore>[0]["database"];
const context = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: { appId: "example", sessionId: "session" },
};
const description: AppDescription = {
  app: { id: "example", routes: ["/example"], workspacePath: "apps/example" },
  backend: { kind: "static" },
  validation: { browser: null, check: { task: "check" }, test: null },
  version: 1,
};
const columns = [
  "issuer",
  "audience",
  "workspaceId",
  "ownerUserId",
  "sessionId",
  "path",
  "chunkIndex",
  "transferDigest",
] as const;
const setup = () => {
  const rows: Row[] = [];
  let revoked = false;
  const database = {
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoNothing: async () => {
          // oxlint-disable-next-line sonarjs/no-nested-functions -- The terminal transport compares the full immutable key.
          if (!rows.some((current) => columns.every((key) => current[key] === row[key]))) {
            rows.push(row);
          }
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (sql: SQL) => {
          const { params } = new PgDialect().sqlToQuery(sql);
          // oxlint-disable-next-line sonarjs/no-nested-functions -- The terminal transport evaluates all actual SQL equality parameters.
          const selected = rows.filter((row) =>
            columns.slice(0, params.length).every((key, index) => row[key] === params[index]),
          );
          return {
            limit: async (count: number) => selected.slice(0, count),
            orderBy: () => ({
              limit: async (count: number) => selected.toReversed().slice(0, count),
            }),
          };
        },
      }),
    }),
  };
  // SAFETY: The fixture implements every INSERT/SELECT chain used by this bounded immutable descriptor store.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Deliberate in-memory Drizzle transport fixture.
  const db = database as unknown as Database;
  const store = createCapturedAppDescriptionStore({
    assertCurrentOwner: async () => {
      if (revoked) {
        throw new Error("owner revoked");
      }
    },
    database: db,
  });
  return {
    revoke: () => {
      revoked = true;
    },
    rows,
    store,
  };
};

describe("captured frontend app descriptions", () => {
  it("retains the repository description without a generated database release", async () => {
    const { store } = setup();
    await store.record(context, "a".repeat(64), "call", description);
    expect(await store.read(context, "a".repeat(64))).toEqual(description);
    await expect(
      store.record(context, "a".repeat(64), "call", {
        ...description,
        app: { ...description.app, routes: ["/changed"] },
      }),
    ).rejects.toThrow();
    expect(await store.read(context, "b".repeat(64))).toBeUndefined();
  });
  it.each(["ownerUserId", "workspaceId"] as const)(
    "isolates a description by %s and saved session",
    async (field) => {
      const { store } = setup();
      await store.record(context, "a".repeat(64), "call", description);
      expect(
        await store.read(
          { ...context, authority: { ...context.authority, [field]: "other" } },
          "a".repeat(64),
        ),
      ).toBeUndefined();
      expect(
        await store.read(
          { ...context, target: { ...context.target, sessionId: "other" } },
          "a".repeat(64),
        ),
      ).toBeUndefined();
    },
  );
  it("rejects app substitution, corruption and lost ownership", async () => {
    const { store, rows, revoke } = setup();
    await expect(
      store.record(context, "a".repeat(64), "call", {
        ...description,
        app: { ...description.app, id: "other" },
      }),
    ).rejects.toThrow();
    await store.record(context, "a".repeat(64), "call", description);
    const row = rows.at(0);
    if (row === undefined) {
      throw new Error("Expected captured description");
    }
    row.content = JSON.stringify({ ...description, app: { ...description.app, id: "other" } });
    await expect(store.read(context, "a".repeat(64))).rejects.toThrow();
    revoke();
    await expect(store.read(context, "a".repeat(64))).rejects.toThrow("owner revoked");
  });
});
