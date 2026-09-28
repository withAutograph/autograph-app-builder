import { createHash } from "node:crypto";

import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle's database type requires the complete schema namespace.
import type * as databaseSchema from "../db/schema";
import { prototypeArtifactChunks } from "../db/schema";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { parsePrototypeArtifactPath } from "./prototype-artifacts";

type Database = PostgresJsDatabase<typeof databaseSchema>;
const sha256 = (content: string): string =>
  createHash("sha256").update(content, "utf-8").digest("hex");

export interface PrototypeChunkKey {
  principal: HostedPrincipal;
  sessionId: string;
  path: string;
  transferDigest: string;
  chunkIndex: number;
}

const chunkPredicate = (key: PrototypeChunkKey) =>
  and(
    eq(prototypeArtifactChunks.issuer, key.principal.issuer),
    eq(prototypeArtifactChunks.audience, key.principal.audience),
    eq(prototypeArtifactChunks.workspaceId, key.principal.workspaceId),
    eq(prototypeArtifactChunks.ownerUserId, key.principal.ownerUserId),
    eq(prototypeArtifactChunks.sessionId, key.sessionId),
    eq(prototypeArtifactChunks.path, key.path),
    eq(prototypeArtifactChunks.transferDigest, key.transferDigest),
    eq(prototypeArtifactChunks.chunkIndex, key.chunkIndex),
  );

export const assertPrototypeChunkKey = (key: PrototypeChunkKey): void => {
  parsePrototypeArtifactPath(key.path);
  if (
    !/^[a-f0-9]{64}$/u.test(key.transferDigest) ||
    !Number.isSafeInteger(key.chunkIndex) ||
    key.chunkIndex < 0 ||
    key.sessionId.length === 0
  ) {
    throw new Error("Prototype chunk key is invalid.");
  }
};

/** Write-once and tenant-scoped. A conflicting retry must match exact bytes. */
export const putPrototypeChunk = async (
  db: Database,
  key: PrototypeChunkKey,
  content: string,
): Promise<string> => {
  assertPrototypeChunkKey(key);
  if (content.length === 0) {
    throw new Error("Prototype chunk content must not be empty.");
  }
  const chunkDigest = sha256(content);
  await db
    .insert(prototypeArtifactChunks)
    .values({
      audience: key.principal.audience,
      chunkDigest,
      chunkIndex: key.chunkIndex,
      content,
      createdAt: new Date(),
      issuer: key.principal.issuer,
      ownerUserId: key.principal.ownerUserId,
      path: key.path,
      sessionId: key.sessionId,
      transferDigest: key.transferDigest,
      workspaceId: key.principal.workspaceId,
    })
    .onConflictDoNothing();
  const rows = await db
    .select({
      chunkDigest: prototypeArtifactChunks.chunkDigest,
      content: prototypeArtifactChunks.content,
    })
    .from(prototypeArtifactChunks)
    .where(chunkPredicate(key));
  const [row] = rows;
  if (row?.chunkDigest !== chunkDigest || row.content !== content) {
    throw new Error("Prototype chunk key already contains different content.");
  }
  return chunkDigest;
};

/** Read one verified chunk without exposing another tenant's material. */
export const getPrototypeChunk = async (
  db: Database,
  key: PrototypeChunkKey,
): Promise<string | undefined> => {
  assertPrototypeChunkKey(key);
  const rows = await db
    .select({
      chunkDigest: prototypeArtifactChunks.chunkDigest,
      content: prototypeArtifactChunks.content,
    })
    .from(prototypeArtifactChunks)
    .where(chunkPredicate(key));
  const [row] = rows;
  if (row === undefined) {
    return undefined;
  }
  if (sha256(row.content) !== row.chunkDigest) {
    throw new Error("Stored prototype chunk digest does not match its content.");
  }
  return row.content;
};
