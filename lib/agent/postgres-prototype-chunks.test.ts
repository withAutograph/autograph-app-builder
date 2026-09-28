import { readFile } from "node:fs/promises";

import { expect, it, vi } from "vitest";

import {
  assertPrototypeChunkKey,
  assertPrototypeChunkSchemaReady,
  streamStoredPrototypeArtifact,
} from "./postgres-prototype-chunks";

it("explains an unapplied prototype storage migration without hiding other database failures", async () => {
  const missingRelation = Object.assign(new Error("relation missing"), { code: "42P01" });
  const missing = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(missingRelation) }),
    }),
  };
  // SAFETY: The function only calls the three mocked methods in this minimal Drizzle chain.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal Drizzle chain fixture.
  await expect(assertPrototypeChunkSchemaReady(missing as never)).rejects.toThrow(
    "Apply the additive prototype_artifact_chunks database migration",
  );
  const outage = new Error("database unavailable");
  const failed = {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue({ limit: vi.fn().mockRejectedValue(outage) }),
    }),
  };
  // SAFETY: The function only calls the three mocked methods in this minimal Drizzle chain.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Minimal Drizzle chain fixture.
  await expect(assertPrototypeChunkSchemaReady(failed as never)).rejects.toBe(outage);
});

const principal = {
  audience: "app-builder",
  issuer: "https://issuer.example",
  ownerUserId: "user-1",
  scopes: ["autograph:get"],
  workspaceId: "workspace-1",
};

it("declares immutable chunks under the complete tenant and transfer key", async () => {
  const migration = await readFile(
    new URL("../../drizzle/0024_prototype_chunks.sql", import.meta.url),
    "utf-8",
  );
  for (const column of [
    "issuer",
    "audience",
    "workspace_id",
    "owner_user_id",
    "session_id",
    "path",
    "transfer_digest",
    "chunk_index",
  ]) {
    expect(migration).toContain(`"${column}"`);
  }
  expect(migration).toContain("PRIMARY KEY");
  expect(migration).not.toMatch(/\b(?:UPDATE|DELETE|TRUNCATE|DROP)\b/iu);
});

it("rejects invalid transfer keys before any database write or read", () => {
  const key = {
    chunkIndex: 0,
    path: "prototype/demo/index.html",
    principal,
    sessionId: "session-1",
    transferDigest: "wrong",
  };
  expect(() => {
    assertPrototypeChunkKey(key);
  }).toThrow("key is invalid");
});

it("rejects a cross-session artifact before opening a chunk stream", () => {
  expect(() =>
    streamStoredPrototypeArtifact({
      artifact: {
        appId: "demo",
        chunkCount: 1,
        contentBytes: 1,
        digest: "a".repeat(64),
        mediaType: "text/html",
        path: "prototype/demo/index.html",
        recordedByCallId: "call-1",
        revision: "b".repeat(64),
        sessionId: "other-session",
        version: 2,
      },
      // SAFETY: The session mismatch throws before any database method is called.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- This test exercises pre-read validation.
      db: {} as never,
      principal,
      sessionId: "session-1",
    }),
  ).toThrow("different session");
});
