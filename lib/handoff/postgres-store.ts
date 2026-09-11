import { and, eq, gt, isNull, lte } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import type * as databaseSchema from "../db/schema";
import { builderHandoffs } from "../db/schema";
import {
  builderHandoffIntentSchema,
  builderHandoffRecordSchema,
} from "./contracts";
import type { BuilderHandoffRecord } from "./contracts";
import type { BuilderHandoffStore } from "./service";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Authority = BuilderHandoffRecord["authority"];

function authorityPredicate(authorityInput: Authority) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderHandoffs.issuer, authority.issuer),
    eq(builderHandoffs.audience, authority.audience),
    eq(builderHandoffs.workspaceId, authority.workspaceId),
    eq(builderHandoffs.ownerUserId, authority.ownerUserId)
  );
}

function rowRecord(
  row: typeof builderHandoffs.$inferSelect
): BuilderHandoffRecord {
  return builderHandoffRecordSchema.parse({
    authority: {
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    },
    createdAt: row.createdAt,
    creationRequestId: row.creationRequestId,
    expiresAt: row.expiresAt,
    handoffId: row.handoffId,
    intent: builderHandoffIntentSchema.parse(row.intent),
    requestDigest: row.requestDigest,
    version: 1,
    ...(row.redeemedAt === null ? {} : { redeemedAt: row.redeemedAt }),
    ...(row.sessionId === null ? {} : { sessionId: row.sessionId }),
  });
}

export function createPostgresBuilderHandoffStore(
  database: Database
): BuilderHandoffStore {
  const read: BuilderHandoffStore["read"] = async (input) => {
    const rows = await database
      .select()
      .from(builderHandoffs)
      .where(
        and(
          authorityPredicate(input.authority),
          eq(builderHandoffs.handoffId, input.handoffId)
        )
      )
      .limit(1);
    return rows[0] ? rowRecord(rows[0]) : undefined;
  };

  return {
    async bindSession(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const updated = await database
        .update(builderHandoffs)
        .set({ redeemedAt: input.now, sessionId: input.sessionId })
        .where(
          and(
            authorityPredicate(authority),
            eq(builderHandoffs.handoffId, input.handoffId),
            eq(builderHandoffs.requestDigest, input.requestDigest),
            isNull(builderHandoffs.redeemedAt),
            isNull(builderHandoffs.sessionId),
            gt(builderHandoffs.expiresAt, input.now)
          )
        )
        .returning();
      if (updated[0]) return rowRecord(updated[0]);
      const existing = await read({
        authority,
        handoffId: input.handoffId,
      });
      return existing?.requestDigest === input.requestDigest &&
        existing.sessionId === input.sessionId
        ? existing
        : undefined;
    },
    read,
    async renewExpired(input) {
      const updated = await database
        .update(builderHandoffs)
        .set({ expiresAt: input.expiresAt })
        .where(
          and(
            authorityPredicate(input.authority),
            eq(builderHandoffs.handoffId, input.handoffId),
            eq(builderHandoffs.requestDigest, input.requestDigest),
            // PostgreSQL timestamps may retain microseconds lost by JS Date.
            // Expired + unbound is the atomic guard; do not compare a readback
            // timestamp for equality. A winning renewal moves expiry past now.
            lte(builderHandoffs.expiresAt, input.now),
            isNull(builderHandoffs.redeemedAt),
            isNull(builderHandoffs.sessionId)
          )
        )
        .returning();
      if (updated[0])
        return { disposition: "renewed", record: rowRecord(updated[0]) };
      // A concurrent renewal or bind won the CAS. Return its current reference.
      const existing = await read(input);
      return existing?.requestDigest === input.requestDigest &&
        (existing.sessionId !== undefined || existing.expiresAt > input.now)
        ? { disposition: "existing", record: existing }
        : undefined;
    },
    async reserve(recordInput) {
      const record = builderHandoffRecordSchema.parse(recordInput);
      const inserted = await database
        .insert(builderHandoffs)
        .values({
          handoffId: record.handoffId,
          ...record.authority,
          creationRequestId: record.creationRequestId,
          requestDigest: record.requestDigest,
          intent: record.intent,
          createdAt: record.createdAt,
          expiresAt: record.expiresAt,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0])
        return { disposition: "created", record: rowRecord(inserted[0]) };
      const existing = await database
        .select()
        .from(builderHandoffs)
        .where(
          and(
            authorityPredicate(record.authority),
            eq(builderHandoffs.creationRequestId, record.creationRequestId)
          )
        )
        .limit(1);
      if (!existing[0]) throw new Error("builder-handoff-not-durable");
      return { disposition: "existing", record: rowRecord(existing[0]) };
    },
  };
}
