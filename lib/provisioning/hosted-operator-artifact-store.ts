import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the owned complete schema namespace.
import type * as databaseSchema from "../db/schema";
import { prototypeArtifactChunks } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type { HostedOperatorContext } from "./hosted-operator-service";

/** Build artifact authority needs no provider project or deployment grant. */
export interface LocalOperatorArtifactAuthority {
  kind: "local";
  ownerUid: number;
  stateRoot: string;
}
export interface OperatorArtifactContext {
  authority: HostedOperatorContext["authority"] | LocalOperatorArtifactAuthority;
  target: Pick<HostedOperatorContext["target"], "appId" | "sessionId">;
}

export const operatorArtifactUnavailable = () =>
  new Error("Protected operator artifact is unavailable.");
const uuidPart = "[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}";
const exportReference = new RegExp(
  `^_protected-operator/artifacts/tenant-export/${uuidPart}/${uuidPart}/(?:data|manifest|completion)/[a-f0-9]{64}$`,
  "u",
);
export const operatorArtifactReferenceSchema = z
  .string()
  .refine(
    (value) =>
      /^_protected-operator\/artifacts\/(?:generated-release|auth-plan|realm-identity-proof|realm-identity-stage)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-f0-9]{64}$/u.test(
        value,
      ) || exportReference.test(value),
  );
export interface OperatorArtifactChunk {
  artifactRef: string;
  chunkIndex: number;
  content: string;
}
/** Both methods verify current ownership around I/O. put additionally verifies immutable acknowledgement by exact readback. */
export interface OperatorArtifactStore {
  put: (context: OperatorArtifactContext, chunk: OperatorArtifactChunk) => Promise<void>;
  read: (
    context: OperatorArtifactContext,
    artifactRef: string,
    chunkIndex: number,
  ) => Promise<string | undefined>;
}
const hash = (content: string) => createHash("sha256").update(content).digest("hex");
const key = (context: OperatorArtifactContext, artifactRef: string, chunkIndex: number) => {
  const path = operatorArtifactReferenceSchema.parse(artifactRef);
  const authority = hostedTenantAuthoritySchema.parse(context.authority);
  const isExport = exportReference.test(path);
  const wrongApp =
    (!isExport && path.split("/")[3] !== context.target.appId) || !context.target.appId;
  const invalidIndex = !Number.isSafeInteger(chunkIndex) || chunkIndex < 0;
  if (wrongApp || invalidIndex || !context.target.sessionId) {
    throw operatorArtifactUnavailable();
  }
  return {
    ...authority,
    chunkIndex,
    path,
    sessionId: context.target.sessionId,
    // Export paths identify an export/attempt rather than an app. Keep app
    // isolation in the existing key without changing any historical key.
    transferDigest: isExport
      ? hash(`${context.target.appId}\n${path.split("/").at(-1)}`)
      : path.split("/")[4],
  };
};
const predicate = (value: ReturnType<typeof key>) =>
  and(
    eq(prototypeArtifactChunks.issuer, value.issuer),
    eq(prototypeArtifactChunks.audience, value.audience),
    eq(prototypeArtifactChunks.workspaceId, value.workspaceId),
    eq(prototypeArtifactChunks.ownerUserId, value.ownerUserId),
    eq(prototypeArtifactChunks.sessionId, value.sessionId),
    eq(prototypeArtifactChunks.path, value.path),
    eq(prototypeArtifactChunks.transferDigest, value.transferDigest),
    eq(prototypeArtifactChunks.chunkIndex, value.chunkIndex),
  );

/** Private namespace in the existing immutable owner/session chunk storage. Public prototype readers reject this namespace before querying. */
interface ArtifactDatabaseInput {
  database: PostgresJsDatabase<typeof databaseSchema>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}

/** A SELECT-only capability for authenticated downloads; no write method. */
export const createPostgresOperatorArtifactReader = (
  input: ArtifactDatabaseInput,
): Pick<OperatorArtifactStore, "read"> => ({
  async read(context, artifactRef, chunkIndex): Promise<string | undefined> {
    try {
      const owned = key(context, artifactRef, chunkIndex);
      await input.assertCurrentOwner(context);
      const rows = await input.database
        .select({
          chunkDigest: prototypeArtifactChunks.chunkDigest,
          content: prototypeArtifactChunks.content,
        })
        .from(prototypeArtifactChunks)
        .where(predicate(owned));
      const row = rows.at(0);
      await input.assertCurrentOwner(context);
      if (row === undefined) {
        return undefined;
      }
      if (hash(row.content) !== row.chunkDigest) {
        throw operatorArtifactUnavailable();
      }
      return row.content;
    } catch {
      throw operatorArtifactUnavailable();
    }
  },
});

export const createPostgresOperatorArtifactStore = (
  input: ArtifactDatabaseInput,
): OperatorArtifactStore => ({
  ...createPostgresOperatorArtifactReader(input),
  async put(context, chunk) {
    try {
      const owned = key(context, chunk.artifactRef, chunk.chunkIndex);
      if (!chunk.content) {
        throw operatorArtifactUnavailable();
      }
      await input.assertCurrentOwner(context);
      const chunkDigest = hash(chunk.content);
      await input.database
        .insert(prototypeArtifactChunks)
        .values({ ...owned, chunkDigest, content: chunk.content, createdAt: new Date() })
        .onConflictDoNothing();
      await input.assertCurrentOwner(context);
      const rows = await input.database
        .select({
          chunkDigest: prototypeArtifactChunks.chunkDigest,
          content: prototypeArtifactChunks.content,
        })
        .from(prototypeArtifactChunks)
        .where(predicate(owned));
      const row = rows.at(0);
      await input.assertCurrentOwner(context);
      if (row?.chunkDigest !== chunkDigest || row.content !== chunk.content) {
        throw operatorArtifactUnavailable();
      }
    } catch {
      throw operatorArtifactUnavailable();
    }
  },
});
