import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle's database type requires the complete schema namespace.
import type * as databaseSchema from "../db/schema";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { getPrototypeChunk, putPrototypeChunk } from "./postgres-prototype-chunks";
import type { DurablePrototypeChunkStore } from "./prototype-artifacts-v2";

type Database = PostgresJsDatabase<typeof databaseSchema>;

/** Bind every durable writer operation to the exact forwarded Eve tenant and session. */
export const createHostedPrototypeChunkStore = (input: {
  db: Database;
  sessionAuth: unknown;
  sessionId: string;
}): DurablePrototypeChunkStore => {
  const { principal } = exactForwardedSessionAuthority(input.sessionAuth);
  if (input.sessionId.length === 0) {
    throw new Error("The hosted prototype session is unavailable.");
  }
  return {
    async get({ path, transferDigest, chunkIndex }) {
      return await getPrototypeChunk(input.db, {
        chunkIndex,
        path,
        principal,
        sessionId: input.sessionId,
        transferDigest,
      });
    },
    async put({ path, transferDigest, chunkIndex, content }) {
      return await putPrototypeChunk(
        input.db,
        {
          chunkIndex,
          path,
          principal,
          sessionId: input.sessionId,
          transferDigest,
        },
        content,
      );
    },
  };
};
