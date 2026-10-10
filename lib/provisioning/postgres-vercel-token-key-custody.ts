import { and, eq, sql } from "drizzle-orm";
import type { openHostedPostgresDatabase } from "../mcp/hosted-route";

import { hostedTenantAuthoritySchema } from "../db/hosted-admin";
import { builderProvisioningJournals } from "../db/schema";
import {
  custodyActorDigest,
  custodyDigest,
  custodyKind,
  custodyPlanSchema,
  custodyRecordSchema,
  CustodyReconciliationRequiredError,
  CustodyUnavailableError,
} from "./vercel-token-key-custody";
import type {
  CanonicalSourceActor,
  CustodyJournalRow,
  CustodyJournalStore,
  CustodyRecord,
} from "./vercel-token-key-custody";

type Database = ReturnType<typeof openHostedPostgresDatabase>;
const predicate = (authorityInput: CanonicalSourceActor, operationRef: string) => {
  const authority = hostedTenantAuthoritySchema.parse(authorityInput);
  return and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, operationRef),
    sql`${builderProvisioningJournals.record} ->> 'kind' = ${custodyKind}`,
  );
};
const parseRow = (row: typeof builderProvisioningJournals.$inferSelect): CustodyJournalRow => {
  const record = custodyRecordSchema.parse(row.record);
  if (
    row.requestId !== record.plan.operationRef ||
    row.requestDigest !== record.planDigest ||
    custodyActorDigest({
      audience: row.audience,
      issuer: row.issuer,
      ownerUserId: row.ownerUserId,
      workspaceId: row.workspaceId,
    }) !== custodyActorDigest(record.originalActor)
  ) {
    throw new CustodyUnavailableError();
  }
  return { record, revision: row.revision };
};
const immutableIdentity = (record: CustodyRecord) =>
  custodyDigest({
    approvalRef: record.approvalRef,
    grantDigest: record.grantDigest,
    grantRef: record.grantRef,
    originalActor: record.originalActor,
    plan: record.plan,
    planDigest: record.planDigest,
  });
const phases = [
  "reserved",
  "attempted",
  "secret-confirmed",
  "possession-pending",
  "possession-verified",
];
const assertNonceTransition = (previous: CustodyRecord, next: CustodyRecord, now: Date) => {
  if (previous.nonce === undefined) {
    return;
  }
  const changed =
    next.nonce !== previous.nonce ||
    next.nonceExpiresAt !== previous.nonceExpiresAt ||
    next.receivingDeploymentId !== previous.receivingDeploymentId;
  if (!changed) {
    return;
  }
  if (
    next.fenceGeneration !== previous.fenceGeneration + 1 ||
    previous.nonceExpiresAt === undefined ||
    Date.parse(previous.nonceExpiresAt) > now.getTime()
  ) {
    throw new CustodyUnavailableError();
  }
};
const assertFenceTransition = (previous: CustodyRecord, next: CustodyRecord, now: Date) => {
  if (next.fenceGeneration === previous.fenceGeneration) {
    if (next.leaseId !== previous.leaseId || next.leaseExpiresAt !== previous.leaseExpiresAt) {
      throw new CustodyUnavailableError();
    }
    return;
  }
  if (
    next.fenceGeneration !== previous.fenceGeneration + 1 ||
    next.leaseId === undefined ||
    next.leaseId === previous.leaseId
  ) {
    throw new CustodyUnavailableError();
  }
  if (next.leaseExpiresAt === undefined || Date.parse(next.leaseExpiresAt) <= now.getTime()) {
    throw new CustodyUnavailableError();
  }
  if (
    previous.leaseExpiresAt !== undefined &&
    Date.parse(previous.leaseExpiresAt) > now.getTime()
  ) {
    throw new CustodyUnavailableError();
  }
  if (previous.nonce !== undefined && next.nonce === previous.nonce) {
    throw new CustodyUnavailableError();
  }
};
const assertTransition = (previous: CustodyRecord, next: CustodyRecord, now: Date) => {
  if (
    immutableIdentity(previous) !== immutableIdentity(next) ||
    phases.indexOf(next.phase) < phases.indexOf(previous.phase)
  ) {
    throw new CustodyUnavailableError();
  }
  if (previous.attemptedAt !== undefined && previous.attemptedAt !== next.attemptedAt) {
    throw new CustodyUnavailableError();
  }
  if (
    previous.secret !== undefined &&
    custodyDigest(previous.secret) !== custodyDigest(next.secret)
  ) {
    throw new CustodyUnavailableError();
  }
  if (previous.nonceConsumedAt !== undefined && custodyDigest(previous) !== custodyDigest(next)) {
    throw new CustodyUnavailableError();
  }
  assertNonceTransition(previous, next, now);
  assertFenceTransition(previous, next, now);
};

/** Checkpoints commit on the journal pool, independently of the physical slot lock transaction. */
export const createPostgresVercelTokenKeyCustodyStore = (
  database: Database,
): CustodyJournalStore => {
  const read: CustodyJournalStore["read"] = async ({ authority, operationRef }) => {
    const [row] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(authority, operationRef))
      .limit(1);
    return row === undefined ? undefined : parseRow(row);
  };
  const findSlotClaims: CustodyJournalStore["findSlotClaims"] = async ({ plan: input }) => {
    const plan = custodyPlanSchema.parse(input);
    // Deliberately global: foreign tenant claims must serialize the same physical slot.
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(
        and(
          sql`${builderProvisioningJournals.record} ->> 'kind' = ${custodyKind}`,
          sql`${builderProvisioningJournals.record} #>> '{plan,destination,teamId}' = ${plan.destination.teamId}`,
          sql`${builderProvisioningJournals.record} #>> '{plan,destination,projectId}' = ${plan.destination.projectId}`,
          sql`${builderProvisioningJournals.record} #>> '{plan,destination,environment}' = 'preview'`,
          sql`${builderProvisioningJournals.record} #> '{plan,destination,gitBranch}' = 'null'::jsonb`,
          sql`${builderProvisioningJournals.record} #>> '{plan,destination,key}' = 'VERCEL_INTEGRATION_TOKEN_KEY'`,
          sql`${builderProvisioningJournals.record} #>> '{plan,destination,versionKey}' = 'VERCEL_INTEGRATION_TOKEN_KEY_VERSION'`,
        ),
      );
    return rows.map(parseRow);
  };
  return {
    async compareAndSet(input) {
      const record = custodyRecordSchema.parse(input.record);
      if (
        record.plan.operationRef !== input.operationRef ||
        custodyActorDigest(input.authority) !== custodyActorDigest(record.originalActor)
      ) {
        throw new CustodyUnavailableError();
      }
      const current = await read(input);
      if (current === undefined || current.revision !== input.expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The CAS interface returns no row on a stale revision.
        return undefined;
      }
      assertTransition(current.record, record, input.now);
      const [row] = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: input.expectedRevision + 1,
          state: record.phase === "possession-verified" ? "settled" : "pending",
          updatedAt: input.now,
        })
        .where(
          and(
            predicate(input.authority, input.operationRef),
            eq(builderProvisioningJournals.revision, input.expectedRevision),
          ),
        )
        .returning();
      return row === undefined ? undefined : parseRow(row);
    },
    findSlotClaims,
    read,
    async reserve(input) {
      const authority = hostedTenantAuthoritySchema.parse(input.authority);
      const record = custodyRecordSchema.parse(input.record);
      if (
        record.phase !== "reserved" ||
        record.fenceGeneration !== 0 ||
        record.leaseId !== undefined
      ) {
        throw new CustodyUnavailableError();
      }
      if (
        [
          record.attemptedAt,
          record.secret,
          record.receivingDeploymentId,
          record.nonce,
          record.nonceExpiresAt,
          record.nonceConsumedAt,
          record.receipt,
        ].some((value) => value !== undefined)
      ) {
        throw new CustodyUnavailableError();
      }
      if (custodyActorDigest(authority) !== custodyActorDigest(record.originalActor)) {
        throw new CustodyUnavailableError();
      }
      const claims = await findSlotClaims({ plan: record.plan });
      if (
        claims.some(
          (claim) =>
            claim.record.plan.operationRef !== record.plan.operationRef ||
            custodyActorDigest(claim.record.originalActor) !== custodyActorDigest(authority),
        )
      ) {
        throw new CustodyReconciliationRequiredError();
      }
      const [created] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...authority,
          createdAt: input.now,
          record,
          requestDigest: record.planDigest,
          requestId: record.plan.operationRef,
          revision: 1,
          state: "pending",
          updatedAt: input.now,
        })
        .onConflictDoNothing()
        .returning();
      const row =
        created === undefined
          ? await read({ authority, operationRef: record.plan.operationRef })
          : parseRow(created);
      if (row === undefined || immutableIdentity(row.record) !== immutableIdentity(record)) {
        throw new CustodyUnavailableError();
      }
      return row;
    },
  };
};
