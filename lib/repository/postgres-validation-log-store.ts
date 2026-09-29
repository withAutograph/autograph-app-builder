import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle database type uses the full schema.
import type * as schema from "../db/schema";
import { validationLogChunks, validationLogManifests } from "../db/schema";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import type {
  ValidationLogKey,
  ValidationLogReference,
  ValidationLogStore,
} from "./validation-log";

type Database = PostgresJsDatabase<typeof schema>;
type Completion = "complete" | "interrupted" | "unavailable";
type ValidationLogReferenceWithCompletion = ValidationLogReference & {
  completion?: Completion;
};

const readCompletion = (value: string | null): Completion => {
  if (value === null) {
    return "complete";
  }
  if (value === "complete" || value === "interrupted" || value === "unavailable") {
    return value;
  }
  throw new Error("The validation log completion state is invalid.");
};

/** Authority comes only from Eve's verified forwarded session. */
// oxlint-disable-next-line eslint/func-style -- Exported factory keeps the tenant authorization boundary explicit.
export function createPostgresValidationLogStore(input: {
  db: Database;
  sessionAuth: unknown;
  sessionId: string;
}): ValidationLogStore {
  const { principal } = exactForwardedSessionAuthority(input.sessionAuth);
  if (!input.sessionId) {
    throw new Error("The validation session is unavailable.");
  }
  // oxlint-disable-next-line eslint/no-use-before-define -- The factory below closes over verified authority.
  return postgresValidationLogStore(input.db, principal, input.sessionId);
}

// oxlint-disable-next-line eslint/func-style -- Exported factory is shared by the hosted store tests.
export function postgresValidationLogStore(
  db: Database,
  principal: HostedPrincipal,
  sessionId: string,
): ValidationLogStore {
  const assertKey = (key: ValidationLogKey) => {
    if (
      key.sessionId !== sessionId ||
      !/^[0-9a-f]{64}$/u.test(key.attemptDigest) ||
      !/^[0-9a-f-]{36}$/u.test(key.logId) ||
      !["stdout", "stderr"].includes(key.channel)
    ) {
      throw new Error("The validation log key is invalid for this session.");
    }
  };
  const scope = (key: ValidationLogKey) => ({
    audience: principal.audience,
    issuer: principal.issuer,
    logId: key.logId,
    ownerUserId: principal.ownerUserId,
    sessionId,
    workspaceId: principal.workspaceId,
  });
  const chunkWhere = (key: ValidationLogKey) =>
    and(
      eq(validationLogChunks.issuer, principal.issuer),
      eq(validationLogChunks.audience, principal.audience),
      eq(validationLogChunks.workspaceId, principal.workspaceId),
      eq(validationLogChunks.ownerUserId, principal.ownerUserId),
      eq(validationLogChunks.sessionId, sessionId),
      eq(validationLogChunks.logId, key.logId),
    );
  const manifestWhere = (key: ValidationLogKey) =>
    and(
      eq(validationLogManifests.issuer, principal.issuer),
      eq(validationLogManifests.audience, principal.audience),
      eq(validationLogManifests.workspaceId, principal.workspaceId),
      eq(validationLogManifests.ownerUserId, principal.ownerUserId),
      eq(validationLogManifests.sessionId, sessionId),
      eq(validationLogManifests.logId, key.logId),
      eq(validationLogManifests.attemptDigest, key.attemptDigest),
      eq(validationLogManifests.command, key.command),
      eq(validationLogManifests.channel, key.channel),
    );
  return {
    async getChunk(key, index) {
      assertKey(key);
      const [row] = await db
        .select({ content: validationLogChunks.content, digest: validationLogChunks.chunkDigest })
        .from(validationLogChunks)
        .where(and(chunkWhere(key), eq(validationLogChunks.chunkIndex, index)));
      return row;
    },
    async getReference(key): Promise<ValidationLogReference | undefined> {
      assertKey(key);
      const [row] = await db.select().from(validationLogManifests).where(manifestWhere(key));
      if (row === undefined) {
        return undefined;
      }
      const completion = row.completion === null ? undefined : readCompletion(row.completion);
      const reference: ValidationLogReferenceWithCompletion = {
        bytes: row.byteLength,
        channel: key.channel,
        chunkCount: row.chunkCount,
        digest: row.digest,
        logId: key.logId,
      };
      if (completion !== undefined) {
        reference.completion = completion;
      }
      return reference;
    },
    async publish(key, reference) {
      assertKey(key);
      await db.insert(validationLogManifests).values({
        ...scope(key),
        attemptDigest: key.attemptDigest,
        byteLength: reference.bytes,
        channel: key.channel,
        chunkCount: reference.chunkCount,
        command: key.command,
        // SAFETY: completion is optional for callers predating the completion metadata migration.
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion
        completion: (reference as ValidationLogReferenceWithCompletion).completion ?? null,
        createdAt: new Date(),
        digest: reference.digest,
      });
    },
    async putChunk(key, index, content, digest) {
      assertKey(key);
      if (!Number.isSafeInteger(index) || index < 0 || !/^[0-9a-f]{64}$/u.test(digest)) {
        throw new Error("The validation log chunk is invalid.");
      }
      await db.insert(validationLogChunks).values({
        ...scope(key),
        chunkDigest: digest,
        chunkIndex: index,
        command: key.command,
        content,
        createdAt: new Date(),
      });
    },
    async removeStaged(key) {
      assertKey(key);
      await db.delete(validationLogManifests).where(manifestWhere(key));
      await db.delete(validationLogChunks).where(chunkWhere(key));
    },
  };
}
