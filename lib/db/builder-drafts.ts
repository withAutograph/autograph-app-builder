import { and, eq, lt, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import {
  builderDraftRecordSchema,
  builderDraftStatusSchema,
} from "../builder-drafts/contracts";
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
  return and(
    authorityPredicate(authority),
    eq(schema.builderDrafts.draftId, draftId),
  );
}

function parseRow(
  row: typeof schema.builderDrafts.$inferSelect,
): BuilderDraftRow {
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
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

export function createBuilderDraftStore(database: Database): BuilderDraftStore {
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
      .where(
        and(
          authorityPredicate(authority),
          eq(schema.builderDrafts.status, "active"),
        ),
      )
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
        const current = await readActive({ authority });
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

          // The draft may be an archived provider-return draft. Reactivate it
          // only while this tenant has no other active draft.
          const restored = await database
            .update(schema.builderDrafts)
            .set({
              status: "active",
              revision: sql`${schema.builderDrafts.revision} + 1`,
              record,
              lastClientMutationId: input.clientMutationId,
              updatedAt: input.now,
            })
            .where(
              and(
                rowPredicate(authority, input.draftId),
                eq(schema.builderDrafts.status, "archived"),
              ),
            )
            .returning();
          if (restored[0]) {
            return {
              row: parseRow(restored[0]),
              idempotent: false,
              concurrent: input.expectedRevision !== 0,
            };
          }
        } catch (error) {
          if (!isUniqueViolation(error)) throw error;
        }
      }
      throw new Error("builder-draft-contention");
    },
    async archive({ authority, draftId, now }) {
      const rows = await database
        .update(schema.builderDrafts)
        .set({ status: "archived", updatedAt: now })
        .where(
          and(
            rowPredicate(authority, draftId),
            eq(schema.builderDrafts.status, "active"),
          ),
        )
        .returning({ draftId: schema.builderDrafts.draftId });
      return rows.length > 0;
    },
    async deleteInactiveSince({ now, maxAgeMs }) {
      const cutoff = new Date(
        now.getTime() - (maxAgeMs ?? 30 * 24 * 60 * 60 * 1000),
      );
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

export type { BuilderDraftRecord } from "../builder-drafts/contracts";
