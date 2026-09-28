import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { expect, it } from "vitest";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the complete schema namespace.
import * as schema from "../db/schema";
import { prototypeArtifactChunks } from "../db/schema";
import { getPrototypeChunk, putPrototypeChunk } from "./postgres-prototype-chunks";

const databaseUrl = process.env.PROTOTYPE_TEST_DATABASE_URL;

it.skipIf(databaseUrl === undefined)(
  "writes migrated hosted chunks and keeps another tenant from reading them",
  async () => {
    const client = postgres(databaseUrl ?? "", { max: 1 });
    const db = drizzle(client, { schema });
    const sessionId = `prototype-test-${randomUUID()}`;
    const principal = {
      audience: "app-builder",
      issuer: "https://issuer.example",
      ownerUserId: "prototype-test-owner",
      scopes: ["autograph:get"],
      workspaceId: "prototype-test-workspace",
    };
    const key = {
      chunkIndex: 0,
      path: "prototype/demo/index.html",
      principal,
      sessionId,
      transferDigest: "a".repeat(64),
    };
    try {
      const writtenDigest = await putPrototypeChunk(db, key, "<main>Durable 🥑</main>");
      expect(writtenDigest).toMatch(/^[a-f0-9]{64}$/u);
      await expect(getPrototypeChunk(db, key)).resolves.toBe("<main>Durable 🥑</main>");
      await expect(
        getPrototypeChunk(db, {
          ...key,
          principal: { ...principal, ownerUserId: "another-owner" },
        }),
      ).resolves.toBeUndefined();
      await expect(
        getPrototypeChunk(db, { ...key, sessionId: `${sessionId}-other` }),
      ).resolves.toBeUndefined();
      await expect(putPrototypeChunk(db, key, "different bytes")).rejects.toThrow(
        "different content",
      );
    } finally {
      await db
        .delete(prototypeArtifactChunks)
        .where(eq(prototypeArtifactChunks.sessionId, sessionId));
      await client.end();
    }
  },
);
