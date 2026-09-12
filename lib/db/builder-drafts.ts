import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { builderDraftRecordSchema, builderDraftStatusSchema } from "../builder-drafts/contracts";
import type {
  BuilderDraftAuthority,
  BuilderDraftRow,
  BuilderDraftStore,
} from "../builder-drafts/service";
import { hostedTenantAuthoritySchema } from "./hosted-admin";
import * as schema from "./schema";

type Database = PostgresJsDatabase<typeof schema>;

function authorityPredicate(authorityInput: BuilderDraftAuthority) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(schema.builderDrafts.issuer, authority.issuer),
    eq(schema.builderDrafts.audience, authority.audience),
    eq(schema.builderDrafts.workspaceId, authority.workspaceId),
    eq(schema.builderDrafts.ownerUserId, authority.ownerUserId),
  );
}

function rowPredicate(authority: BuilderDraftAuthority, draftId: string) {
  return and(authorityPredicate(authority), eq(schema.builderDrafts.draftId, draftId));
}

function parseRow(row: typeof schema.builderDrafts.$inferSelect): BuilderDraftRow {
  return {
    authority: hostedTenantAuthoritySchema.parse({
      issuer: row.issuer,
      audience: row.audience,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
    }),
    draftId: row.draftId,
    status: builderDraftStatusSchema.parse(row.status),
    revision: row.revision,
    record: builderDraftRecordSchema.parse(row.record),
    ...(row.lastClientMutationId === null
      ? {}
      : { lastClientMutationId: row.lastClientMutationId }),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function isUniqueViolation(error: unknown) {
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

function createUnlockedBuilderDraftStore(database: Database): BuilderDraftStore {
  const read: BuilderDraftStore["read"] = async ({ authority, draftId }) => {
    const rows = await database
      .select()
      .from(schema.builderDrafts)
      .where(rowPredicate(authority, draftId))
      .limit(1);
    return rows[0] ? parseRow(rows[0]) : undefined;
  };

  const readActive: BuilderDraftStore["readActive"] = async ({ authority }) => {
    const rows = await database
      .select()
      .from(schema.builderDrafts)
      .where(and(authorityPredicate(authority), eq(schema.builderDrafts.status, "active")))
      .limit(1);
    return rows[0] ? parseRow(rows[0]) : undefined;
  };

  return {
    read,
    readActive,
    async saveActive(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const record = builderDraftRecordSchema.parse(input.record);
      // A compare-and-set loop makes the database completion order authoritative:
      // stale clients still save, but their response identifies the contention.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        const target = await read({ authority, draftId: input.draftId });
        if (target?.status === "archived") throw new Error("builder-draft-archived");
        const current = await readActive({ authority });
        if (input.expectedRevision > 0 && current?.draftId !== input.draftId)
          throw new Error("builder-draft-stale");
        if (current) {
          if (current.lastClientMutationId === input.clientMutationId)
            return { row: current, idempotent: true, concurrent: false };
          const rows = await database
            .update(schema.builderDrafts)
            .set({
              record,
              revision: current.revision + 1,
              lastClientMutationId: input.clientMutationId,
              updatedAt: input.now,
            })
            .where(
              and(
                rowPredicate(authority, current.draftId),
                eq(schema.builderDrafts.status, "active"),
                eq(schema.builderDrafts.revision, current.revision),
              ),
            )
            .returning();
          if (rows[0]) {
            return {
              row: parseRow(rows[0]),
              idempotent: false,
              concurrent: current.revision !== input.expectedRevision,
            };
          }
          continue;
        }

        try {
          const rows = await database
            .insert(schema.builderDrafts)
            .values({
              ...authority,
              draftId: input.draftId,
              status: "active",
              revision: 1,
              record,
              lastClientMutationId: input.clientMutationId,
              createdAt: input.now,
              updatedAt: input.now,
            })
            .onConflictDoNothing()
            .returning();
          if (rows[0]) {
            return {
              row: parseRow(rows[0]),
              idempotent: false,
              concurrent: input.expectedRevision !== 0,
            };
          }

          // A completed handoff's draft is read-only. Never reactivate it from
          // delayed page-hide transport or an old provider-return tab.
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new Error("builder-draft-contention");
    },
    async archive({ authority, draftId, now, expectedRevision }) {
      const rows = await database
        .update(schema.builderDrafts)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            rowPredicate(authority, draftId),
            eq(schema.builderDrafts.status, "active"),
            expectedRevision === undefined
              ? undefined
              : eq(schema.builderDrafts.revision, expectedRevision),
          ),
        )
        .returning({ draftId: schema.builderDrafts.draftId });
      return rows.length > 0;
    },
    async deleteInactiveSince({ now, maxAgeMs }) {
      const cutoff = new Date(now.getTime() - (maxAgeMs ?? 30 * 24 * 60 * 60 * 1000));
      const rows = await database
        .delete(schema.builderDrafts)
        .where(
          and(
            eq(schema.builderDrafts.status, "active"),
            lt(schema.builderDrafts.updatedAt, cutoff),
          ),
        )
        .returning({ draftId: schema.builderDrafts.draftId });
      return rows.length;
    },
  };
}

/** Save and archive share one short database transaction per tenant draft. */
export function createBuilderDraftStore(database: Database): BuilderDraftStore {
  const unlocked = createUnlockedBuilderDraftStore(database);
  const serialize = async <T>(
    authorityInput: BuilderDraftAuthority,
    run: (store: BuilderDraftStore) => Promise<T>,
  ) => {
    const authority = hostedTenantAuthoritySchema.parse(authorityInput);
    return database.transaction(async (transaction) => {
      await transaction.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`builder-draft:${JSON.stringify(authority)}`}, 0))`,
      );
      return run(createUnlockedBuilderDraftStore(transaction));
    });
  };
  return {
    ...unlocked,
    saveActive: (input) => serialize(input.authority, (store) => store.saveActive(input)),
    archive: (input) => serialize(input.authority, (store) => store.archive(input)),
  };
}

export type { BuilderDraftRecord } from "../builder-drafts/contracts";
