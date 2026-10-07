/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Locks acquire and release in deterministic order. */
import type postgres from "postgres";
import { z } from "zod";

import { hostedOperatorRecordSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";

type ResourceLeaseInput = HostedOperatorContext & {
  operationRef: string;
  plan: HostedOperatorPlan;
};

interface AdvisoryLockParts {
  classId: string;
  objectId: string;
}
const leaseAuthorityUnavailable = "Protected resource lease authority is unavailable.";
const leaseSessionLost = "Protected resource lease session was lost.";

const pgTimestamp = z
  .string()
  .min(1)
  .refine((value) => Number.isFinite(Date.parse(value)));
const pgBackendIdentitySchema = z.strictObject({
  backend_pid: z.number().int().positive(),
  backend_start: pgTimestamp,
});
const advisoryLockPartsSchema = z
  .strictObject({
    class_id: z.string().regex(/^\d+$/u),
    object_id: z.string().regex(/^\d+$/u),
  })
  .transform(({ class_id, object_id }) => ({ classId: class_id, objectId: object_id }));
const heldLockSchema = z.strictObject({ held: z.boolean() });
const backendIdentitySql = `select pid as backend_pid, backend_start::text as backend_start
  from pg_stat_activity
  where pid = pg_backend_pid()`;
const readBackendIdentity = (connection: postgres.ReservedSql) =>
  connection.unsafe(backendIdentitySql);
type BackendIdentity = z.infer<typeof pgBackendIdentitySchema>;
class LeaseSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseSessionUnavailableError";
  }
}

const assertSameBackend = async (
  connection: postgres.ReservedSql,
  backend: BackendIdentity,
  connectionClosed: () => boolean,
) => {
  if (connectionClosed()) {
    throw new LeaseSessionUnavailableError(leaseSessionLost);
  }
  try {
    const [rawCurrent] = await readBackendIdentity(connection);
    const current = pgBackendIdentitySchema.parse(rawCurrent);
    if (
      current.backend_pid === backend.backend_pid &&
      current.backend_start === backend.backend_start
    ) {
      return;
    }
  } catch {
    throw new LeaseSessionUnavailableError(leaseSessionLost);
  }
  throw new Error("Protected resource lease session was lost or replaced.");
};

const assertHeldLocks = async (
  connection: postgres.ReservedSql,
  backend: BackendIdentity,
  lockParts: AdvisoryLockParts[],
  connectionClosed: () => boolean,
) => {
  for (const lock of lockParts) {
    if (connectionClosed()) {
      throw new LeaseSessionUnavailableError(leaseSessionLost);
    }
    let rawHeld: unknown;
    try {
      [rawHeld] = await connection`
        select exists(
          select 1
          from pg_locks
          where pid = ${backend.backend_pid}
            and locktype = 'advisory'
            and granted
            and classid::text = ${lock.classId}
            and objid::text = ${lock.objectId}
            and objsubid = 1
        ) as held
      `;
    } catch {
      throw new LeaseSessionUnavailableError(leaseSessionLost);
    }
    if (!heldLockSchema.parse(rawHeld).held) {
      throw new Error("Protected resource lease lock was lost.");
    }
  }
};

const lockKey = (plan: HostedOperatorPlan) => {
  const databases = [plan.authDatabase, plan.appDatabase];
  const keys = [...new Set(databases.map((resource) => resource.database))].map((database) =>
    JSON.stringify([
      "hosted_protected_operator_database_v1",
      plan.neon.projectId,
      plan.neon.branchId,
      database,
    ]),
  );
  if (plan.bootstrap) {
    const roles = databases.flatMap((resource) => [resource.migratorRole, resource.runtimeRole]);
    for (const role of new Set(roles)) {
      keys.push(
        JSON.stringify([
          "hosted_protected_operator_role_v1",
          plan.neon.projectId,
          plan.neon.branchId,
          role,
        ]),
      );
    }
  }
  return keys.toSorted();
};

const readLeaseSnapshot = async (
  store: HostedRuntimeJournalStore,
  input: ResourceLeaseInput,
  now: () => number,
) => {
  const row = await store.read(input);
  const record = row?.record;
  if (record === undefined || record.operator === undefined) {
    throw new Error(leaseAuthorityUnavailable);
  }
  const operator = hostedOperatorRecordSchema.parse(record.operator);
  if (record.leaseId === undefined || record.leaseExpiresAt === undefined) {
    throw new Error(leaseAuthorityUnavailable);
  }
  if (Date.parse(record.leaseExpiresAt) <= now()) {
    throw new Error(leaseAuthorityUnavailable);
  }
  if (operator.operationRef !== input.operationRef || operator.fenceGeneration === undefined) {
    throw new Error(leaseAuthorityUnavailable);
  }
  if (operator.planDigest !== operatorPlanDigest(input.plan)) {
    throw new Error("Protected resource lease authority is unavailable.");
  }
  return {
    fenceGeneration: operator.fenceGeneration,
    leaseId: record.leaseId,
    operationRef: operator.operationRef,
  };
};

/**
 * Locks physical Auth/app database names under the frozen Neon project and branch. Access rows
 * live in Auth, so the Auth database lock covers them. Opaque connection refs and operation IDs
 * never split a physical resource's lock.
 */
export const createPostgresHostedOperatorResourceLease = (input: {
  /**
   * Opens a new dedicated lock pool for each operation, separate from the journal store's pool.
   * The lease closes this client after the operation so a stale reserved handler cannot be
   * reused by a later operation after postgres.js observes a connection loss.
   */
  openLockClient: (onConnectionClosed: () => void) => postgres.Sql;
  store: HostedRuntimeJournalStore;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  return async <T>(
    leaseInput: ResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => {
    let connectionClosed = false;
    const database = input.openLockClient(() => {
      connectionClosed = true;
    });
    try {
      // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Reserve the dedicated session before reading the separate journal pool.
      const connection = await database.reserve();
      let backend: BackendIdentity;
      try {
        const [rawBackend] = await readBackendIdentity(connection);
        backend = pgBackendIdentitySchema.parse(rawBackend);
      } catch {
        throw new Error("Protected resource lease session is unavailable.");
      }
      const snapshot = await readLeaseSnapshot(input.store, leaseInput, now);
      const lockParts: AdvisoryLockParts[] = [];
      for (const key of lockKey(leaseInput.plan)) {
        await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
        const [rawParts] = await connection`
          select
            ((hashtextextended(${key}, 0) >> 32) & 4294967295)::text as class_id,
            (hashtextextended(${key}, 0) & 4294967295)::text as object_id
        `;
        lockParts.push(advisoryLockPartsSchema.parse(rawParts));
      }
      const assertFence = async () => {
        await assertSameBackend(connection, backend, () => connectionClosed);
        await assertHeldLocks(connection, backend, lockParts, () => connectionClosed);
        const current = await readLeaseSnapshot(input.store, leaseInput, now);
        if (
          current.leaseId !== snapshot.leaseId ||
          current.operationRef !== snapshot.operationRef ||
          current.fenceGeneration !== snapshot.fenceGeneration
        ) {
          throw new Error("Protected resource lease fence is stale.");
        }
      };

      await assertFence();
      return await run(assertFence);
    } finally {
      // Closing this operation-owned pool releases every advisory lock, including after an
      // uncertain disconnect. No shared pool handler can be returned to a later lease.
      await database.end({ timeout: 0 });
    }
  };
};
