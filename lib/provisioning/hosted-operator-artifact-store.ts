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
export interface OperatorArtifactContext {
  authority: HostedOperatorContext["authority"];
  target: Pick<HostedOperatorContext["target"], "appId" | "sessionId">;
}

export const operatorArtifactUnavailable = () =>
  new Error("Protected operator artifact is unavailable.");
export const operatorArtifactReferenceSchema = z
  .string()
  .regex(
    /^_protected-operator\/artifacts\/(?:generated-release|auth-plan)\/[a-z][a-z0-9]*(?:-[a-z0-9]+)*\/[a-f0-9]{64}$/u,
  );
export interface OperatorArtifactChunk {
  artifactRef: string;
  chunkIndex: number;
  content: string;
}
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
  if (
    path.split("/")[3] !== context.target.appId ||
    !Number.isSafeInteger(chunkIndex) ||
    chunkIndex < 0 ||
    !context.target.sessionId
  ) {
    throw operatorArtifactUnavailable();
  }
  return {
    ...authority,
    chunkIndex,
    path,
    sessionId: context.target.sessionId,
    transferDigest: path.split("/")[4],
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
export const createPostgresOperatorArtifactStore = (input: {
  database: PostgresJsDatabase<typeof databaseSchema>;
  assertCurrentOwner: (context: OperatorArtifactContext) => Promise<void>;
}): OperatorArtifactStore => ({
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
