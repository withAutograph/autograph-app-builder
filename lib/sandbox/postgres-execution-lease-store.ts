import { and, count, eq, gt, inArray, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";

import * as databaseSchema from "../db/schema";
import { sandboxExecutionLeases } from "../db/schema";
import {
  hostedPrincipalSchema,
  type HostedPrincipal,
} from "../eve/hosted-auth";
import {
  sandboxExecutionLeaseSchema,
  type AcquireSandboxLeaseResult,
  type SandboxExecutionLease,
  type SandboxExecutionLeaseStore,
} from "./execution-lease";
import { sandboxExecutionPolicyDigest } from "./execution-policy";

type Database = PostgresJsDatabase<typeof databaseSchema>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

async function postgresNowEpochMs(database: Transaction) {
  const rows = await database.execute(
    sql`select clock_timestamp() as "database_now"`,
  );
  const result = rows as unknown as
    | readonly [{ database_now: Date | string }]
    | { rows: readonly [{ database_now: Date | string }] };
  const value =
    "rows" in result ? result.rows[0]?.database_now : result[0]?.database_now;
  const parsed = value instanceof Date ? value : new Date(value ?? "invalid");
  if (!Number.isFinite(parsed.getTime())) {
    throw new Error("PostgreSQL did not return a canonical lease timestamp.");
  }
  return parsed.getTime();
}

function tenantPredicate(
  principal: HostedPrincipal,
  adapterSessionId?: string,
) {
  return and(
    eq(sandboxExecutionLeases.issuer, principal.issuer),
    eq(sandboxExecutionLeases.audience, principal.audience),
    eq(sandboxExecutionLeases.workspaceId, principal.workspaceId),
    eq(sandboxExecutionLeases.ownerUserId, principal.ownerUserId),
    adapterSessionId === undefined
      ? undefined
      : eq(sandboxExecutionLeases.adapterSessionId, adapterSessionId),
  );
}

function workspacePredicate(principal: HostedPrincipal) {
  return and(
    eq(sandboxExecutionLeases.issuer, principal.issuer),
    eq(sandboxExecutionLeases.audience, principal.audience),
    eq(sandboxExecutionLeases.workspaceId, principal.workspaceId),
  );
}

function leaseValues(lease: SandboxExecutionLease) {
  return {
    issuer: lease.principal.issuer,
    audience: lease.principal.audience,
    workspaceId: lease.principal.workspaceId,
    ownerUserId: lease.principal.ownerUserId,
    adapterSessionId: lease.adapterSessionId,
    providerSandboxId: lease.providerSandboxId,
    epoch: lease.epoch,
    state: lease.state,
    policyDigest: lease.policyDigest,
    record: lease,
    acquiredAt: new Date(lease.acquiredAtEpochMs),
    heartbeatAt: new Date(lease.heartbeatAtEpochMs),
    expiresAt: new Date(lease.expiresAtEpochMs),
    releasedAt:
      lease.releasedAtEpochMs === undefined
        ? null
        : new Date(lease.releasedAtEpochMs),
  };
}

export function parseSandboxExecutionLeaseRow(input: unknown) {
  const row = input as ReturnType<typeof leaseValues>;
  const lease = sandboxExecutionLeaseSchema.parse(row.record);
  if (
    row.issuer !== lease.principal.issuer ||
    row.audience !== lease.principal.audience ||
    row.workspaceId !== lease.principal.workspaceId ||
    row.ownerUserId !== lease.principal.ownerUserId ||
    row.adapterSessionId !== lease.adapterSessionId ||
    row.providerSandboxId !== lease.providerSandboxId ||
    row.epoch !== lease.epoch ||
    row.state !== lease.state ||
    row.policyDigest !== lease.policyDigest ||
    row.acquiredAt.getTime() !== lease.acquiredAtEpochMs ||
    row.heartbeatAt.getTime() !== lease.heartbeatAtEpochMs ||
    row.expiresAt.getTime() !== lease.expiresAtEpochMs ||
    (row.releasedAt?.getTime() ?? undefined) !== lease.releasedAtEpochMs
  ) {
    throw new Error("Sandbox execution lease row is not canonically bound.");
  }
  return lease;
}

async function lockAdmissionScopes(
  database: Transaction,
  principal: HostedPrincipal,
) {
  for (const scope of ["workspace", "subject"] as const) {
    const key = sandboxLeaseAdvisoryKey(scope, principal);
    await database.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`,
    );
  }
}

async function exactLease(
  database: Transaction,
  principal: HostedPrincipal,
  adapterSessionId: string,
  forUpdate = false,
) {
  const query = database
    .select()
    .from(sandboxExecutionLeases)
    .where(tenantPredicate(principal, adapterSessionId))
    .limit(1);
  const rows = forUpdate ? await query.for("update") : await query;
  return rows[0] === undefined ? null : parseSandboxExecutionLeaseRow(rows[0]);
}

export function createPostgresSandboxExecutionLeaseStore(
  database: Database,
): SandboxExecutionLeaseStore {
  return {
    async acquire(input): Promise<AcquireSandboxLeaseResult> {
      const principal = hostedPrincipalSchema.parse(input.principal);
      const policyDigest = sandboxExecutionPolicyDigest(input.policy);
      return database.transaction(async (transaction) => {
        await lockAdmissionScopes(transaction, principal);
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const existing = await exactLease(
          transaction,
          principal,
          input.adapterSessionId,
          true,
        );
        if (
          existing?.state === "active" &&
          existing.expiresAtEpochMs > nowEpochMs
        ) {
          if (
            existing.providerSandboxId !== input.providerSandboxId ||
            existing.policyDigest !== policyDigest
          ) {
            throw new Error(
              "An active sandbox lease is bound to different inputs.",
            );
          }
          return { disposition: "existing", lease: existing };
        }

        if (existing?.state === "orphaned") {
          return {
            disposition: "rejected",
            reason: "recovery-in-progress",
          };
        }

        const now = new Date(nowEpochMs);
        const activePredicate = and(
          workspacePredicate(principal),
          eq(sandboxExecutionLeases.state, "active"),
          gt(sandboxExecutionLeases.expiresAt, now),
        );
        const [subjectCount, workspaceCount] = await Promise.all([
          transaction
            .select({ value: count() })
            .from(sandboxExecutionLeases)
            .where(and(activePredicate, tenantPredicate(principal))),
          transaction
            .select({ value: count() })
            .from(sandboxExecutionLeases)
            .where(activePredicate),
        ]);
        if (
          (subjectCount[0]?.value ?? 0) >=
          input.policy.lease.maxActivePerSubject
        ) {
          return { disposition: "rejected", reason: "subject-limit" };
        }
        if (
          (workspaceCount[0]?.value ?? 0) >=
          input.policy.lease.maxActivePerWorkspace
        ) {
          return { disposition: "rejected", reason: "workspace-limit" };
        }
        const lease = sandboxExecutionLeaseSchema.parse({
          version: 1,
          principal,
          adapterSessionId: input.adapterSessionId,
          providerSandboxId: input.providerSandboxId,
          epoch: (existing?.epoch ?? 0) + 1,
          state: "active",
          policyDigest,
          acquiredAtEpochMs: nowEpochMs,
          heartbeatAtEpochMs: nowEpochMs,
          expiresAtEpochMs: nowEpochMs + input.policy.lease.ttlMs,
        });
        const values = leaseValues(lease);
        const rows =
          existing === null
            ? await transaction
                .insert(sandboxExecutionLeases)
                .values(values)
                .returning()
            : await transaction
                .update(sandboxExecutionLeases)
                .set(values)
                .where(tenantPredicate(principal, input.adapterSessionId))
                .returning();
        if (rows.length !== 1)
          throw new Error("Sandbox execution lease was not durable.");
        return {
          disposition: "acquired",
          lease: parseSandboxExecutionLeaseRow(rows[0]),
        };
      });
    },

    async assertCurrent(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const lease = await exactLease(
          transaction,
          input.principal,
          input.adapterSessionId,
        );
        if (
          lease === null ||
          lease.state !== "active" ||
          lease.expiresAtEpochMs <= nowEpochMs ||
          lease.epoch !== input.epoch ||
          lease.providerSandboxId !== input.providerSandboxId ||
          lease.policyDigest !== input.policyDigest
        ) {
          throw new Error(
            "The sandbox execution lease is stale or unavailable.",
          );
        }
        return lease;
      });
    },

    heartbeat(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const current = await exactLease(
          transaction,
          input.principal,
          input.adapterSessionId,
          true,
        );
        if (
          current === null ||
          current.state !== "active" ||
          current.epoch !== input.epoch ||
          current.expiresAtEpochMs <= nowEpochMs
        ) {
          throw new Error(
            "The sandbox execution lease is stale or unavailable.",
          );
        }
        const lease = sandboxExecutionLeaseSchema.parse({
          ...current,
          heartbeatAtEpochMs: nowEpochMs,
          expiresAtEpochMs:
            nowEpochMs +
            (current.expiresAtEpochMs - current.heartbeatAtEpochMs),
        });
        const rows = await transaction
          .update(sandboxExecutionLeases)
          .set(leaseValues(lease))
          .where(tenantPredicate(input.principal, input.adapterSessionId))
          .returning();
        if (rows.length !== 1)
          throw new Error("Lease heartbeat was not durable.");
        return parseSandboxExecutionLeaseRow(rows[0]);
      });
    },

    release(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const current = await exactLease(
          transaction,
          input.principal,
          input.adapterSessionId,
          true,
        );
        if (current === null || current.epoch !== input.epoch)
          throw new Error("The sandbox execution lease epoch is stale.");
        if (current.state !== "active") return current;
        const lease = sandboxExecutionLeaseSchema.parse({
          ...current,
          state: "released",
          releasedAtEpochMs: nowEpochMs,
          releaseReason: input.reason,
        });
        const rows = await transaction
          .update(sandboxExecutionLeases)
          .set(leaseValues(lease))
          .where(
            and(
              tenantPredicate(input.principal, input.adapterSessionId),
              eq(sandboxExecutionLeases.epoch, current.epoch),
              eq(sandboxExecutionLeases.state, "active"),
            ),
          )
          .returning();
        if (rows.length !== 1)
          throw new Error("Lease release was not durable.");
        return parseSandboxExecutionLeaseRow(rows[0]);
      });
    },

    releaseCurrent(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const current = await exactLease(
          transaction,
          input.principal,
          input.adapterSessionId,
          true,
        );
        if (current === null) return null;
        if (
          current.providerSandboxId !== input.providerSandboxId ||
          current.policyDigest !== input.policyDigest
        ) {
          throw new Error("The sandbox execution lease authority is stale.");
        }
        if (current.state !== "active") return current;
        const lease = sandboxExecutionLeaseSchema.parse({
          ...current,
          state: "released",
          releasedAtEpochMs: nowEpochMs,
          releaseReason: input.reason,
        });
        const rows = await transaction
          .update(sandboxExecutionLeases)
          .set(leaseValues(lease))
          .where(
            and(
              tenantPredicate(input.principal, input.adapterSessionId),
              eq(sandboxExecutionLeases.epoch, current.epoch),
              eq(sandboxExecutionLeases.state, "active"),
            ),
          )
          .returning();
        if (rows.length !== 1)
          throw new Error("Lease release was not durable.");
        return parseSandboxExecutionLeaseRow(rows[0]);
      });
    },

    claimExpired(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const rows = await transaction
          .select()
          .from(sandboxExecutionLeases)
          .where(
            and(
              inArray(sandboxExecutionLeases.state, ["active", "orphaned"]),
              lte(sandboxExecutionLeases.expiresAt, new Date(nowEpochMs)),
            ),
          )
          .orderBy(sandboxExecutionLeases.expiresAt)
          .limit(input.limit)
          .for("update", { skipLocked: true });
        const claimed: SandboxExecutionLease[] = [];
        for (const row of rows) {
          const current = parseSandboxExecutionLeaseRow(row);
          const lease = sandboxExecutionLeaseSchema.parse({
            ...current,
            state: "orphaned",
            epoch:
              current.state === "orphaned" ? current.epoch + 1 : current.epoch,
          });
          const updated = await transaction
            .update(sandboxExecutionLeases)
            .set(leaseValues(lease))
            .where(
              and(
                tenantPredicate(current.principal, current.adapterSessionId),
                eq(sandboxExecutionLeases.epoch, current.epoch),
                eq(sandboxExecutionLeases.state, current.state),
              ),
            )
            .returning();
          if (updated.length === 1)
            claimed.push(parseSandboxExecutionLeaseRow(updated[0]));
        }
        return claimed;
      });
    },

    settleRecovery(input) {
      return database.transaction(async (transaction) => {
        const nowEpochMs = await postgresNowEpochMs(transaction);
        const current = await exactLease(
          transaction,
          input.lease.principal,
          input.lease.adapterSessionId,
          true,
        );
        if (
          current === null ||
          current.state !== "orphaned" ||
          current.epoch !== input.lease.epoch
        )
          return null;
        const lease = sandboxExecutionLeaseSchema.parse(
          input.providerOutcome === "stopped"
            ? {
                ...current,
                state: "released",
                releasedAtEpochMs: nowEpochMs,
                releaseReason: "expired",
              }
            : { ...current, state: "active" },
        );
        const rows = await transaction
          .update(sandboxExecutionLeases)
          .set(leaseValues(lease))
          .where(
            and(
              tenantPredicate(current.principal, current.adapterSessionId),
              eq(sandboxExecutionLeases.epoch, current.epoch),
              eq(sandboxExecutionLeases.state, "orphaned"),
            ),
          )
          .returning();
        if (rows.length !== 1)
          throw new Error("Orphan recovery settlement was not durable.");
        return parseSandboxExecutionLeaseRow(rows[0]);
      });
    },
  };
}

export function sandboxLeaseAdvisoryKey(
  scope: "workspace" | "subject",
  principal: HostedPrincipal,
) {
  return JSON.stringify([
    "sandbox_execution_lease_v1",
    scope,
    principal.issuer,
    principal.audience,
    principal.workspaceId,
    ...(scope === "subject" ? [principal.ownerUserId] : []),
  ]);
}
