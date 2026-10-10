/* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Locks acquire and release in deterministic order. */
import type postgres from "postgres";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";

import { hostedOperatorRecordSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";

type ResourceLeaseInput = HostedOperatorContext & {
  operationRef: string;
  plan: HostedOperatorPlan;
};

const leaseAuthorityUnavailable = "Protected resource lease authority is unavailable.";

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
  const lease = createPostgresPhysicalResourceLease({ openLockClient: input.openLockClient });
  return async <T>(
    leaseInput: ResourceLeaseInput,
    run: (assertFence: () => Promise<void>) => Promise<T>,
  ) =>
    await lease(
      {
        lockKeys: lockKey(leaseInput.plan),
        readCurrentFence: async () => await readLeaseSnapshot(input.store, leaseInput, now),
      },
      run,
    );
};
