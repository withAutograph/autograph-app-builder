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

const pgTimestamp = z
  .union([z.date(), z.string().min(1)])
  .transform((value) => (value instanceof Date ? value.getTime() : Date.parse(value)))
  .refine(Number.isFinite);
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
const unlockResultSchema = z.strictObject({ unlocked: z.boolean() });

const lockKey = (plan: HostedOperatorPlan) =>
  [...new Set([plan.authDatabase.database, plan.appDatabase.database])]
    .map((database) =>
      JSON.stringify([
        "hosted_protected_operator_database_v1",
        plan.neon.projectId,
        plan.neon.branchId,
        database,
      ]),
    )
    .toSorted();

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
  database: postgres.Sql;
  store: HostedRuntimeJournalStore;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  return async <T>(
    leaseInput: ResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) => {
    // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Reject stale journal authority before reserving a control-plane session.
    const connection = await input.database.reserve();
    let snapshot: Awaited<ReturnType<typeof readLeaseSnapshot>>;
    try {
      snapshot = await readLeaseSnapshot(input.store, leaseInput, now);
    } catch (error) {
      connection.release();
      throw error;
    }
    const keys = lockKey(leaseInput.plan);
    const acquired: string[] = [];
    const lockParts: AdvisoryLockParts[] = [];
    let sessionLost = false;
    let outcome: { kind: "success"; value: T } | { kind: "failure"; error: unknown };

    try {
      for (const key of keys) {
        await connection`select pg_advisory_lock(hashtextextended(${key}, 0))`;
        acquired.push(key);
        const [rawParts] = await connection`
          select
            ((hashtextextended(${key}, 0) >> 32) & 4294967295)::text as class_id,
            (hashtextextended(${key}, 0) & 4294967295)::text as object_id
        `;
        lockParts.push(advisoryLockPartsSchema.parse(rawParts));
      }
      const [rawBackend] = await connection`
        select pid as backend_pid, backend_start
        from pg_stat_activity
        where pid = pg_backend_pid()
      `;
      let backend: z.infer<typeof pgBackendIdentitySchema>;
      try {
        backend = pgBackendIdentitySchema.parse(rawBackend);
      } catch {
        throw new TypeError("Protected resource lease session is unavailable.");
      }

      const assertFence = async () => {
        let rawCurrentBackend: unknown;
        try {
          [rawCurrentBackend] = await connection`
            select pid as backend_pid, backend_start
            from pg_stat_activity
            where pid = pg_backend_pid()
          `;
        } catch {
          sessionLost = true;
          throw new Error("Protected resource lease session was lost.");
        }
        const currentBackend = pgBackendIdentitySchema.parse(rawCurrentBackend);
        if (
          currentBackend.backend_pid !== backend.backend_pid ||
          currentBackend.backend_start !== backend.backend_start
        ) {
          sessionLost = true;
          throw new Error("Protected resource lease session was replaced.");
        }
        for (const lock of lockParts) {
          const [rawHeld] = await connection`
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
          if (!heldLockSchema.parse(rawHeld).held) {
            throw new Error("Protected resource lease lock was lost.");
          }
        }

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
      outcome = { kind: "success", value: await run(assertFence) };
    } catch (error) {
      outcome = { error, kind: "failure" };
    }

    let unlockFailed = false;
    if (!sessionLost) {
      for (const key of acquired.toReversed()) {
        try {
          const [rawResult] = await connection`
            select pg_advisory_unlock(hashtextextended(${key}, 0)) as unlocked
          `;
          if (!unlockResultSchema.parse(rawResult).unlocked) {
            unlockFailed = true;
          }
        } catch {
          sessionLost = true;
          unlockFailed = true;
          break;
        }
      }
    }
    if (!sessionLost) {
      connection.release();
    }

    if (outcome.kind === "failure") {
      throw outcome.error;
    }
    if (unlockFailed) {
      throw new Error("Protected resource lease could not be released cleanly.");
    }
    return outcome.value;
  };
};
