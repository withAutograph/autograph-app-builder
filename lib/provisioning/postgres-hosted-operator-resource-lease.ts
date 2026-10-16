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

type Fence = { fenceGeneration: number; leaseId: string; operationRef: string };
type AdvisoryLockParts = { classId: string; objectId: string };

const leaseAuthorityUnavailable = "Protected resource lease authority is unavailable.";
const leaseSessionLost = "Protected resource lease session was lost.";
const staleFence = "Protected resource lease fence is stale.";

const backendIdentitySchema = z.strictObject({
  backend_pid: z.number().int().positive(),
  backend_start: z
    .string()
    .min(1)
    .refine((value) => Number.isFinite(Date.parse(value))),
});
const advisoryLockPartsSchema = z
  .strictObject({
    class_id: z.string().regex(/^\d+$/u),
    object_id: z.string().regex(/^\d+$/u),
  })
  .transform(({ class_id, object_id }) => ({ classId: class_id, objectId: object_id }));
const heldLockSchema = z.strictObject({ held: z.boolean() });

export const hostedOperatorVercelProjectLockKeys = (plan: HostedOperatorPlan, scopeId: string) => {
  const projects = new Set<string>();
  if (
    plan.effects.some((effect) => ["bindings", "delivery", "remove-bindings"].includes(effect.kind))
  ) {
    projects.add(plan.delivery?.projectId ?? plan.selection.projectId);
  }
  if (
    plan.effects.some((effect) => ["gateway-bindings", "gateway-delivery"].includes(effect.kind))
  ) {
    const projectId = plan.gatewayDelivery?.projectId ?? plan.publicGateway?.projectId;
    if (projectId !== undefined) {
      projects.add(projectId);
    }
  }
  return [...projects]
    .map((projectId) =>
      JSON.stringify(["hosted_protected_operator_vercel_project_v1", scopeId, projectId]),
    )
    .toSorted();
};
const lockKey = (plan: HostedOperatorPlan, scopeId: string) => {
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
  keys.push(...hostedOperatorVercelProjectLockKeys(plan, scopeId));
  return [...new Set(keys)].toSorted();
};

const readLeaseSnapshot = async (
  store: HostedRuntimeJournalStore,
  input: ResourceLeaseInput,
  now: () => number,
): Promise<Fence> => {
  const row = await store.read(input);
  const record = row?.record;
  if (record === undefined || record.operator === undefined) {
    throw new Error(leaseAuthorityUnavailable);
  }
  const operator = hostedOperatorRecordSchema.parse(record.operator);
  if (
    record.leaseId === undefined ||
    record.leaseExpiresAt === undefined ||
    Date.parse(record.leaseExpiresAt) <= now() ||
    operator.operationRef !== input.operationRef ||
    operator.fenceGeneration === undefined ||
    operator.planDigest !== operatorPlanDigest(input.plan)
  ) {
    throw new Error(leaseAuthorityUnavailable);
  }
  return {
    fenceGeneration: operator.fenceGeneration,
    leaseId: record.leaseId,
    operationRef: operator.operationRef,
  };
};

const sameFence = (left: Fence, right: Fence) =>
  left.operationRef === right.operationRef &&
  left.leaseId === right.leaseId &&
  left.fenceGeneration === right.fenceGeneration;

/**
 * Holds protected physical-resource locks on one dedicated PostgreSQL session. The callback
 * may perform provider calls without a database transaction; closing the session releases all
 * session locks. This transport is intentionally specific to the protected hosted operator.
 */
export const createPostgresHostedOperatorResourceLease = (input: {
  openLockClient: (onConnectionClosed: () => void) => postgres.Sql;
  store: HostedRuntimeJournalStore;
  now?: () => number;
}) => {
  const now = input.now ?? Date.now;
  return async <T>(
    leaseInput: ResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ): Promise<T> => {
    let connectionClosed = false;
    let leaseActive = false;
    const connectionLost = Promise.withResolvers<never>();
    void connectionLost.promise.catch(() => undefined);
    const database = input.openLockClient(() => {
      connectionClosed = true;
      leaseActive = false;
      connectionLost.reject(new Error(leaseSessionLost));
    });
    leaseActive = true;
    const sessionUnavailable = () => connectionClosed || !leaseActive;
    const requireSession = () => {
      if (sessionUnavailable()) {
        throw new Error(leaseSessionLost);
      }
    };
    const readBackend = async () => {
      const [row] = await database`
        select pid as backend_pid, backend_start::text as backend_start
        from pg_stat_activity
        where pid = pg_backend_pid()
      `;
      return backendIdentitySchema.parse(row);
    };
    try {
      const initialFence = await readLeaseSnapshot(input.store, leaseInput, now);
      requireSession();
      const backend = await readBackend();
      requireSession();
      const lockParts: AdvisoryLockParts[] = [];
      for (const key of lockKey(leaseInput.plan, leaseInput.target.scopeId)) {
        requireSession();
        await database`select pg_advisory_lock(hashtextextended(${key}, 0))`;
        requireSession();
        const [rawParts] = await database`
          select
            ((hashtextextended(${key}, 0) >> 32) & 4294967295)::text as class_id,
            (hashtextextended(${key}, 0) & 4294967295)::text as object_id
        `;
        lockParts.push(advisoryLockPartsSchema.parse(rawParts));
      }

      const assertSameBackend = async () => {
        requireSession();
        let current: z.infer<typeof backendIdentitySchema>;
        try {
          current = await readBackend();
        } catch {
          throw new Error(leaseSessionLost);
        }
        requireSession();
        if (
          current.backend_pid !== backend.backend_pid ||
          current.backend_start !== backend.backend_start
        ) {
          throw new Error(leaseSessionLost);
        }
      };
      const assertHeldLocks = async () => {
        for (const lock of lockParts) {
          requireSession();
          let rawHeld: unknown;
          try {
            [rawHeld] = await database`
              select exists(
                select 1
                from pg_locks
                where pid = ${backend.backend_pid}
                  and locktype = 'advisory'
                  and granted
                  and classid::text = ${lock.classId}
                  and objid::text = ${lock.objectId}
                  and objsubid = 1
                  and mode = 'ExclusiveLock'
              ) as held
            `;
          } catch {
            throw new Error(leaseSessionLost);
          }
          requireSession();
          if (!heldLockSchema.parse(rawHeld).held) {
            throw new Error("Protected resource lease lock was lost.");
          }
        }
      };
      const assertFence = async () => {
        await assertSameBackend();
        await assertHeldLocks();
        const current = await readLeaseSnapshot(input.store, leaseInput, now);
        requireSession();
        if (!sameFence(current, initialFence)) {
          throw new Error(staleFence);
        }
      };

      // Revalidate the same backend, all acquired locks and the durable fence after acquisition.
      await assertFence();
      const callback = run(assertFence);
      const completed = await Promise.race([callback, connectionLost.promise]);
      return completed;
    } finally {
      leaseActive = false;
      // Do not issue pg_advisory_unlock: the client may have disconnected and reconnected.
      // Ending the dedicated pool closes its backend and releases only that backend's locks.
      await database.end({ timeout: 0 });
    }
  };
};
