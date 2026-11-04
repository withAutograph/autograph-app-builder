import postgres from "postgres";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import { appIntegrationCapabilityOperationRef } from "./app-integration-capability-contract";
import type { AppIntegrationCapabilityPorts } from "./app-integration-capability-handler";

/** Serializes native runtime binding with ordinary setup on the same physical project/database. */
export const createAppIntegrationCapabilityTargetLease = (input: {
  databaseUrl: string;
  store: AppIntegrationCapabilityPorts["store"];
  assertCurrent: AppIntegrationCapabilityPorts["assertAuthorized"];
  lockKeys: (plan: Parameters<AppIntegrationCapabilityPorts["assertAuthorized"]>[1]) => string[];
  assertNoConflictingRelease?: AppIntegrationCapabilityPorts["assertAuthorized"];
  bindFence: (fence: (() => Promise<void>) | undefined) => void;
}): AppIntegrationCapabilityPorts["withTargetLease"] => {
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
    const operationRef = appIntegrationCapabilityOperationRef(plan);
    const readCurrentFence = async () => {
      await input.assertCurrent(invocation, plan, true);
      const row = await input.store.read(invocation.authority, operationRef);
      if (row?.record.executionLease === undefined) {
        throw new Error("app_integration_capability_lease_unavailable");
      }
      return { operationRef, ...row.record.executionLease };
    };
    return await physical(
      {
        lockKeys: input.lockKeys(plan),
        initializeUnderLock: async () => {
          await input.assertCurrent(invocation, plan, true);
          await input.assertNoConflictingRelease?.(invocation, plan, true);
          const row = await input.store.read(invocation.authority, operationRef);
          if (row === undefined) {
            throw new Error("app_integration_capability_lease_unavailable");
          }
          const updated = await input.store.claimLease(row);
          if (updated === undefined) {
            throw new Error("app_integration_capability_lease_unavailable");
          }
        },
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
