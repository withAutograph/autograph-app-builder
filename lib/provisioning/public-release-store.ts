/* oxlint-disable eslint/complexity, sonarjs/expression-complexity -- Journal reads and CAS validate the complete immutable authority and effect history. */
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { builderProvisioningJournals } from "../db/schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the existing complete database schema.
import type * as databaseSchema from "../db/schema";
import {
  publicReleasePlanDigest,
  publicReleaseOperationRef,
  publicReleaseRecordSchema,
  publicReleaseEffects,
} from "./public-release-contract";
import type {
  PublicReleaseAuthority,
  PublicReleasePlan,
  PublicReleaseRecord,
} from "./public-release-contract";
import type { PublicReleaseStore, PublicReleaseRow } from "./public-release-handler";

type Database = PostgresJsDatabase<typeof databaseSchema>;
const unavailable = () => new Error("public_release_unavailable");
const predicate = (authority: PublicReleaseAuthority, operationRef: string) =>
  and(
    eq(builderProvisioningJournals.issuer, authority.issuer),
    eq(builderProvisioningJournals.audience, authority.audience),
    eq(builderProvisioningJournals.workspaceId, authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, operationRef),
    sql`${builderProvisioningJournals.record} ->> 'kind' = 'public-app-release-v1'`,
  );
export const initialPublicReleaseRecord = (plan: PublicReleasePlan): PublicReleaseRecord =>
  publicReleaseRecordSchema.parse({
    kind: "public-app-release-v1",
    plan,
    planDigest: publicReleasePlanDigest(plan),
    bindings: Object.fromEntries(plan.environment.map((entry) => [entry.key, { state: "idle" }])),
    effects: Object.fromEntries(plan.effects.map((effect) => [effect, "idle"])),
  });
const parse = (raw: typeof builderProvisioningJournals.$inferSelect): PublicReleaseRow => {
  const record = publicReleaseRecordSchema.parse(raw.record);
  const { authority } = record.plan;
  if (
    raw.requestDigest !== publicReleasePlanDigest(record.plan) ||
    raw.requestDigest !== record.planDigest ||
    raw.requestId !== publicReleaseOperationRef(record.plan) ||
    raw.issuer !== authority.issuer ||
    raw.audience !== authority.audience ||
    raw.ownerUserId !== authority.ownerUserId ||
    raw.workspaceId !== authority.workspaceId
  ) {
    throw unavailable();
  }
  return { operationRef: raw.requestId, revision: raw.revision, record };
};
export const createPostgresPublicReleaseStore = (database: Database): PublicReleaseStore => {
  const read: PublicReleaseStore["read"] = async (authority, operationRef) => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(authority, operationRef))
      .limit(1);
    return rows[0] === undefined ? undefined : parse(rows[0]);
  };
  return {
    read,
    async reserve(plan) {
      const record = initialPublicReleaseRecord(plan);
      const operationRef = publicReleaseOperationRef(plan);
      const now = new Date();
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...plan.authority,
          requestId: operationRef,
          requestDigest: record.planDigest,
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0] === undefined ? await read(plan.authority, operationRef) : parse(rows[0]);
      if (row === undefined || !isDeepStrictEqual(row.record.plan, record.plan)) {
        throw unavailable();
      }
      return row;
    },
    async compareAndSet(row, input) {
      const record = publicReleaseRecordSchema.parse(input);
      if (
        !isDeepStrictEqual(
          Object.keys(record.bindings).toSorted(),
          record.plan.environment.map((entry) => entry.key).toSorted(),
        ) ||
        record.plan.environment.some(({ key }) => {
          const before = row.record.bindings[key];
          const after = record.bindings[key];
          return (
            before === undefined ||
            after === undefined ||
            (before.state === "applied" && after.state !== "applied") ||
            (before.acceptedEnvId !== undefined && before.acceptedEnvId !== after.acceptedEnvId) ||
            (after.state === "applied" && after.acceptedEnvId === undefined)
          );
        }) ||
        !isDeepStrictEqual(record.plan, row.record.plan) ||
        (row.record.approvalReceipts !== undefined &&
          !isDeepStrictEqual(
            record.approvalReceipts?.slice(0, row.record.approvalReceipts.length),
            row.record.approvalReceipts,
          )) ||
        (record.approvalReceipts !== undefined &&
          new Set(record.approvalReceipts.map((receipt) => receipt.approvedByCallId)).size !==
            record.approvalReceipts.length) ||
        (row.record.executionLease === undefined &&
          record.executionLease !== undefined &&
          record.executionLease.fenceGeneration !== 1) ||
        (row.record.executionLease !== undefined &&
          (record.executionLease === undefined ||
            (record.executionLease.fenceGeneration === row.record.executionLease.fenceGeneration
              ? record.executionLease.leaseId !== row.record.executionLease.leaseId
              : record.executionLease.fenceGeneration !==
                row.record.executionLease.fenceGeneration + 1))) ||
        record.planDigest !== row.record.planDigest ||
        publicReleasePlanDigest(record.plan) !== record.planDigest ||
        publicReleaseEffects.some(
          (effect) =>
            row.record.effects[effect] === "applied" && record.effects[effect] !== "applied",
        ) ||
        (record.observation?.status === "ready" &&
          Object.values(record.effects).some((value) => value !== "applied"))
      ) {
        throw unavailable();
      }
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: row.revision + 1,
          state: record.observation?.status === "ready" ? "settled" : "pending",
          updatedAt: new Date(),
        })
        .where(
          and(
            predicate(record.plan.authority, row.operationRef),
            eq(builderProvisioningJournals.revision, row.revision),
            eq(builderProvisioningJournals.requestDigest, record.planDigest),
          ),
        )
        .returning();
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
  };
};
