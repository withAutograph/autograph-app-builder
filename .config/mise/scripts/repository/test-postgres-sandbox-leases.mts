import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as databaseSchema from "../../../../lib/db/schema";
import type { HostedPrincipal } from "../../../../lib/eve/hosted-auth";
import {
  reconcileExpiredSandboxLeases,
  type SandboxExecutionLease,
} from "../../../../lib/sandbox/execution-lease";
import {
  SANDBOX_EXECUTION_POLICY,
  sandboxExecutionPolicyDigest,
} from "../../../../lib/sandbox/execution-policy";
import { createPostgresSandboxExecutionLeaseStore } from "../../../../lib/sandbox/postgres-execution-lease-store";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index < 0 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0)
    throw new Error(`Missing ${name}.`);
  return value;
}

const host = argument("--host");
const port = Number(argument("--port"));
if (!Number.isInteger(port) || port < 1 || port > 65_535)
  throw new Error("Invalid PostgreSQL port.");

const client = postgres({
  database: "postgres",
  host,
  max: 8,
  port,
  username: "postgres",
});

const database = drizzle(client, { schema: databaseSchema });
const store = createPostgresSandboxExecutionLeaseStore(database);
const policy = SANDBOX_EXECUTION_POLICY;
const policyDigest = sandboxExecutionPolicyDigest();

function principal(ownerUserId: string, workspaceId = "workspace_1") {
  return {
    issuer: "https://builder.example.test/api/auth",
    audience: "https://builder.example.test/mcp",
    workspaceId,
    ownerUserId,
    scopes: ["eve:start"],
  } satisfies HostedPrincipal;
}

function acquire(owner: string, session: string, workspace = "workspace_1") {
  return store.acquire({
    principal: principal(owner, workspace),
    adapterSessionId: session,
    providerSandboxId: `sandbox_${session}`,
    policy,
    // The PostgreSQL implementation must ignore application wall-clock input.
    nowEpochMs: 0,
  });
}

async function clear() {
  await client`truncate table sandbox_execution_lease`;
}

async function expire(lease: SandboxExecutionLease) {
  const expiresAtEpochMs = Date.now() - 1_000;
  const heartbeatAtEpochMs = expiresAtEpochMs - 1_000;
  const acquiredAtEpochMs = heartbeatAtEpochMs - 1_000;
  const record = {
    ...lease,
    acquiredAtEpochMs,
    heartbeatAtEpochMs,
    expiresAtEpochMs,
  };
  await client`
    update sandbox_execution_lease
    set acquired_at = ${new Date(acquiredAtEpochMs).toISOString()}::timestamptz,
        heartbeat_at = ${new Date(heartbeatAtEpochMs).toISOString()}::timestamptz,
        expires_at = ${new Date(expiresAtEpochMs).toISOString()}::timestamptz,
        record = ${JSON.stringify(record)}::jsonb
    where adapter_session_id = ${lease.adapterSessionId}
  `;
}

try {
  await client.unsafe(
    await readFile("drizzle/0008_sandbox_execution_lease.sql", "utf8"),
  );

  const sameSubject = await Promise.all([
    acquire("user_1", "session_1"),
    acquire("user_1", "session_2"),
  ]);
  assert.deepEqual(sameSubject.map(({ disposition }) => disposition).sort(), [
    "acquired",
    "acquired",
  ]);
  const acquired = sameSubject.find(
    (result) => result.disposition === "acquired",
  );
  assert(acquired?.disposition === "acquired");
  assert(acquired.lease.acquiredAtEpochMs > Date.now() - 60_000);
  const replay = await store.acquire({
    principal: acquired.lease.principal,
    adapterSessionId: acquired.lease.adapterSessionId,
    providerSandboxId: acquired.lease.providerSandboxId,
    policy,
    nowEpochMs: 0,
  });
  assert.equal(replay.disposition, "existing");

  await clear();
  const workspace = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      acquire(`user_${index}`, `session_${index}`),
    ),
  );
  assert.equal(
    workspace.filter(({ disposition }) => disposition === "acquired").length,
    5,
  );

  await clear();
  const rollback = await acquire("user_1", "rollback_session");
  assert(rollback.disposition === "acquired");
  await assert.rejects(
    store.acquire({
      principal: rollback.lease.principal,
      adapterSessionId: rollback.lease.adapterSessionId,
      providerSandboxId: "substituted_provider",
      policy,
      nowEpochMs: 0,
    }),
    /different inputs/u,
  );
  const rollbackRows = await client`
    select provider_sandbox_id, epoch
    from sandbox_execution_lease
    where adapter_session_id = 'rollback_session'
  `;
  assert.deepEqual(
    [...rollbackRows],
    [{ provider_sandbox_id: "sandbox_rollback_session", epoch: 1 }],
  );

  await client`select pg_sleep(0.02)`;
  const heartbeat = await store.heartbeat({
    principal: rollback.lease.principal,
    adapterSessionId: rollback.lease.adapterSessionId,
    epoch: rollback.lease.epoch,
    nowEpochMs: 0,
  });
  assert(heartbeat.heartbeatAtEpochMs > rollback.lease.heartbeatAtEpochMs);
  assert.equal(
    heartbeat.expiresAtEpochMs - heartbeat.heartbeatAtEpochMs,
    policy.lease.ttlMs,
  );

  await expire(heartbeat);
  const [claimed] = await store.claimExpired({ nowEpochMs: 0, limit: 1 });
  assert(claimed);
  assert.equal(claimed.state, "orphaned");
  const stopFailed = await store.settleRecovery({
    lease: claimed,
    providerOutcome: "stop-failed",
    nowEpochMs: 0,
  });
  assert.equal(stopFailed?.state, "orphaned");
  assert.deepEqual(
    await Promise.all([
      store.acquire({
        principal: claimed.principal,
        adapterSessionId: claimed.adapterSessionId,
        providerSandboxId: claimed.providerSandboxId,
        policy,
        nowEpochMs: 0,
      }),
      store.acquire({
        principal: claimed.principal,
        adapterSessionId: claimed.adapterSessionId,
        providerSandboxId: claimed.providerSandboxId,
        policy,
        nowEpochMs: 0,
      }),
    ]),
    [
      { disposition: "rejected", reason: "recovery-in-progress" },
      { disposition: "rejected", reason: "recovery-in-progress" },
    ],
  );
  const [reclaimed] = await store.claimExpired({ nowEpochMs: 0, limit: 1 });
  assert(reclaimed);
  assert.equal(reclaimed.epoch, claimed.epoch + 1);
  assert.deepEqual(
    await store.acquire({
      principal: reclaimed.principal,
      adapterSessionId: reclaimed.adapterSessionId,
      providerSandboxId: reclaimed.providerSandboxId,
      policy,
      nowEpochMs: 0,
    }),
    { disposition: "rejected", reason: "recovery-in-progress" },
  );
  assert.equal(
    await store.settleRecovery({
      lease: claimed,
      providerOutcome: "stopped",
      nowEpochMs: 0,
    }),
    null,
  );
  const settled = await store.settleRecovery({
    lease: reclaimed,
    providerOutcome: "stopped",
    nowEpochMs: 0,
  });
  assert.equal(settled?.state, "released");
  const recovered = await store.acquire({
    principal: reclaimed.principal,
    adapterSessionId: reclaimed.adapterSessionId,
    providerSandboxId: reclaimed.providerSandboxId,
    policy,
    nowEpochMs: 0,
  });
  assert(recovered.disposition === "acquired");
  assert.equal(recovered.lease.epoch, reclaimed.epoch + 1);
  assert.equal(
    await store.settleRecovery({
      lease: claimed,
      providerOutcome: "stopped",
      nowEpochMs: 0,
    }),
    null,
  );
  assert.equal(recovered.lease.policyDigest, policyDigest);

  await clear();
  const batchFailed = await acquire("user_failed", "batch_failed");
  const batchStopped = await acquire("user_stopped", "batch_stopped");
  assert(batchFailed.disposition === "acquired");
  assert(batchStopped.disposition === "acquired");
  await expire(batchFailed.lease);
  await expire(batchStopped.lease);
  const batch = await reconcileExpiredSandboxLeases({
    store,
    async stopSandbox(providerSandboxId) {
      if (providerSandboxId === batchFailed.lease.providerSandboxId)
        throw new Error("provider unavailable");
    },
    nowEpochMs: 0,
  });
  assert.equal(batch.claimed, 2);
  assert.equal(batch.providerFailed.length, 1);
  assert.equal(batch.stopped.length, 1);
  assert.deepEqual(
    await Promise.all([
      acquire("user_failed", "batch_failed"),
      acquire("user_failed", "batch_failed"),
    ]),
    [
      { disposition: "rejected", reason: "recovery-in-progress" },
      { disposition: "rejected", reason: "recovery-in-progress" },
    ],
  );
  const stoppedReacquired = await acquire("user_stopped", "batch_stopped");
  assert.equal(stoppedReacquired.disposition, "acquired");
  const retry = await reconcileExpiredSandboxLeases({
    store,
    stopSandbox: async () => undefined,
    nowEpochMs: 0,
  });
  assert.equal(retry.claimed, 1);
  assert.equal(retry.stopped.length, 1);
  assert.equal(
    (await acquire("user_failed", "batch_failed")).disposition,
    "acquired",
  );

  process.stdout.write(
    JSON.stringify({
      databaseClock: true,
      expiry: true,
      heartbeat: true,
      idempotentReplay: true,
      recoveryRace: true,
      rollback: true,
      sameSubject: true,
      stopFailureAdmission: true,
      stopFailureBatch: true,
      workspaceCap: true,
    }) + "\n",
  );
} finally {
  await client.end({ timeout: 2 });
}
