import { and, eq, lt, sql } from "drizzle-orm";

import { builderDraftRecordSchema, builderDraftStatusSchema } from "../builder-drafts/contracts";
import type {
  BuilderDraftAuthority,
  BuilderDraftRow,
  BuilderDraftStore,
} from "../builder-drafts/service";
import { hostedTenantAuthoritySchema } from "./hosted-admin";
import type { HostedDatabase } from "./hosted-postgres";
import { builderDrafts } from "./schema";

type Database = HostedDatabase;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  const prefix: Pick<
    BuilderDraftRow,
    "authority" | "createdAt" | "draftId" | "lastClientMutationId"
  > = {
    authority: hostedTenantAuthoritySchema.parse({
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    }),
    createdAt: row.createdAt,
    draftId: row.draftId,
  };
  if (row.lastClientMutationId !== null) {
    prefix.lastClientMutationId = row.lastClientMutationId;
  }
  return {
    ...prefix,
    record: builderDraftRecordSchema.parse(row.record),
    revision: row.revision,
    status: builderDraftStatusSchema.parse(row.status),
    updatedAt: row.updatedAt,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- Preserve the existing unknown input contract.
function isUniqueViolation(error: unknown) {
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  return typeof error === "object" && error !== null && "code" in error && error.code === "23505";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function createUnlockedBuilderDraftStore(database: Database): BuilderDraftStore {
  const read: BuilderDraftStore["read"] = async ({ authority, draftId }) => {
    const rows = await database
      .select()
      .from(builderDrafts)
      .where(rowPredicate(authority, draftId))
      .limit(1);
    return rows[0] === undefined || rows[0] === null ? undefined : parseRow(rows[0]);
  };

  const readActive: BuilderDraftStore["readActive"] = async ({ authority }) => {
    const rows = await database
      .select()
      .from(builderDrafts)
      .where(and(authorityPredicate(authority), eq(builderDrafts.status, "active")))
      .limit(1);
    return rows[0] === undefined || rows[0] === null ? undefined : parseRow(rows[0]);
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
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const record = builderDraftRecordSchema.parse(input.record);
      // A compare-and-set loop makes the database completion order authoritative:
      // stale clients still save, but their response identifies the contention.
      for (let attempt = 0; attempt < 8; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const target = await read({ authority, draftId: input.draftId });
        if (target?.status === "archived") {
          throw new Error("builder-draft-archived");
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        const current = await readActive({ authority });
        if (input.expectedRevision > 0 && current?.draftId !== input.draftId) {
          throw new Error("builder-draft-stale");
        }
        if (current) {
          if (current.lastClientMutationId === input.clientMutationId) {
            return { concurrent: false, idempotent: true, row: current };
          }
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
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
          if (rows[0] !== undefined && rows[0] !== null) {
            return {
              concurrent: current.revision !== input.expectedRevision,
              idempotent: false,
              row: parseRow(rows[0]),
            };
          }
          continue;
        }

        try {
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
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
          if (rows[0] !== undefined && rows[0] !== null) {
            return {
              concurrent: input.expectedRevision !== 0,
              idempotent: false,
              row: parseRow(rows[0]),
            };
          }

          // A completed handoff's draft is read-only. Never reactivate it from
          // delayed page-hide transport or an old provider-return tab.
        } catch (error) {
          if (!isUniqueViolation(error)) {
            throw error;
          }
        }
      }
      throw new Error("builder-draft-contention");
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
      const lockKey = `builder-draft:${JSON.stringify(authority)}`;
      await transaction.execute(sql`select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))`);
      return await run(createUnlockedBuilderDraftStore(transaction));
    });
  };
  return {
    ...unlocked,
    archive: (input) => serialize(input.authority, (store) => store.archive(input)),
    saveActive: (input) => serialize(input.authority, (store) => store.saveActive(input)),
  };
}

export type { BuilderDraftRecord } from "../builder-drafts/contracts";
