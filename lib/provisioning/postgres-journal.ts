import { and, eq } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import * as databaseSchema from "../db/schema";
import { builderProvisionRequestDigest } from "./contracts";
import {
  builderProvisionJournalRecordSchema,
  initialBuilderProvisionJournalRecord,
  type BuilderProvisionAuthority,
  type BuilderProvisionJournalRow,
  type BuilderProvisionJournalStore,
} from "./journal";

type Database = PostgresJsDatabase<typeof databaseSchema>;

function predicate(authority: BuilderProvisionAuthority, requestId: string) {
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, requestId),
  );
}

function parseRow(
  row: typeof builderProvisioningJournals.$inferSelect,
): BuilderProvisionJournalRow {
  return {
    authority: hostedTenantAuthoritySchema.parse({
      issuer: row.issuer,
      audience: row.audience,
      workspaceId: row.workspaceId,
      ownerUserId: row.ownerUserId,
    }),
    requestId: row.requestId,
    requestDigest: row.requestDigest,
    state: row.state as "pending" | "settled",
    revision: row.revision,
    record: builderProvisionJournalRecordSchema.parse(row.record),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function createPostgresBuilderProvisionJournalStore(
  database: Database,
): BuilderProvisionJournalStore {
  const read: BuilderProvisionJournalStore["read"] = async (input) => {
    const authority = hostedTenantAuthoritySchema.parse(input.authority);
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(authority, input.requestId))
      .limit(1);
    return rows[0] ? parseRow(rows[0]) : undefined;
  };
  return {
    async reserve(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const requestDigest = builderProvisionRequestDigest(input.request);
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          requestId: input.request.requestId,
          requestDigest,
          state: "pending",
          revision: 1,
          record: initialBuilderProvisionJournalRecord(
            input.request,
            input.now,
          ),
          createdAt: input.now,
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0]
        ? parseRow(rows[0])
        : await read({ authority, requestId: input.request.requestId });
      if (!row) throw new Error("provision-journal-not-durable");
      if (row.requestDigest !== requestDigest)
        throw new Error("provision-request-id-reused");
      return row;
    },
    read,
    async compareAndSet(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const record = builderProvisionJournalRecordSchema.parse(input.record);
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          state: record.response.status,
          revision: input.expectedRevision + 1,
          record,
          updatedAt: input.now,
        })
        .where(
          and(
            predicate(authority, input.requestId),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
          ),
        )
        .returning();
      return rows[0] ? parseRow(rows[0]) : undefined;
    },
  };
}
