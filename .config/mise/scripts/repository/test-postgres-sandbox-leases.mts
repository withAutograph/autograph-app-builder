import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as databaseSchema from "../../../../lib/db/schema";
import type { HostedPrincipal } from "../../../../lib/eve/hosted-auth";
import { reconcileExpiredSandboxLeases } from "../../../../lib/sandbox/execution-lease";
import type { SandboxExecutionLease } from "../../../../lib/sandbox/execution-lease";
import {
  SANDBOX_EXECUTION_POLICY,
  sandboxExecutionPolicyDigest,
} from "../../../../lib/sandbox/execution-policy";
import { createPostgresSandboxExecutionLeaseStore } from "../../../../lib/sandbox/postgres-execution-lease-store";

function argument(name: string) {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
}

const host = argument("--host");
const port = Number(argument("--port"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Invalid PostgreSQL port.");
}

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
    audience: "https://builder.example.test/mcp",
    issuer: "https://builder.example.test/api/auth",
    ownerUserId,
    scopes: ["eve:start"],
    workspaceId,
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
  const expiresAtEpochMs = Date.now() - 1000;
  const heartbeatAtEpochMs = expiresAtEpochMs - 1000;
  const acquiredAtEpochMs = heartbeatAtEpochMs - 1000;
  const record = {
    ...lease,
    acquiredAtEpochMs,
    expiresAtEpochMs,
    heartbeatAtEpochMs,
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
    await readFile("drizzle/0008_sandbox_execution_lease.sql", "utf-8")
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
    (result) => result.disposition === "acquired"
  );
  assert.ok(acquired?.disposition === "acquired");
  assert.ok(acquired.lease.acquiredAtEpochMs > Date.now() - 60_000);
  const replay = await store.acquire({
    adapterSessionId: acquired.lease.adapterSessionId,
    nowEpochMs: 0,
    policy,
    principal: acquired.lease.principal,
    providerSandboxId: acquired.lease.providerSandboxId,
  });
  assert.equal(replay.disposition, "existing");

  await clear();
  const workspace = await Promise.all(
    Array.from({ length: 5 }, (_, index) =>
      acquire(`user_${index}`, `session_${index}`)
    )
  );
  assert.equal(
    workspace.filter(({ disposition }) => disposition === "acquired").length,
    5
  );

  await clear();
  const rollback = await acquire("user_1", "rollback_session");
  assert.ok(rollback.disposition === "acquired");
  await assert.rejects(
    store.acquire({
      adapterSessionId: rollback.lease.adapterSessionId,
      nowEpochMs: 0,
      policy,
      principal: rollback.lease.principal,
      providerSandboxId: "substituted_provider",
    }),
    /different inputs/u
  );
  const rollbackRows = await client`
    select provider_sandbox_id, epoch
    from sandbox_execution_lease
    where adapter_session_id = 'rollback_session'
  `;
  assert.deepEqual(
    [...rollbackRows],
    [{ epoch: 1, provider_sandbox_id: "sandbox_rollback_session" }]
  );

  await client`select pg_sleep(0.02)`;
  const heartbeat = await store.heartbeat({
    adapterSessionId: rollback.lease.adapterSessionId,
    epoch: rollback.lease.epoch,
    nowEpochMs: 0,
    principal: rollback.lease.principal,
  });
  assert.ok(heartbeat.heartbeatAtEpochMs > rollback.lease.heartbeatAtEpochMs);
  assert.equal(
    heartbeat.expiresAtEpochMs - heartbeat.heartbeatAtEpochMs,
    policy.lease.ttlMs
  );

  await expire(heartbeat);
  const [claimed] = await store.claimExpired({ limit: 1, nowEpochMs: 0 });
  assert.ok(claimed);
  assert.equal(claimed.state, "orphaned");
  const stopFailed = await store.settleRecovery({
    lease: claimed,
    nowEpochMs: 0,
    providerOutcome: "stop-failed",
  });
  assert.equal(stopFailed?.state, "orphaned");
  assert.deepEqual(
    await Promise.all([
      store.acquire({
        adapterSessionId: claimed.adapterSessionId,
        nowEpochMs: 0,
        policy,
        principal: claimed.principal,
        providerSandboxId: claimed.providerSandboxId,
      }),
      store.acquire({
        adapterSessionId: claimed.adapterSessionId,
        nowEpochMs: 0,
        policy,
        principal: claimed.principal,
        providerSandboxId: claimed.providerSandboxId,
      }),
    ]),
    [
      { disposition: "rejected", reason: "recovery-in-progress" },
      { disposition: "rejected", reason: "recovery-in-progress" },
    ]
  );
  const [reclaimed] = await store.claimExpired({ limit: 1, nowEpochMs: 0 });
  assert.ok(reclaimed);
  assert.equal(reclaimed.epoch, claimed.epoch + 1);
  assert.deepEqual(
    await store.acquire({
      adapterSessionId: reclaimed.adapterSessionId,
      nowEpochMs: 0,
      policy,
      principal: reclaimed.principal,
      providerSandboxId: reclaimed.providerSandboxId,
    }),
    { disposition: "rejected", reason: "recovery-in-progress" }
  );
  assert.equal(
    await store.settleRecovery({
      lease: claimed,
      nowEpochMs: 0,
      providerOutcome: "stopped",
    }),
    null
  );
  const settled = await store.settleRecovery({
    lease: reclaimed,
    nowEpochMs: 0,
    providerOutcome: "stopped",
  });
  assert.equal(settled?.state, "released");
  const recovered = await store.acquire({
    adapterSessionId: reclaimed.adapterSessionId,
    nowEpochMs: 0,
    policy,
    principal: reclaimed.principal,
    providerSandboxId: reclaimed.providerSandboxId,
  });
  assert.ok(recovered.disposition === "acquired");
  assert.equal(recovered.lease.epoch, reclaimed.epoch + 1);
  assert.equal(
    await store.settleRecovery({
      lease: claimed,
      nowEpochMs: 0,
      providerOutcome: "stopped",
    }),
    null
  );
  assert.equal(recovered.lease.policyDigest, policyDigest);

  await clear();
  const batchFailed = await acquire("user_failed", "batch_failed");
  const batchStopped = await acquire("user_stopped", "batch_stopped");
  assert.ok(batchFailed.disposition === "acquired");
  assert.ok(batchStopped.disposition === "acquired");
  await expire(batchFailed.lease);
  await expire(batchStopped.lease);
  const batch = await reconcileExpiredSandboxLeases({
    nowEpochMs: 0,
    async stopSandbox(providerSandboxId) {
      if (providerSandboxId === batchFailed.lease.providerSandboxId)
        throw new Error("provider unavailable");
    },
    store,
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
    ]
  );
  const stoppedReacquired = await acquire("user_stopped", "batch_stopped");
  assert.equal(stoppedReacquired.disposition, "acquired");
  const retry = await reconcileExpiredSandboxLeases({
    nowEpochMs: 0,
    stopSandbox: async () => undefined,
    store,
  });
  assert.equal(retry.claimed, 1);
  assert.equal(retry.stopped.length, 1);
  assert.equal(
    (await acquire("user_failed", "batch_failed")).disposition,
    "acquired"
  );

  process.stdout.write(
    `${JSON.stringify({
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
    })}\n`
  );
} finally {
  await client.end({ timeout: 2 });
}
