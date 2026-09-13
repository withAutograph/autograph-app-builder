import { and, desc, eq, gt, isNull, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import type * as databaseSchema from "../db/schema";
import { builderHandoffs, builderProvisioningJournals } from "../db/schema";
import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderHandoffIntentSchema, builderHandoffRecordSchema } from "./contracts";
import type { BuilderHandoffRecord } from "./contracts";
import type { BuilderHandoffStore } from "./service";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Authority = BuilderHandoffRecord["authority"];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function authorityPredicate(authorityInput: Authority) {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderHandoffs.issuer, authority.issuer),
    eq(builderHandoffs.audience, authority.audience),
    eq(builderHandoffs.workspaceId, authority.workspaceId),
    eq(builderHandoffs.ownerUserId, authority.ownerUserId),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function rowRecord(row: typeof builderHandoffs.$inferSelect): BuilderHandoffRecord {
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createPostgresBuilderHandoffStore(database: Database): BuilderHandoffStore {
  const read: BuilderHandoffStore["read"] = async (input) => {
    const rows = await database
      .select()
      .from(builderHandoffs)
      .where(
        and(authorityPredicate(input.authority), eq(builderHandoffs.handoffId, input.handoffId)),
      )
      .limit(1);
    return rows[0] ? rowRecord(rows[0]) : undefined;
  };

  const findLatestPending: NonNullable<BuilderHandoffStore["findLatestPending"]> = async ({
    authority: authorityInput,
  }) => {
    const authority = hostedTenantAuthoritySchema.parse(authorityInput);
    const rows = await database
      .select({ handoff: builderHandoffs })
      .from(builderHandoffs)
      .innerJoin(
        builderProvisioningJournals,
        and(
          eq(builderProvisioningJournals.issuer, builderHandoffs.issuer),
          eq(builderProvisioningJournals.audience, builderHandoffs.audience),
          eq(builderProvisioningJournals.workspaceId, builderHandoffs.workspaceId),
          eq(builderProvisioningJournals.ownerUserId, builderHandoffs.ownerUserId),
          eq(
            builderProvisioningJournals.requestId,
            sql<string>`${builderHandoffs.intent}->>'provisioningRequestId'`,
          ),
          eq(builderProvisioningJournals.state, "pending"),
        ),
      )
      .where(authorityPredicate(authority))
      .orderBy(desc(builderProvisioningJournals.updatedAt), desc(builderHandoffs.createdAt))
      .limit(1);
    return rows[0] ? rowRecord(rows[0].handoff) : undefined;
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
            gt(builderHandoffs.expiresAt, input.now),
          ),
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
    findLatestPending,
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
            isNull(builderHandoffs.sessionId),
          ),
        )
        .returning();
      if (updated[0]) return { disposition: "renewed", record: rowRecord(updated[0]) };
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
          ...record.authority,
          createdAt: record.createdAt,
          creationRequestId: record.creationRequestId,
          expiresAt: record.expiresAt,
          handoffId: record.handoffId,
          intent: record.intent,
          requestDigest: record.requestDigest,
        })
        .onConflictDoNothing()
        .returning();
      if (inserted[0]) return { disposition: "created", record: rowRecord(inserted[0]) };
      const existing = await database
        .select()
        .from(builderHandoffs)
        .where(
          and(
            authorityPredicate(record.authority),
            eq(builderHandoffs.creationRequestId, record.creationRequestId),
          ),
        )
        .limit(1);
      if (!existing[0]) throw new Error("builder-handoff-not-durable");
      return { disposition: "existing", record: rowRecord(existing[0]) };
    },
  };
}
