import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  createPostgresOperatorArtifactStore,
  operatorArtifactReferenceSchema,
} from "./hosted-operator-artifact-store";
import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import type { prototypeArtifactChunks } from "../db/schema";
import { getPrototypeChunk } from "../agent/postgres-prototype-chunks";

type Database = Parameters<typeof createPostgresOperatorArtifactStore>[0]["database"];
type Row = typeof prototypeArtifactChunks.$inferInsert;
const context = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: { appId: "spend-review", sessionId: "original-session" },
};
const reference = `_protected-operator/artifacts/realm-identity-stage/spend-review/${"a".repeat(64)}`;
const columns = [
  "issuer",
  "audience",
  "workspaceId",
  "ownerUserId",
  "sessionId",
  "path",
  "transferDigest",
  "chunkIndex",
] as const;
const fixture = () => {
  const rows: Row[] = [];
  let revoked = false;
  const database = {
    insert: () => ({
      values: (row: Row) => ({
        // oxlint-disable-next-line eslint/require-await -- Terminal transport follows the asynchronous Drizzle contract.
        onConflictDoNothing: async () => {
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Compare the complete immutable row key at the terminal transport boundary.
          if (!rows.some((current) => columns.every((column) => current[column] === row[column]))) {
            rows.push(row);
          }
        },
      }),
    }),
    select: () => ({
      from: () => ({
        // oxlint-disable-next-line eslint/require-await -- Terminal transport follows the asynchronous Drizzle contract.
        where: async (condition: SQL) => {
          const query = new PgDialect().sqlToQuery(condition);
          // oxlint-disable-next-line sonarjs/no-nested-functions -- Terminal SQL transport evaluates all tenant/session predicates.
          return rows.filter((row) =>
            columns.every((column, index) => row[column] === query.params[index]),
          );
        },
      }),
    }),
  };
  // SAFETY: This fixture implements only the INSERT and SELECT chains exercised by the immutable artifact transport.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/no-chained-type-assertions -- Deliberate partial database transport fixture.
  const db = database as unknown as Database;
  const store = createPostgresOperatorArtifactStore({
    database: db,
    assertCurrentOwner: async () => {
      if (revoked) {
        throw new Error("owner revoked");
      }
      await Promise.resolve();
    },
  });
  return {
    db,
    rows,
    store,
    revoke: () => {
      revoked = true;
    },
  };
};

describe("private identity stage artifacts", () => {
  it("stores immutable encrypted stage bytes and rejects corruption or revoked ownership", async () => {
    const f = fixture();
    expect(operatorArtifactReferenceSchema.parse(reference)).toBe(reference);
    await f.store.put(context, { artifactRef: reference, chunkIndex: 0, content: "sealed-stage" });
    expect(await f.store.read(context, reference, 0)).toBe("sealed-stage");
    await expect(
      f.store.put(context, { artifactRef: reference, chunkIndex: 0, content: "replacement" }),
    ).rejects.toThrow();
    expect(await f.store.read(context, reference, 0)).toBe("sealed-stage");
    const row = f.rows.at(0);
    if (row === undefined) {
      throw new Error("Expected a stored private stage.");
    }
    row.content = "corrupt";
    await expect(f.store.read(context, reference, 0)).rejects.toThrow();
    f.revoke();
    await expect(f.store.read(context, reference, 0)).rejects.toThrow();
  });
  it.each(["issuer", "audience", "workspaceId", "ownerUserId"] as const)(
    "isolates the actual stored stage by %s",
    async (field) => {
      const f = fixture();
      await f.store.put(context, {
        artifactRef: reference,
        chunkIndex: 0,
        content: "sealed-stage",
      });
      const foreign: OperatorArtifactContext = {
        ...context,
        authority:
          field === "issuer" || field === "audience"
            ? {
                ...context.authority,
                issuer: "https://foreign.example/api/auth",
                audience: "https://foreign.example/mcp",
              }
            : { ...context.authority, [field]: `${context.authority[field]}/foreign` },
      };
      expect(await f.store.read(foreign, reference, 0)).toBeUndefined();
      expect(
        await f.store.read(
          { ...context, target: { ...context.target, sessionId: "other-session" } },
          reference,
          0,
        ),
      ).toBeUndefined();
      await expect(
        f.store.read(
          { ...context, target: { ...context.target, appId: "other-app" } },
          reference,
          0,
        ),
      ).rejects.toThrow();
    },
  );
  it("keeps the new namespace inaccessible through the public prototype reader", async () => {
    const f = fixture();
    await f.store.put(context, { artifactRef: reference, chunkIndex: 0, content: "sealed-stage" });
    await expect(
      getPrototypeChunk(f.db, {
        principal: { ...context.authority, scopes: ["autograph:get"] },
        sessionId: context.target.sessionId,
        path: reference,
        transferDigest: "a".repeat(64),
        chunkIndex: 0,
      }),
    ).rejects.toThrow("Prototype artifact path is not allowed.");
  });
});
