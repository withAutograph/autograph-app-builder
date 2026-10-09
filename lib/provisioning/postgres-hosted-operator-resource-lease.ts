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
const readBackendIdentity = (connection: postgres.TransactionSql) =>
  connection.unsafe(backendIdentitySql);
type BackendIdentity = z.infer<typeof pgBackendIdentitySchema>;
class LeaseSessionUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LeaseSessionUnavailableError";
  }
}

const assertSameBackend = async (
  connection: postgres.TransactionSql,
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
      !connectionClosed() &&
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
  connection: postgres.TransactionSql,
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
    if (connectionClosed()) {
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
 * never split a physical resource's lock. Transaction locks retain the same backend through
 * a transaction pooler. The separate journal pool commits checkpoints before resource effects.
 */
export const createPostgresHostedOperatorResourceLease = (input: {
  /**
   * Opens a new dedicated lock pool for each operation, separate from the journal store's pool.
   * Transaction completion releases the locks before the client is closed. A callback retained
   * after transaction completion or connection loss must never regain lease authority.
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
    let transactionActive = false;
    const database = input.openLockClient(() => {
      connectionClosed = true;
      transactionActive = false;
    });
    const leaseClosed = () => connectionClosed || !transactionActive;
    try {
      const completed = await database.begin(async (connection) => {
        transactionActive = !connectionClosed;
        try {
          if (leaseClosed()) {
            throw new LeaseSessionUnavailableError(leaseSessionLost);
          }
          // Provider/installer awaits may exceed the shared 30-second idle transaction timeout.
          // Only this lock transaction overrides it; the durable journal lease still expires.
          await connection`set local idle_in_transaction_session_timeout = 0`;
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
            await connection`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`;
            const [rawParts] = await connection`
              select
                ((hashtextextended(${key}, 0) >> 32) & 4294967295)::text as class_id,
                (hashtextextended(${key}, 0) & 4294967295)::text as object_id
            `;
            lockParts.push(advisoryLockPartsSchema.parse(rawParts));
          }
          const assertFence = async () => {
            await assertSameBackend(connection, backend, leaseClosed);
            await assertHeldLocks(connection, backend, lockParts, leaseClosed);
            const current = await readLeaseSnapshot(input.store, leaseInput, now);
            if (leaseClosed()) {
              throw new LeaseSessionUnavailableError(leaseSessionLost);
            }
            if (
              current.leaseId !== snapshot.leaseId ||
              current.operationRef !== snapshot.operationRef ||
              current.fenceGeneration !== snapshot.fenceGeneration
            ) {
              throw new Error("Protected resource lease fence is stale.");
            }
          };

          await assertFence();
          // Keep arbitrary callback results outside postgres.js's array-of-promises handling.
          return { value: await run(assertFence) };
        } finally {
          transactionActive = false;
        }
      });
      return completed.value;
    } finally {
      transactionActive = false;
      // BEGIN owns COMMIT/ROLLBACK and transaction-lock release; closing is transport cleanup.
      await database.end({ timeout: 0 });
    }
  };
};
