import { readFile } from "node:fs/promises";

import { expect, it } from "vitest";

import { assertPrototypeChunkKey } from "./postgres-prototype-chunks";

const principal = {
  audience: "app-builder",
  issuer: "https://issuer.example",
  ownerUserId: "user-1",
  scopes: ["autograph:get"],
  workspaceId: "workspace-1",
};

it("declares immutable chunks under the complete tenant and transfer key", async () => {
  const migration = await readFile(
    new URL("../../drizzle/0023_prototype_chunks.sql", import.meta.url),
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
