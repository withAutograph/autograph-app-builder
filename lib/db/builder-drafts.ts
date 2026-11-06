import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { builderDraftRecordSchema, builderDraftStatusSchema } from "../builder-drafts/contracts";
import type {
  BuilderDraftAuthority,
  BuilderDraftRow,
  BuilderDraftStore,
} from "../builder-drafts/service";
import { hostedTenantAuthoritySchema } from "./hosted-admin";
import { builderDrafts } from "./schema";

type Database = PostgresJsDatabase<{ builderDrafts: typeof builderDrafts }>;
const uniqueViolationSchema = z.object({ code: z.literal("23505") });
type UniqueViolation = z.infer<typeof uniqueViolationSchema>;

function authorityPredicate(authorityInput: BuilderDraftAuthority) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderDrafts.issuer, authority.issuer),
    eq(builderDrafts.audience, authority.audience),
    eq(builderDrafts.workspaceId, authority.workspaceId),
    eq(builderDrafts.ownerUserId, authority.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function rowPredicate(authority: BuilderDraftAuthority, draftId: string) {
  return and(authorityPredicate(authority), eq(builderDrafts.draftId, draftId));
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function parseRow(row: typeof builderDrafts.$inferSelect): BuilderDraftRow {
  const parsed: Omit<BuilderDraftRow, "lastClientMutationId"> & { lastClientMutationId?: string } =
    {
      authority: hostedTenantAuthoritySchema.parse({
        audience: row.audience,
        issuer: row.issuer,
        ownerUserId: row.ownerUserId,
        workspaceId: row.workspaceId,
      }),
      createdAt: row.createdAt,
      draftId: row.draftId,
      record: builderDraftRecordSchema.parse(row.record),
      revision: row.revision,
      status: builderDraftStatusSchema.parse(row.status),
      updatedAt: row.updatedAt,
    };
  if (row.lastClientMutationId !== null) {
    parsed.lastClientMutationId = row.lastClientMutationId;
  }
  return parsed;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function isUniqueViolation(violation: UniqueViolation) {
  return violation.code === "23505";
}

const updateActiveDraft = async (
  database: Database,
  authority: BuilderDraftAuthority,
  current: BuilderDraftRow,
  input: Parameters<BuilderDraftStore["saveActive"]>[0],
  record: BuilderDraftRow["record"],
) => {
  const rows = await database
    .update(builderDrafts)
    .set({
      lastClientMutationId: input.clientMutationId,
      record,
      revision: current.revision + 1,
      updatedAt: input.now,
    })
    .where(
      and(
        rowPredicate(authority, current.draftId),
        eq(builderDrafts.status, "active"),
        eq(builderDrafts.revision, current.revision),
      ),
    )
    .returning();
  const [row] = rows;
  if (row === undefined) return null;
  return {
    concurrent: current.revision !== input.expectedRevision,
    idempotent: false,
    row: parseRow(row),
  };
};

const insertActiveDraft = async (
  database: Database,
  authority: BuilderDraftAuthority,
  input: Parameters<BuilderDraftStore["saveActive"]>[0],
  record: BuilderDraftRow["record"],
) => {
  try {
    const rows = await database
      .insert(builderDrafts)
      .values({
        ...authority,
        createdAt: input.now,
        draftId: input.draftId,
        lastClientMutationId: input.clientMutationId,
        record,
        revision: 1,
        status: "active",
        updatedAt: input.now,
      })
      .onConflictDoNothing()
      .returning();
    const [row] = rows;
    if (row === undefined) return null;
    return {
      concurrent: input.expectedRevision !== 0,
      idempotent: false,
      row: parseRow(row),
    };
  } catch (caughtError) {
    const parsed = uniqueViolationSchema.safeParse(caughtError);
    if (!parsed.success) throw caughtError;
    if (!isUniqueViolation(parsed.data)) throw caughtError;
    return null;
  }
};

const saveActive = async (
  database: Database,
  read: BuilderDraftStore["read"],
  readActive: BuilderDraftStore["readActive"],
  input: Parameters<BuilderDraftStore["saveActive"]>[0],
) => {
  const authority = hostedTenantAuthoritySchema.parse(input.authority);
  const record = builderDraftRecordSchema.parse(input.record);
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const target = await read({ authority, draftId: input.draftId });
    if (target?.status === "archived") throw new Error("builder-draft-archived");
    const current = await readActive({ authority });
    if (input.expectedRevision > 0 && current?.draftId !== input.draftId) {
      throw new Error("builder-draft-stale");
    }
    if (current !== undefined) {
      if (current.lastClientMutationId === input.clientMutationId) {
        return { concurrent: false, idempotent: true, row: current };
      }
      const updated = await updateActiveDraft(database, authority, current, input, record);
      if (updated !== null) return updated;
      continue;
    }
    const inserted = await insertActiveDraft(database, authority, input, record);
    if (inserted !== null) return inserted;
  }
  throw new Error("builder-draft-contention");
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createUnlockedBuilderDraftStore(database: Database): BuilderDraftStore {
  const read: BuilderDraftStore["read"] = async ({ authority, draftId }) => {
    const rows = await database
      .select()
      .from(builderDrafts)
      .where(rowPredicate(authority, draftId))
      .limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };

  const readActive: BuilderDraftStore["readActive"] = async ({ authority }) => {
    const rows = await database
      .select()
      .from(builderDrafts)
      .where(and(authorityPredicate(authority), eq(builderDrafts.status, "active")))
      .limit(1);
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  };

  return {
    async archive({ authority, draftId, now, expectedRevision }) {
      const rows = await database
        .update(builderDrafts)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            rowPredicate(authority, draftId),
            eq(builderDrafts.status, "active"),
            expectedRevision === undefined
              ? undefined
              : eq(builderDrafts.revision, expectedRevision),
          ),
        )
        .returning({ draftId: builderDrafts.draftId });
      return rows.length > 0;
    },
    async deleteInactiveSince({ now, maxAgeMs }) {
      const cutoff = new Date(now.getTime() - (maxAgeMs ?? 30 * 24 * 60 * 60 * 1000));
      const rows = await database
        .delete(builderDrafts)
        .where(and(eq(builderDrafts.status, "active"), lt(builderDrafts.updatedAt, cutoff)))
        .returning({ draftId: builderDrafts.draftId });
      return rows.length;
    },
    read,
    readActive,
    async saveActive(input) {
      return await saveActive(database, read, readActive, input);
    },
  };
}

/** Save and archive share one short database transaction per tenant draft. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createBuilderDraftStore(database: Database): BuilderDraftStore {
  const unlocked = createUnlockedBuilderDraftStore(database);
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  const serialize = async <T>(
    authorityInput: BuilderDraftAuthority,
    run: (store: BuilderDraftStore) => Promise<T>,
  ) => {
    const authority = hostedTenantAuthoritySchema.parse(authorityInput);
    return await database.transaction(async (transaction) => {
      const lockKeyPrefix = "builder-draft:";
      const lockKey = lockKeyPrefix + JSON.stringify(authority);
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return await run(createUnlockedBuilderDraftStore(transaction));
    });
  };
  return {
    ...unlocked,
    archive: async (input) =>
      await serialize(input.authority, async (store) => await store.archive(input)),
    saveActive: async (input) =>
      await serialize(input.authority, async (store) => await store.saveActive(input)),
  };
}

export type { BuilderDraftRecord } from "../builder-drafts/contracts";
