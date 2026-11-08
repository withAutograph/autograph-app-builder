import { isDeepStrictEqual } from "node:util";
import { and, eq, or, sql } from "drizzle-orm";
import type { HostedDatabase } from "../db/hosted-postgres";
import { builderProvisioningJournals } from "../db/schema";
import type { RepositoryProductionScope } from "../provisioning/repository-production-contract";
import { AppAccessError } from "./errors";
import { appAccessOperationDigest, appAccessOperationSchema } from "./management";
import type { AppAccessOperationRow, AppAccessOperationStore } from "./management";

type Database = HostedDatabase;
const ownerPredicate = (scope: RepositoryProductionScope) =>
  and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    sql`${builderProvisioningJournals.record}->>'kind' = 'app-access-operation-v1'`,
  );
const parseRow = (raw: typeof builderProvisioningJournals.$inferSelect): AppAccessOperationRow => {
  const record = appAccessOperationSchema.parse(raw.record);
  const sameAuthority = isDeepStrictEqual(
    {
      issuer: raw.issuer,
      audience: raw.audience,
      workspaceId: raw.workspaceId,
      ownerUserId: raw.ownerUserId,
    },
    record.scope.authority,
  );
  if (
    raw.requestId !== record.command.clientRequestId ||
    raw.requestDigest !== appAccessOperationDigest(record.scope, record.command) ||
    !sameAuthority
  ) {
    throw new AppAccessError("request_id_conflict");
  }
  return { revision: raw.revision, record };
};

/** Access intents share the existing durable provision journal, isolated by record kind. */
export const createPostgresAppAccessOperationStore = (
  database: Database,
): AppAccessOperationStore => ({
  async reserve(input) {
    const record = appAccessOperationSchema.parse(input);
    const now = new Date();
    const inserted = await database
      .insert(builderProvisioningJournals)
      .values({
        ...record.scope.authority,
        requestId: record.command.clientRequestId,
        requestDigest: appAccessOperationDigest(record.scope, record.command),
        record,
        state: "pending",
        revision: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()
      .returning();
    const rows = inserted.length
      ? inserted
      : await database
          .select()
          .from(builderProvisioningJournals)
          .where(
            and(
              ownerPredicate(record.scope),
              eq(builderProvisioningJournals.requestId, record.command.clientRequestId),
            ),
          )
          .limit(1);
    const found = rows.at(0);
    if (found === undefined) {
      throw new AppAccessError("request_id_conflict");
    }
    return parseRow(found);
  },
  async pending(scope) {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          ownerPredicate(scope),
          or(
            eq(builderProvisioningJournals.state, "pending"),
            sql`${builderProvisioningJournals.record}->'enrollment'->>'state' = 'pending'`,
          ),
          sql`${builderProvisioningJournals.record}->'scope'->>'appId' = ${scope.appId}`,
          sql`${builderProvisioningJournals.record}->'scope'->>'repositoryId' = ${scope.repositoryId}`,
        ),
      );
    return rows.map(parseRow);
  },
  async update(row, input) {
    const record = appAccessOperationSchema.parse(input);
    if (
      !isDeepStrictEqual(record.scope, row.record.scope) ||
      !isDeepStrictEqual(record.ownerContext, row.record.ownerContext) ||
      appAccessOperationDigest(record.scope, record.command) !==
        appAccessOperationDigest(row.record.scope, row.record.command)
    ) {
      throw new AppAccessError("request_id_conflict");
    }
    const rows = await database
      .update(builderProvisioningJournals)
      .set({
        record,
        revision: row.revision + 1,
        state: record.state === "pending" ? "pending" : "settled",
        updatedAt: new Date(),
      })
      .where(
        and(
          ownerPredicate(record.scope),
          eq(builderProvisioningJournals.requestId, record.command.clientRequestId),
          eq(builderProvisioningJournals.revision, row.revision),
        ),
      )
      .returning();
    return rows[0] === undefined ? undefined : parseRow(rows[0]);
  },
  async findInvitation(invitationId) {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          eq(builderProvisioningJournals.requestId, invitationId),
          sql`${builderProvisioningJournals.record}->>'kind' = 'app-access-operation-v1'`,
          sql`${builderProvisioningJournals.record}->'command'->>'action' = 'invite'`,
        ),
      )
      .limit(2);
    if (rows.length !== 1) {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Absent or ambiguous owner lookup returns no invitation.
      return undefined;
    }
    const found = rows.at(0);
    return found === undefined ? undefined : parseRow(found);
  },
});
