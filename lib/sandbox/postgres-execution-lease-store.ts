import { and, eq, inArray, lte, sql } from "drizzle-orm";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { z } from "zod";

import { sandboxExecutionLeases } from "../db/schema";
import { hostedPrincipalSchema } from "../eve/hosted-auth";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { sandboxExecutionLeaseSchema } from "./execution-lease";
import type {
  AcquireSandboxLeaseResult,
  SandboxExecutionLease,
  SandboxExecutionLeaseStore,
} from "./execution-lease";
import { sandboxExecutionPolicyDigest } from "./execution-policy";

type Database = PostgresJsDatabase<{ sandboxExecutionLeases: typeof sandboxExecutionLeases }>;
type Transaction = Parameters<Parameters<Database["transaction"]>[0]>[0];

export const sandboxLeaseAdvisoryKey = (principal: HostedPrincipal, adapterSessionId: string) =>
  JSON.stringify([
    "sandbox_execution_lease_v1",
    "session",
    principal.issuer,
    principal.audience,
    principal.workspaceId,
    principal.ownerUserId,
    adapterSessionId,
  ]);

const postgresNowEpochMs = async (database: Transaction) => {
  const rows = await database.execute(sql`select clock_timestamp() as "database_now"`);
  const value = rows[0]?.database_now;
  const parsed = value instanceof Date ? value : new Date(value ?? "invalid");
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("PostgreSQL did not return a canonical lease timestamp.");
  }
  return parsed.getTime();
};

const tenantPredicate = (principal: HostedPrincipal, adapterSessionId?: string) =>
  and(
    eq(sandboxExecutionLeases.issuer, principal.issuer),
    eq(sandboxExecutionLeases.audience, principal.audience),
    eq(sandboxExecutionLeases.workspaceId, principal.workspaceId),
    eq(sandboxExecutionLeases.ownerUserId, principal.ownerUserId),
    adapterSessionId === undefined
      ? undefined
      : eq(sandboxExecutionLeases.adapterSessionId, adapterSessionId),
  );

const leaseValues = (lease: SandboxExecutionLease) => ({
  acquiredAt: new Date(lease.acquiredAtEpochMs),
  adapterSessionId: lease.adapterSessionId,
  audience: lease.principal.audience,
  epoch: lease.epoch,
  expiresAt: new Date(lease.expiresAtEpochMs),
  heartbeatAt: new Date(lease.heartbeatAtEpochMs),
  issuer: lease.principal.issuer,
  ownerUserId: lease.principal.ownerUserId,
  policyDigest: lease.policyDigest,
  providerSandboxId: lease.providerSandboxId,
  record: lease,
  releasedAt: lease.releasedAtEpochMs === undefined ? null : new Date(lease.releasedAtEpochMs),
  state: lease.state,
  workspaceId: lease.principal.workspaceId,
});

const sandboxExecutionLeaseRowSchema = z.strictObject({
  acquiredAt: z.date(),
  adapterSessionId: z.string(),
  audience: z.string(),
  epoch: z.number(),
  expiresAt: z.date(),
  heartbeatAt: z.date(),
  issuer: z.string(),
  ownerUserId: z.string(),
  policyDigest: z.string(),
  providerSandboxId: z.string(),
  record: z.unknown(),
  releasedAt: z.date().nullable(),
  state: z.enum(["active", "released", "orphaned"]),
  workspaceId: z.string(),
});

export const parseSandboxExecutionLeaseRow = (
  input: z.input<typeof sandboxExecutionLeaseRowSchema>,
) => {
  const row = sandboxExecutionLeaseRowSchema.parse(input);
  const lease = sandboxExecutionLeaseSchema.parse(row.record);
  const rowBindings = [
    [row.issuer, lease.principal.issuer],
    [row.audience, lease.principal.audience],
    [row.workspaceId, lease.principal.workspaceId],
    [row.ownerUserId, lease.principal.ownerUserId],
    [row.adapterSessionId, lease.adapterSessionId],
    [row.providerSandboxId, lease.providerSandboxId],
    [row.epoch, lease.epoch],
    [row.state, lease.state],
    [row.policyDigest, lease.policyDigest],
    [row.acquiredAt.getTime(), lease.acquiredAtEpochMs],
    [row.heartbeatAt.getTime(), lease.heartbeatAtEpochMs],
    [row.expiresAt.getTime(), lease.expiresAtEpochMs],
    [row.releasedAt?.getTime() ?? undefined, lease.releasedAtEpochMs],
  ];
  if (rowBindings.some(([stored, canonical]) => stored !== canonical)) {
    throw new Error("Sandbox execution lease row is not canonically bound.");
  }
  return lease;
};

const lockExactLease = async (
  database: Transaction,
  principal: HostedPrincipal,
  adapterSessionId: string,
) => {
  const key = sandboxLeaseAdvisoryKey(principal, adapterSessionId);
  await database.execute(sql`select pg_advisory_xact_lock(hashtextextended(${key}, 0))`);
};

const exactLease = async (
  database: Transaction,
  principal: HostedPrincipal,
  adapterSessionId: string,
  forUpdate = false,
) => {
  const query = database
    .select()
    .from(sandboxExecutionLeases)
    .where(tenantPredicate(principal, adapterSessionId))
    .limit(1);
  const rows = forUpdate ? await query.for("update") : await query;
  return rows[0] === undefined ? null : parseSandboxExecutionLeaseRow(rows[0]);
};

const isCurrentLease = (
  lease: SandboxExecutionLease | null,
  input: Parameters<SandboxExecutionLeaseStore["assertCurrent"]>[0],
  nowEpochMs: number,
) => {
  if (lease === null) {
    return false;
  }
  const matchesIdentity =
    lease.epoch === input.epoch &&
    lease.providerSandboxId === input.providerSandboxId &&
    lease.policyDigest === input.policyDigest;
  return lease.state === "active" && lease.expiresAtEpochMs > nowEpochMs && matchesIdentity;
};

export const createPostgresSandboxExecutionLeaseStore = (
  database: Database,
): SandboxExecutionLeaseStore => ({
  async acquire(input): Promise<AcquireSandboxLeaseResult> {
    const principal = hostedPrincipalSchema.parse(input.principal);
    const policyDigest = sandboxExecutionPolicyDigest(input.policy);
    return await database.transaction(async (transaction) => {
      await lockExactLease(transaction, principal, input.adapterSessionId);
      const [nowEpochMs, existing] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, principal, input.adapterSessionId, true),
      ]);
      if (existing?.state === "active" && existing.expiresAtEpochMs > nowEpochMs) {
        if (
          existing.providerSandboxId !== input.providerSandboxId ||
          existing.policyDigest !== policyDigest
        ) {
          throw new Error("An active sandbox lease is bound to different inputs.");
        }
        return { disposition: "existing", lease: existing };
      }

      if (existing?.state === "orphaned") {
        return {
          disposition: "rejected",
          reason: "recovery-in-progress",
        };
      }

      const lease = sandboxExecutionLeaseSchema.parse({
        acquiredAtEpochMs: nowEpochMs,
        adapterSessionId: input.adapterSessionId,
        epoch: (existing?.epoch ?? 0) + 1,
        expiresAtEpochMs: nowEpochMs + input.policy.lease.ttlMs,
        heartbeatAtEpochMs: nowEpochMs,
        policyDigest,
        principal,
        providerSandboxId: input.providerSandboxId,
        state: "active",
        version: 1,
      });
      const values = leaseValues(lease);
      const rows =
        existing === null
          ? await transaction.insert(sandboxExecutionLeases).values(values).returning()
          : await transaction
              .update(sandboxExecutionLeases)
              .set(values)
              .where(tenantPredicate(principal, input.adapterSessionId))
              .returning();
      if (rows.length !== 1) {
        throw new Error("Sandbox execution lease was not durable.");
      }
      return {
        disposition: "acquired",
        lease: parseSandboxExecutionLeaseRow(rows[0]),
      };
    });
  },

  async assertCurrent(input) {
    return await database.transaction(async (transaction) => {
      const [nowEpochMs, lease] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, input.principal, input.adapterSessionId),
      ]);
      if (!isCurrentLease(lease, input, nowEpochMs)) {
        throw new Error("The sandbox execution lease is stale or unavailable.");
      }
      return lease;
    });
  },

  async claimExpired(input) {
    return await database.transaction(async (transaction) => {
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
      const claimed = await Promise.all(
        rows.map(async (row) => {
          const current = parseSandboxExecutionLeaseRow(row);
          const lease = sandboxExecutionLeaseSchema.parse({
            ...current,
            epoch: current.state === "orphaned" ? current.epoch + 1 : current.epoch,
            state: "orphaned",
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
          return updated.length === 1 ? parseSandboxExecutionLeaseRow(updated[0]) : null;
        }),
      );
      return claimed.filter((lease) => lease !== null);
    });
  },

  async heartbeat(input) {
    return await database.transaction(async (transaction) => {
      const [nowEpochMs, current] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, input.principal, input.adapterSessionId, true),
      ]);
      if (
        current === null ||
        current.state !== "active" ||
        current.epoch !== input.epoch ||
        current.expiresAtEpochMs <= nowEpochMs
      ) {
        throw new Error("The sandbox execution lease is stale or unavailable.");
      }
      const lease = sandboxExecutionLeaseSchema.parse({
        ...current,
        expiresAtEpochMs: nowEpochMs + (current.expiresAtEpochMs - current.heartbeatAtEpochMs),
        heartbeatAtEpochMs: nowEpochMs,
      });
      const rows = await transaction
        .update(sandboxExecutionLeases)
        .set(leaseValues(lease))
        .where(tenantPredicate(input.principal, input.adapterSessionId))
        .returning();
      if (rows.length !== 1) {
        throw new Error("Lease heartbeat was not durable.");
      }
      return parseSandboxExecutionLeaseRow(rows[0]);
    });
  },

  async release(input) {
    return await database.transaction(async (transaction) => {
      const [nowEpochMs, current] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, input.principal, input.adapterSessionId, true),
      ]);
      if (current === null || current.epoch !== input.epoch) {
        throw new Error("The sandbox execution lease epoch is stale.");
      }
      if (current.state !== "active") {
        return current;
      }
      const lease = sandboxExecutionLeaseSchema.parse({
        ...current,
        releaseReason: input.reason,
        releasedAtEpochMs: nowEpochMs,
        state: "released",
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
      if (rows.length !== 1) {
        throw new Error("Lease release was not durable.");
      }
      return parseSandboxExecutionLeaseRow(rows[0]);
    });
  },

  async releaseCurrent(input) {
    return await database.transaction(async (transaction) => {
      const [nowEpochMs, current] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, input.principal, input.adapterSessionId, true),
      ]);
      if (current === null) {
        return null;
      }
      if (
        current.providerSandboxId !== input.providerSandboxId ||
        current.policyDigest !== input.policyDigest
      ) {
        throw new Error("The sandbox execution lease authority is stale.");
      }
      if (current.state !== "active") {
        return current;
      }
      const lease = sandboxExecutionLeaseSchema.parse({
        ...current,
        releaseReason: input.reason,
        releasedAtEpochMs: nowEpochMs,
        state: "released",
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
      if (rows.length !== 1) {
        throw new Error("Lease release was not durable.");
      }
      return parseSandboxExecutionLeaseRow(rows[0]);
    });
  },

  async settleRecovery(input) {
    return await database.transaction(async (transaction) => {
      const [nowEpochMs, current] = await Promise.all([
        postgresNowEpochMs(transaction),
        exactLease(transaction, input.lease.principal, input.lease.adapterSessionId, true),
      ]);
      if (current === null || current.state !== "orphaned" || current.epoch !== input.lease.epoch) {
        return null;
      }
      if (input.providerOutcome === "stop-failed") {
        return current;
      }
      const lease = sandboxExecutionLeaseSchema.parse({
        ...current,
        releaseReason: "expired",
        releasedAtEpochMs: nowEpochMs,
        state: "released",
      });
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
      if (rows.length !== 1) {
        throw new Error("Orphan recovery settlement was not durable.");
      }
      return parseSandboxExecutionLeaseRow(rows[0]);
    });
  },
});
