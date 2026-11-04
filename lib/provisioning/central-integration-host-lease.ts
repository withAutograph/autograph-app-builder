import { randomUUID } from "node:crypto";
import postgres from "postgres";
import { hostedRuntimePostgresOptions } from "../db/postgres-connection-policy";
import { parseProtectedResourceLockDatabaseUrl } from "../db/protected-resource-lock-database-url";
import { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";
import { centralHostOperationRef } from "./central-integration-host-contract";
import type { CentralHostServicePorts } from "./central-integration-host-service";

export const createCentralHostTargetLease = (input: {
  databaseUrl: string;
  store: CentralHostServicePorts["store"];
  assertCurrent: CentralHostServicePorts["assertAuthorized"];
}): CentralHostServicePorts["withTargetLease"] => {
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
    const operationRef = centralHostOperationRef(plan);
    const target = plan.kind === "central-integration-host-setup-v1" ? plan.target : plan.central;
    const setupKeys =
      plan.kind === "central-integration-host-setup-v1"
        ? [
            JSON.stringify([
              "public_release_source_v1",
              plan.source.repositoryId,
              plan.source.operationBranch,
            ]),
            JSON.stringify([
              "hosted_protected_operator_database_v1",
              plan.control.neon.projectId,
              plan.control.neon.branchId,
              plan.control.resource.database,
            ]),
            ...[plan.control.centralRuntimeRole, plan.control.resource.migratorRole].map((role) =>
              JSON.stringify([
                "hosted_protected_operator_role_v1",
                plan.control.neon.projectId,
                plan.control.neon.branchId,
                role,
              ]),
            ),
          ]
        : [];
    const readCurrentFence = async () => {
      await input.assertCurrent(invocation, plan);
      const row = await input.store.read(invocation.authority, operationRef);
      if (row?.record.executionLease === undefined)
        throw new Error("central_host_lease_unavailable");
      return { operationRef, ...row.record.executionLease };
    };
    return await physical(
      {
        lockKeys: [
          JSON.stringify([
            "hosted_protected_operator_vercel_project_v1",
            target.teamId,
            target.projectId,
          ]),
          ...setupKeys,
        ],
        initializeUnderLock: async () => {
          await input.assertCurrent(invocation, plan);
          const row = await input.store.read(invocation.authority, operationRef);
          if (row === undefined) throw new Error("central_host_lease_unavailable");
          const changed = await input.store.compareAndSet(row, {
            ...row.record,
            executionLease: {
              leaseId: randomUUID(),
              fenceGeneration: (row.record.executionLease?.fenceGeneration ?? 0) + 1,
            },
          });
          if (changed === undefined) throw new Error("central_host_lease_unavailable");
        },
        readCurrentFence,
      },
      async (assertCurrent) => {
        await assertCurrent();
        const fence = await readCurrentFence();
        return await run({ ...fence, assertCurrent });
      },
    );
  };
};
