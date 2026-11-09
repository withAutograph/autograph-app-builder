/* oxlint-disable sonarjs/expression-complexity -- Immutable tenant, resource and approved plan bindings are checked as one persisted security boundary. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import type { HostedDatabase } from "../db/hosted-postgres";
import { builderProvisioningJournals } from "../db/schema";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import {
  authSchemaRolloutDigest,
  authSchemaRolloutRecordSchema,
  authSchemaRolloutOperationRef,
} from "./production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutRow,
  AuthSchemaRolloutScope,
} from "./production-auth-schema-rollout-contract";
import type {
  AuthSchemaRolloutPorts,
  AuthSchemaRolloutStore,
} from "./production-auth-schema-rollout";

const predicate = (scope: AuthSchemaRolloutScope, operationRef: string) =>
  and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, operationRef),
    sql`${builderProvisioningJournals.record}->>'kind' = 'production-auth-schema-rollout-v1'`,
  );
const parse = (raw: typeof builderProvisioningJournals.$inferSelect): AuthSchemaRolloutRow => {
  const record = authSchemaRolloutRecordSchema.parse(raw.record);
  const { plan } = record;
  if (
    raw.requestId !== plan.operationRef ||
    raw.requestDigest !== plan.planDigest ||
    plan.operationRef !== authSchemaRolloutOperationRef(plan.scope, plan.planDigest) ||
    authSchemaRolloutDigest(record.operatorPlan) !== plan.planDigest ||
    raw.issuer !== plan.scope.authority.issuer ||
    raw.audience !== plan.scope.authority.audience ||
    raw.workspaceId !== plan.scope.authority.workspaceId ||
    raw.ownerUserId !== plan.scope.authority.ownerUserId
  ) {
    throw new Error("auth_schema_rollout_journal_mismatch");
  }
  return { revision: raw.revision, record };
};
export const createPostgresAuthSchemaRolloutStore = (
  database: HostedDatabase,
): AuthSchemaRolloutStore => {
  const read: AuthSchemaRolloutStore["read"] = async (scope, operationRef) => {
    const [raw] = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(scope, operationRef))
      .limit(1);
    return raw === undefined ? undefined : parse(raw);
  };
  return {
    read,
    async reserve(input) {
      const record = authSchemaRolloutRecordSchema.parse(input);
      const { plan } = record;
      const now = new Date();
      const [raw] = await database
        .insert(builderProvisioningJournals)
        .values({
          ...plan.scope.authority,
          requestId: plan.operationRef,
          requestDigest: plan.planDigest,
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = raw === undefined ? await read(plan.scope, plan.operationRef) : parse(raw);
      if (!row || !isDeepStrictEqual(row.record.plan, plan)) {
        throw new Error("auth_schema_rollout_journal_conflict");
      }
      return row;
    },
    async compareAndSet(row, input) {
      const record = authSchemaRolloutRecordSchema.parse(input);
      if (
        !(["plan", "runtime", "proposal", "operatorPlan"] as const).every((key) =>
          isDeepStrictEqual(record[key], row.record[key]),
        ) ||
        (row.record.approval && !isDeepStrictEqual(row.record.approval, record.approval)) ||
        !isDeepStrictEqual(
          record.checkpoints.slice(0, row.record.checkpoints.length),
          row.record.checkpoints,
        ) ||
        (row.record.state !== "planned" && record.state === "planned") ||
        (row.record.state === "ready" && record.state !== "ready")
      ) {
        throw new Error("auth_schema_rollout_journal_mismatch");
      }
      const [raw] = await database
        .update(builderProvisioningJournals)
        .set({ record, revision: row.revision + 1, updatedAt: new Date() })
        .where(
          and(
            predicate(record.plan.scope, record.plan.operationRef),
            eq(builderProvisioningJournals.revision, row.revision),
          ),
        )
        .returning();
      return raw === undefined ? undefined : parse(raw);
    },
  };
};

/** Physical Auth identity spans operators, sessions and planned rollout revisions. */
export const authSchemaRolloutLockKey = (row: AuthSchemaRolloutRow) => {
  const { resource } = row.record.plan;
  return `auth-schema:${resource.neon.projectId}:${resource.neon.branchId}:${resource.hostname}:${resource.port}:${resource.database}`;
};
export const createAuthSchemaRolloutLease = (input: {
  databaseUrl: string;
  store: AuthSchemaRolloutStore;
  assertCurrent: (row: AuthSchemaRolloutRow) => Promise<void>;
}): AuthSchemaRolloutPorts["withLease"] => {
  const physical = createPostgresPhysicalResourceLease({
    openLockClient: (onclose) =>
      postgres(parseProtectedResourceLockDatabaseUrl(input.databaseUrl), {
        ...hostedRuntimePostgresOptions,
        idle_timeout: 0,
        max: 1,
        max_lifetime: 0,
        onclose,
      }),
  });
  return async (initial, run) => {
    const { scope, operationRef } = initial.record.plan;
    return await physical(
      {
        lockKeys: [authSchemaRolloutLockKey(initial)],
        tryAcquire: true,
        initializeUnderLock: async () => {
          const row = await input.store.read(scope, operationRef);
          if (!row) {
            throw new Error("auth_schema_rollout_lease_unavailable");
          }
          await input.assertCurrent(row);
          const claimed = await input.store.compareAndSet(row, {
            ...row.record,
            lease: {
              leaseId: randomUUID(),
              fenceGeneration: (row.record.lease?.fenceGeneration ?? 0) + 1,
            },
          });
          if (!claimed) {
            throw new Error("auth_schema_rollout_lease_unavailable");
          }
        },
        readCurrentFence: async () => {
          const row = await input.store.read(scope, operationRef);
          if (!row?.record.lease) {
            throw new Error("auth_schema_rollout_lease_unavailable");
          }
          await input.assertCurrent(row);
          return { operationRef, ...row.record.lease };
        },
      },
      run,
    );
  };
};
