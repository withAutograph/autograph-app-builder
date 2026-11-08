/* oxlint-disable sonarjs/expression-complexity -- Every persisted owner and resource identity is independently checked before accepting a journal row. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { and, eq, sql } from "drizzle-orm";
import postgres from "postgres";
import type { HostedDatabase as Database } from "../db/hosted-postgres";
import { builderProvisioningJournals } from "../db/schema";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import {
  initialRepositoryProductionRecord,
  repositoryProductionDigest,
  repositoryProductionOperationRef,
  repositoryProductionRecordSchema,
} from "./repository-production-contract";
import type {
  RepositoryProductionIntent,
  RepositoryProductionRow,
  RepositoryProductionScope,
} from "./repository-production-contract";
import type {
  RepositoryProductionStore,
  RepositoryProductionSetupPorts,
} from "./repository-production-setup";

const predicate = (scope: RepositoryProductionScope) =>
  and(
    eq(builderProvisioningJournals.issuer, scope.authority.issuer),
    eq(builderProvisioningJournals.audience, scope.authority.audience),
    eq(builderProvisioningJournals.workspaceId, scope.authority.workspaceId),
    eq(builderProvisioningJournals.ownerUserId, scope.authority.ownerUserId),
    eq(builderProvisioningJournals.requestId, repositoryProductionOperationRef(scope)),
    sql`${builderProvisioningJournals.record}->>'kind' = 'repository-production-setup-v1'`,
  );
const parse = (raw: typeof builderProvisioningJournals.$inferSelect): RepositoryProductionRow => {
  const record = repositoryProductionRecordSchema.parse(raw.record);
  if (
    raw.requestId !== repositoryProductionOperationRef(record.scope) ||
    raw.requestDigest !== repositoryProductionDigest(record.scope) ||
    raw.issuer !== record.scope.authority.issuer ||
    raw.audience !== record.scope.authority.audience ||
    raw.workspaceId !== record.scope.authority.workspaceId ||
    raw.ownerUserId !== record.scope.authority.ownerUserId
  ) {
    throw new Error("repository_production_journal_scope_mismatch");
  }
  return { operationRef: raw.requestId, revision: raw.revision, record };
};
export const createPostgresRepositoryProductionStore = (
  database: Database,
): RepositoryProductionStore => {
  const read: RepositoryProductionStore["read"] = async (scope) => {
    const rows = await database
      .select()
      .from(builderProvisioningJournals)
      .where(predicate(scope))
      .limit(1);
    return rows[0] === undefined ? undefined : parse(rows[0]);
  };
  return {
    read,
    async reserve(input) {
      const record = repositoryProductionRecordSchema.parse(input);
      const now = new Date();
      const rows = await database
        .insert(builderProvisioningJournals)
        .values({
          ...record.scope.authority,
          requestId: repositoryProductionOperationRef(record.scope),
          requestDigest: repositoryProductionDigest(record.scope),
          record,
          revision: 1,
          state: "pending",
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .returning();
      const row = rows[0] === undefined ? await read(record.scope) : parse(rows[0]);
      if (row === undefined || !isDeepStrictEqual(row.record.scope, record.scope)) {
        throw new Error("repository_production_journal_conflict");
      }
      return row;
    },
    async compareAndSet(row, input) {
      const record = repositoryProductionRecordSchema.parse(input);
      if (
        !isDeepStrictEqual(record.scope, row.record.scope) ||
        (row.record.resource !== undefined &&
          !isDeepStrictEqual(record.resource, row.record.resource)) ||
        (row.record.privateState !== undefined &&
          !isDeepStrictEqual(record.privateState, row.record.privateState)) ||
        !isDeepStrictEqual(
          record.workerCheckpoints.slice(0, row.record.workerCheckpoints.length),
          row.record.workerCheckpoints,
        )
      ) {
        throw new Error("repository_production_journal_scope_mismatch");
      }
      const rows = await database
        .update(builderProvisioningJournals)
        .set({
          record,
          revision: row.revision + 1,
          updatedAt: new Date(),
        })
        .where(and(predicate(record.scope), eq(builderProvisioningJournals.revision, row.revision)))
        .returning();
      return rows[0] === undefined ? undefined : parse(rows[0]);
    },
  };
};

/** The same app physical slot spans revisions, session recovery and all access changes. */
export const createRepositoryProductionLease = (input: {
  databaseUrl: string;
  store: RepositoryProductionStore;
  intent: RepositoryProductionIntent;
  assertAuthorized: RepositoryProductionSetupPorts["assertAuthorized"];
}): RepositoryProductionSetupPorts["withLease"] => {
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
  return async (scope, run) =>
    await physical(
      {
        lockKeys: [`repository-production:${scope.repositoryId}:${scope.appId}`],
        initializeUnderLock: async () => {
          await input.assertAuthorized(scope, input.intent);
          const row =
            (await input.store.read(scope)) ??
            (await input.store.reserve(initialRepositoryProductionRecord(scope, input.intent)));
          const saved = await input.store.compareAndSet(row, {
            ...row.record,
            lease: {
              leaseId: randomUUID(),
              fenceGeneration: (row.record.lease?.fenceGeneration ?? 0) + 1,
            },
          });
          if (!saved) {
            throw new Error("repository_production_lease_unavailable");
          }
        },
        readCurrentFence: async () => {
          await input.assertAuthorized(scope, input.intent);
          const row = await input.store.read(scope);
          if (!row?.record.lease) {
            throw new Error("repository_production_lease_unavailable");
          }
          return { operationRef: row.operationRef, ...row.record.lease };
        },
      },
      run,
    );
};
