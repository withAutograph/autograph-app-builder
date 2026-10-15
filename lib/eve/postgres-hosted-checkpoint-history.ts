import { nativeDeliveryStateSchema } from "./native-delivery-state";
import { privateInputStateSchema } from "./session-limit-input";
import { createHash, randomUUID } from "node:crypto";

import { and, asc, eq, gt, inArray, isNull, lt, or, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the complete schema type.
import type * as databaseSchema from "../db/schema";
import {
  agentSessionCheckpointChunks,
  agentSessionCheckpointItems,
  agentSessionCheckpointManifests,
  agentSessions,
} from "../db/schema";
import {
  publicEveEventSchema,
  publicInputRequestSchema,
  publicPrototypeSchema,
  publicPrototypeReferenceSchema,
  publicUiPreviewSchema,
  publicWorkingPreviewSchema,
  sessionStatusSchema,
} from "../mcp/contracts";
import type { PublicEveEvent } from "../mcp/contracts";
import { hostedPrincipalSchema } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { nativeObservationStateSchema } from "./native-observation-state";
import { privateHostedApprovalCaptureStateSchema } from "./private-hosted-approval";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];
type Bytes = AsyncIterable<Uint8Array>;

// New checkpoint metadata lives in byte chunks. Legacy inline checkpoint
// validation retains its size limit until every read has moved to this store.
export const pagedCheckpointMetadataSchema = z.strictObject({
  activeTurnId: z.string().min(1).optional(),
  capturedAtEpochMs: z.number().int().nonnegative(),
  // A validated cold-read prefix remains private until the observer reaches its durable tail.
  coldReadProgress: z
    .strictObject({
      events: z.array(publicEveEventSchema),
      nativeObservationState: nativeObservationStateSchema,
      privateApprovalCaptureState: privateHostedApprovalCaptureStateSchema,
      version: z.literal(1),
    })
    .optional(),
  implementationPlan: z.json().optional(),
  inputRequests: z.array(publicInputRequestSchema).optional(),
  // Private, owner-scoped reducer snapshots live in chunked metadata and are
  // published atomically with the complete public event prefix.
  nativeDeliveryState: nativeDeliveryStateSchema.optional(),
  nativeObservationState: nativeObservationStateSchema.optional(),
  privateApprovalCaptureState: privateHostedApprovalCaptureStateSchema.optional(),
  privateInputState: privateInputStateSchema.optional(),
  prototype: publicPrototypeSchema.optional(),
  prototypeRef: publicPrototypeReferenceSchema.optional(),
  status: sessionStatusSchema,
  truncatedBeforeIndex: z.number().int().nonnegative().optional(),
  uiPreview: publicUiPreviewSchema.optional(),
  version: z.literal(1),
  workingPreview: publicWorkingPreviewSchema.nullable().optional(),
});

// Limits one database write and read, not the total checkpoint.
const CHUNK_BYTES = 64 * 1024;
// Bound SQL statements and in-flight encoded bytes, never the complete history.
// Each inserted row has ten parameters, well below Postgres's 65,534 limit.
const BATCH_ROWS = 256;
const BATCH_BYTES = CHUNK_BYTES * 16;
const MISSING_CHUNKS = "Hosted checkpoint item has missing chunks.";

const hashBytes = (bytes: Uint8Array) =>
  `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue | undefined };

// eslint-disable-next-line eslint/func-style -- Called by the recursive serializer.
function* jsonArrayFragments(value: JsonValue[]): Generator<string> {
  yield "[";
  for (const [index, item] of value.entries()) {
    if (index !== 0) {
      yield ",";
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- Mutual recursion is needed for JSON arrays.
    yield* jsonFragments(item === undefined ? null : item);
  }
  yield "]";
}

// eslint-disable-next-line eslint/func-style -- Called by the recursive serializer.
function* jsonObjectFragments(value: { [key: string]: JsonValue | undefined }): Generator<string> {
  yield "{";
  let first = true;
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) {
      continue;
    }
    if (!first) {
      yield ",";
    }
    first = false;
    yield JSON.stringify(key);
    yield ":";
    // oxlint-disable-next-line eslint/no-use-before-define -- Mutual recursion is needed for JSON objects.
    yield* jsonFragments(item);
  }
  yield "}";
}

// eslint-disable-next-line eslint/func-style -- Recursive JSON serialization is deliberately incremental.
function* jsonFragments(value: JsonValue): Generator<string> {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Dispatch over parsed JSON values.
  if (typeof value === "string") {
    yield '"';
    for (let offset = 0; offset < value.length;) {
      let end = Math.min(value.length, offset + 8192);
      if (end < value.length && /[\uD800-\uDBFF]/u.test(value.charAt(end - 1))) {
        end -= 1;
      }
      yield JSON.stringify(value.slice(offset, end)).slice(1, -1);
      offset = end;
    }
    yield '"';
    return;
  }
  if (Array.isArray(value)) {
    yield* jsonArrayFragments(value);
    return;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Dispatch over parsed JSON values.
  if (value !== null && typeof value === "object") {
    yield* jsonObjectFragments(value);
    return;
  }
  yield JSON.stringify(value);
}

// eslint-disable-next-line eslint/func-style -- Stream value encoding without a whole JSON string.
export async function* encodeCheckpointJson(value: JsonValue): Bytes {
  const encoder = new TextEncoder();
  for (const fragment of jsonFragments(value)) {
    yield encoder.encode(fragment);
  }
}

// eslint-disable-next-line eslint/func-style -- Shared tenant predicates are hoisted.
function tenant(principal: HostedPrincipal, sessionId: string, checkpointId: string) {
  return {
    audience: principal.audience,
    checkpointId,
    issuer: principal.issuer,
    ownerUserId: principal.ownerUserId,
    sessionId,
    workspaceId: principal.workspaceId,
  };
}

// eslint-disable-next-line eslint/func-style -- Shared tenant predicates are hoisted.
function manifestWhere(key: ReturnType<typeof tenant>) {
  return and(
    eq(agentSessionCheckpointManifests.issuer, key.issuer),
    eq(agentSessionCheckpointManifests.audience, key.audience),
    eq(agentSessionCheckpointManifests.workspaceId, key.workspaceId),
    eq(agentSessionCheckpointManifests.ownerUserId, key.ownerUserId),
    eq(agentSessionCheckpointManifests.sessionId, key.sessionId),
    eq(agentSessionCheckpointManifests.checkpointId, key.checkpointId),
  );
}

type CheckpointItem = typeof agentSessionCheckpointItems.$inferSelect;
type CheckpointChunk = typeof agentSessionCheckpointChunks.$inferSelect;
type CheckpointValue = z.infer<typeof pagedCheckpointMetadataSchema> | PublicEveEvent;

// eslint-disable-next-line eslint/func-style -- Shared integrity validation for individual items and pages.
function decodeItem(item: CheckpointItem, chunks: CheckpointChunk[]): CheckpointValue {
  if (chunks.length !== item.partCount) {
    throw new Error(MISSING_CHUNKS);
  }
  const hash = createHash("sha256");
  const parts: Buffer[] = [];
  for (const [partIndex, chunk] of chunks.entries()) {
    if (chunk.partIndex !== partIndex) {
      throw new Error("Hosted checkpoint chunk order is invalid.");
    }
    const bytes = Buffer.from(chunk.payload, "base64");
    if (bytes.toString("base64") !== chunk.payload || hashBytes(bytes) !== chunk.chunkDigest) {
      throw new Error("Hosted checkpoint chunk digest mismatch.");
    }
    hash.update(bytes);
    parts.push(bytes);
  }
  const bytes = Buffer.concat(parts);
  if (bytes.byteLength !== item.byteLength || `sha256:${hash.digest("hex")}` !== item.digest) {
    throw new Error("Hosted checkpoint item digest mismatch.");
  }
  const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  return item.itemIndex === -1
    ? pagedCheckpointMetadataSchema.parse(parsed)
    : publicEveEventSchema.parse(parsed);
}

// eslint-disable-next-line eslint/func-style -- Share bounded, tenant-scoped SQL reads without re-reading the manifest per event.
async function readItems(
  reader: Database | Transaction,
  key: ReturnType<typeof tenant>,
  indexes: number[],
): Promise<Map<number, CheckpointValue>> {
  const items = await reader
    .select()
    .from(agentSessionCheckpointItems)
    .where(
      and(
        eq(agentSessionCheckpointItems.issuer, key.issuer),
        eq(agentSessionCheckpointItems.audience, key.audience),
        eq(agentSessionCheckpointItems.workspaceId, key.workspaceId),
        eq(agentSessionCheckpointItems.ownerUserId, key.ownerUserId),
        eq(agentSessionCheckpointItems.sessionId, key.sessionId),
        eq(agentSessionCheckpointItems.checkpointId, key.checkpointId),
        inArray(agentSessionCheckpointItems.itemIndex, indexes),
      ),
    )
    .orderBy(asc(agentSessionCheckpointItems.itemIndex));
  if (items.length !== indexes.length) {
    throw new Error("Hosted checkpoint item is missing.");
  }
  const values = new Map<number, CheckpointValue>();
  let itemPosition = 0;
  let parts: CheckpointChunk[] = [];
  let afterItem = -2;
  let afterPart = -1;
  while (true) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Keyset chunk pages provide bounded backpressure.
    const chunks = await reader
      .select()
      .from(agentSessionCheckpointChunks)
      .where(
        and(
          eq(agentSessionCheckpointChunks.issuer, key.issuer),
          eq(agentSessionCheckpointChunks.audience, key.audience),
          eq(agentSessionCheckpointChunks.workspaceId, key.workspaceId),
          eq(agentSessionCheckpointChunks.ownerUserId, key.ownerUserId),
          eq(agentSessionCheckpointChunks.sessionId, key.sessionId),
          eq(agentSessionCheckpointChunks.checkpointId, key.checkpointId),
          inArray(agentSessionCheckpointChunks.itemIndex, indexes),
          or(
            gt(agentSessionCheckpointChunks.itemIndex, afterItem),
            and(
              eq(agentSessionCheckpointChunks.itemIndex, afterItem),
              gt(agentSessionCheckpointChunks.partIndex, afterPart),
            ),
          ),
        ),
      )
      .orderBy(
        asc(agentSessionCheckpointChunks.itemIndex),
        asc(agentSessionCheckpointChunks.partIndex),
      )
      .limit(BATCH_ROWS);
    for (const chunk of chunks) {
      const item = items[itemPosition];
      if (item === undefined || chunk.itemIndex !== item.itemIndex) {
        if (item === undefined) {
          throw new Error("Hosted checkpoint chunk order is invalid.");
        }
        values.set(item.itemIndex, decodeItem(item, parts));
        itemPosition += 1;
        parts = [];
      }
      if (chunk.itemIndex !== items[itemPosition]?.itemIndex) {
        throw new Error(MISSING_CHUNKS);
      }
      parts.push(chunk);
      afterItem = chunk.itemIndex;
      afterPart = chunk.partIndex;
    }
    if (chunks.length < BATCH_ROWS) {
      break;
    }
  }
  const lastItem = items[itemPosition];
  if (lastItem !== undefined) {
    values.set(lastItem.itemIndex, decodeItem(lastItem, parts));
  }
  if (values.size !== items.length) {
    throw new Error(MISSING_CHUNKS);
  }
  return values;
}

/** Stages immutable byte chunks without holding a transaction across a history stream. */
// eslint-disable-next-line eslint/func-style -- Exported factory follows the store convention.
export function createPostgresHostedCheckpointHistory(database: Database) {
  return {
    async cleanupStagedBefore(input: { principal: HostedPrincipal; beforeEpochMs: number }) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      if (!Number.isSafeInteger(input.beforeEpochMs) || input.beforeEpochMs < 0) {
        throw new Error("Hosted checkpoint cleanup needs a valid cutoff.");
      }
      const deleted = await database
        .delete(agentSessionCheckpointManifests)
        .where(
          and(
            eq(agentSessionCheckpointManifests.issuer, principal.issuer),
            eq(agentSessionCheckpointManifests.audience, principal.audience),
            eq(agentSessionCheckpointManifests.workspaceId, principal.workspaceId),
            eq(agentSessionCheckpointManifests.ownerUserId, principal.ownerUserId),
            isNull(agentSessionCheckpointManifests.publishedAt),
            lt(agentSessionCheckpointManifests.updatedAt, new Date(input.beforeEpochMs)),
          ),
        )
        .returning({ checkpointId: agentSessionCheckpointManifests.checkpointId });
      return deleted.length;
    },
    async discardStage(input: {
      principal: HostedPrincipal;
      sessionId: string;
      checkpointId: string;
    }) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const deleted = await database
        .delete(agentSessionCheckpointManifests)
        .where(
          and(
            manifestWhere(tenant(principal, input.sessionId, input.checkpointId)),
            isNull(agentSessionCheckpointManifests.publishedAt),
          ),
        )
        .returning({ checkpointId: agentSessionCheckpointManifests.checkpointId });
      return deleted.length === 1;
    },
    /** Invoke in the same transaction that updates agent_session's active pointer. */
    async publishInTransaction(
      transaction: Transaction,
      input: {
        principal: HostedPrincipal;
        sessionId: string;
        checkpointId: string;
        checkpointDigest: string;
        eventCount: number;
        itemCount: number;
        nowEpochMs: number;
      },
    ) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const key = tenant(principal, input.sessionId, input.checkpointId);
      const checkpointHash = createHash("sha256");
      let observedItems = 0;
      let expectedParts = 0;
      let afterIndex = -2;
      while (true) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Keyset pages must be verified in order.
        const page = await transaction
          .select({
            digest: agentSessionCheckpointItems.digest,
            itemIndex: agentSessionCheckpointItems.itemIndex,
            partCount: agentSessionCheckpointItems.partCount,
          })
          .from(agentSessionCheckpointItems)
          .where(
            and(
              eq(agentSessionCheckpointItems.issuer, key.issuer),
              eq(agentSessionCheckpointItems.audience, key.audience),
              eq(agentSessionCheckpointItems.workspaceId, key.workspaceId),
              eq(agentSessionCheckpointItems.ownerUserId, key.ownerUserId),
              eq(agentSessionCheckpointItems.sessionId, key.sessionId),
              eq(agentSessionCheckpointItems.checkpointId, key.checkpointId),
              gt(agentSessionCheckpointItems.itemIndex, afterIndex),
            ),
          )
          .orderBy(asc(agentSessionCheckpointItems.itemIndex))
          .limit(256);
        if (page.length === 0) {
          break;
        }
        for (const item of page) {
          if (item.itemIndex !== observedItems - 1) {
            throw new Error("Hosted checkpoint stage has a missing item.");
          }
          checkpointHash.update(`${item.itemIndex}:${item.digest}\n`);
          expectedParts += item.partCount;
          observedItems += 1;
          afterIndex = item.itemIndex;
        }
      }
      if (
        observedItems !== input.itemCount ||
        input.itemCount !== input.eventCount + 1 ||
        `sha256:${checkpointHash.digest("hex")}` !== input.checkpointDigest
      ) {
        throw new Error("Hosted checkpoint stage manifest does not match its items.");
      }
      const [countRow] = await transaction
        .select({ chunkCount: sql<number>`count(*)::integer` })
        .from(agentSessionCheckpointChunks)
        .where(
          and(
            eq(agentSessionCheckpointChunks.issuer, key.issuer),
            eq(agentSessionCheckpointChunks.audience, key.audience),
            eq(agentSessionCheckpointChunks.workspaceId, key.workspaceId),
            eq(agentSessionCheckpointChunks.ownerUserId, key.ownerUserId),
            eq(agentSessionCheckpointChunks.sessionId, key.sessionId),
            eq(agentSessionCheckpointChunks.checkpointId, key.checkpointId),
          ),
        );
      if (countRow === undefined || countRow.chunkCount !== expectedParts) {
        throw new Error("Hosted checkpoint stage has missing chunks.");
      }
      const rows = await transaction
        .update(agentSessionCheckpointManifests)
        .set({
          checkpointDigest: input.checkpointDigest,
          eventCount: input.eventCount,
          itemCount: input.itemCount,
          publishedAt: new Date(input.nowEpochMs),
          updatedAt: new Date(input.nowEpochMs),
        })
        .where(and(manifestWhere(key), isNull(agentSessionCheckpointManifests.publishedAt)))
        .returning();
      if (rows.length !== 1) {
        throw new Error("Hosted checkpoint stage is missing or already published.");
      }
      return rows[0];
    },
    async readItem(input: {
      principal: HostedPrincipal;
      sessionId: string;
      checkpointId: string;
      itemIndex: number;
      transaction?: Transaction;
    }) {
      const reader = input.transaction ?? database;
      const principal = hostedPrincipalSchema.parse(input.principal);
      const key = tenant(principal, input.sessionId, input.checkpointId);
      const manifests = await reader
        .select()
        .from(agentSessionCheckpointManifests)
        .where(manifestWhere(key))
        .limit(1);
      if (manifests[0]?.publishedAt === null || manifests[0] === undefined) {
        return null;
      }
      const values = await readItems(reader, key, [input.itemIndex]);
      return values.get(input.itemIndex) ?? null;
    },
    async readPage(input: {
      principal: HostedPrincipal;
      sessionId: string;
      checkpointId: string;
      cursor: number;
      limit: number;
      transaction?: Transaction;
    }) {
      const validCursor = Number.isSafeInteger(input.cursor) && input.cursor >= 0;
      const validLimit =
        Number.isSafeInteger(input.limit) && input.limit >= 1 && input.limit <= 250;
      if (!validCursor || !validLimit) {
        throw new Error(
          "Hosted checkpoint page needs a nonnegative cursor and a limit from 1 to 250.",
        );
      }
      const reader = input.transaction ?? database;
      const principal = hostedPrincipalSchema.parse(input.principal);
      const key = tenant(principal, input.sessionId, input.checkpointId);
      const manifests = await reader
        .select()
        .from(agentSessionCheckpointManifests)
        .where(manifestWhere(key))
        .limit(1);
      const [manifest] = manifests;
      if (
        manifest?.publishedAt === null ||
        manifest === undefined ||
        manifest.eventCount === null
      ) {
        return null;
      }
      const end = Math.min(manifest.eventCount, input.cursor + input.limit);
      const indexes = [-1];
      for (let index = input.cursor; index < end; index += 1) {
        indexes.push(index);
      }
      const values = await readItems(reader, key, indexes);
      const metadata = values.get(-1);
      if (metadata === undefined || "index" in metadata) {
        throw new Error("Hosted checkpoint metadata is missing.");
      }
      const events = [];
      for (let index = input.cursor; index < end; index += 1) {
        const event = values.get(index);
        if (event === undefined || !("index" in event) || event.index !== index) {
          throw new Error("Hosted checkpoint event page is incomplete.");
        }
        events.push(event);
      }
      return {
        checkpointDigest: manifest.checkpointDigest,
        cursor: end,
        events,
        metadata,
        totalEvents: manifest.eventCount,
      };
    },
    async stage(input: {
      principal: HostedPrincipal;
      sessionId: string;
      metadata: unknown;
      events: AsyncIterable<PublicEveEvent>;
      nowEpochMs: number;
      transaction?: Transaction;
    }) {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const writer = input.transaction ?? database;
      const checkpointId = randomUUID();
      const key = tenant(principal, input.sessionId, checkpointId);
      const session = await writer
        .select({ sessionId: agentSessions.sessionId })
        .from(agentSessions)
        .where(
          and(
            eq(agentSessions.issuer, principal.issuer),
            eq(agentSessions.audience, principal.audience),
            eq(agentSessions.workspaceId, principal.workspaceId),
            eq(agentSessions.ownerUserId, principal.ownerUserId),
            eq(agentSessions.sessionId, input.sessionId),
          ),
        )
        .limit(1);
      if (session.length !== 1) {
        throw new Error("Hosted checkpoint session was not found for this tenant.");
      }
      await writer.insert(agentSessionCheckpointManifests).values({
        ...key,
        createdAt: new Date(input.nowEpochMs),
        updatedAt: new Date(input.nowEpochMs),
      });
      const checkpointHash = createHash("sha256");
      const progressHash = createHash("sha256");
      let eventCount = 0;
      let pendingChunks: (typeof agentSessionCheckpointChunks.$inferInsert)[] = [];
      let pendingItems: (typeof agentSessionCheckpointItems.$inferInsert)[] = [];
      let pendingBytes = 0;
      // eslint-disable-next-line eslint/func-style -- Flush bounded statements before accepting more history.
      const flushBatch = async () => {
        if (pendingChunks.length === 0 && pendingItems.length === 0) {
          return;
        }
        if (pendingChunks.length > 0) {
          await writer.insert(agentSessionCheckpointChunks).values(pendingChunks);
        }
        if (pendingItems.length > 0) {
          await writer.insert(agentSessionCheckpointItems).values(pendingItems);
        }
        await writer
          .update(agentSessionCheckpointManifests)
          .set({ updatedAt: new Date() })
          .where(and(manifestWhere(key), isNull(agentSessionCheckpointManifests.publishedAt)));
        pendingChunks = [];
        pendingItems = [];
        pendingBytes = 0;
      };
      // eslint-disable-next-line eslint/func-style -- Stage each item using its enclosing key.
      const writeItem = async (itemIndex: number, source: Bytes) => {
        const itemHash = createHash("sha256");
        let byteLength = 0;
        let partCount = 0;
        let buffer = Buffer.alloc(0);
        // eslint-disable-next-line eslint/func-style -- Queue chunks with byte and row backpressure.
        const flush = async (bytes: Buffer) => {
          if (pendingBytes + bytes.byteLength > BATCH_BYTES) {
            await flushBatch();
          }
          pendingChunks.push({
            ...key,
            chunkDigest: hashBytes(bytes),
            itemIndex,
            partIndex: partCount,
            payload: bytes.toString("base64"),
          });
          pendingBytes += bytes.byteLength;
          partCount += 1;
          if (pendingChunks.length >= BATCH_ROWS || pendingBytes >= BATCH_BYTES) {
            await flushBatch();
          }
        };
        for await (const fragment of source) {
          if (!(fragment instanceof Uint8Array)) {
            throw new Error("Hosted checkpoint serialization yielded non-byte data.");
          }
          itemHash.update(fragment);
          byteLength += fragment.byteLength;
          let offset = 0;
          while (offset < fragment.byteLength) {
            const remaining = CHUNK_BYTES - buffer.byteLength;
            const end = Math.min(fragment.byteLength, offset + remaining);
            buffer = Buffer.concat([buffer, fragment.subarray(offset, end)]);
            offset = end;
            if (buffer.byteLength === CHUNK_BYTES) {
              // oxlint-disable-next-line eslint/no-await-in-loop -- Chunk writes require backpressure.
              await flush(buffer);
              buffer = Buffer.alloc(0);
            }
          }
        }
        if (buffer.byteLength !== 0 || partCount === 0) {
          await flush(buffer);
        }
        const itemDigest = `sha256:${itemHash.digest("hex")}`;
        pendingItems.push({
          ...key,
          byteLength,
          digest: itemDigest,
          itemIndex,
          partCount,
        });
        if (pendingItems.length >= BATCH_ROWS) {
          await flushBatch();
        }
        checkpointHash.update(`${itemIndex}:${itemDigest}\n`);
        if (itemIndex >= 0) {
          progressHash.update(`${itemIndex}:${itemDigest}\n`);
        }
      };
      try {
        const metadata = pagedCheckpointMetadataSchema.parse(input.metadata);
        const { capturedAtEpochMs, ...progressMetadata } = metadata;
        void capturedAtEpochMs;
        const progressMetadataHash = createHash("sha256");
        for await (const fragment of encodeCheckpointJson(progressMetadata)) {
          progressMetadataHash.update(fragment);
        }
        progressHash.update(`-1:sha256:${progressMetadataHash.digest("hex")}\n`);
        await writeItem(-1, encodeCheckpointJson(metadata));
        for await (const candidate of input.events) {
          const event = publicEveEventSchema.parse(candidate);
          if (event.index !== eventCount) {
            throw new Error("Hosted checkpoint events must have consecutive absolute indexes.");
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- Items are written in digest order.
          await writeItem(eventCount, encodeCheckpointJson(event));
          eventCount += 1;
        }
        await flushBatch();
      } catch (error) {
        await writer.delete(agentSessionCheckpointManifests).where(manifestWhere(key));
        throw error;
      }
      return {
        checkpointDigest: `sha256:${checkpointHash.digest("hex")}`,
        checkpointId,
        checkpointProgressDigest: `sha256:${progressHash.digest("hex")}`,
        eventCount,
        itemCount: eventCount + 1,
      };
    },
  };
}
