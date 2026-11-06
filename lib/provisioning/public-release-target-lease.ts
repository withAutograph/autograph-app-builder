import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import { publicReleaseOperationRef } from "./public-release-contract";
import type { PublicReleasePorts } from "./public-release-handler";

/** Serializes native runtime binding with ordinary setup on the same physical project/database. */
export const createPublicReleaseTargetLease = (input: {
  databaseUrl: string;
  store: PublicReleasePorts["store"];
  assertCurrent: PublicReleasePorts["assertAuthorized"];
  lockKeys: (plan: Parameters<PublicReleasePorts["assertAuthorized"]>[1]) => string[];
  assertNoConflictingRelease?: PublicReleasePorts["assertAuthorized"];
  bindFence: (fence: (() => Promise<void>) | undefined) => void;
}): PublicReleasePorts["withTargetLease"] => {
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
  return async (invocation, plan, run) => {
    const operationRef = publicReleaseOperationRef(plan);
    const readCurrentFence = async () => {
      await input.assertCurrent(invocation, plan);
      const row = await input.store.read(invocation.authority, operationRef);
      if (row?.record.executionLease === undefined) {
        throw new Error("public_release_lease_unavailable");
      }
      return { operationRef, ...row.record.executionLease };
    };
    return await physical(
      {
        initializeUnderLock: async () => {
          await input.assertCurrent(invocation, plan);
          await input.assertNoConflictingRelease?.(invocation, plan);
          const row = await input.store.read(invocation.authority, operationRef);
          if (row === undefined) {
            throw new Error("public_release_lease_unavailable");
          }
          const updated = await input.store.compareAndSet(row, {
            ...row.record,
            executionLease: {
              fenceGeneration: (row.record.executionLease?.fenceGeneration ?? 0) + 1,
              leaseId: randomUUID(),
            },
          });
          if (updated === undefined) {
            throw new Error("public_release_lease_unavailable");
          }
        },
        lockKeys: input.lockKeys(plan),
        readCurrentFence,
      },
      async (assertFence) => {
        input.bindFence(assertFence);
        try {
          await assertFence();
          return await run();
        } finally {
          // oxlint-disable-next-line unicorn/no-useless-undefined -- Explicitly revoke the request-private physical fence after the transaction ends.
          input.bindFence(undefined);
        }
      },
    );
  };
};
