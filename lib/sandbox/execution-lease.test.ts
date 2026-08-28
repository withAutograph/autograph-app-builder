import { describe, expect, it, vi } from "vitest";

import type { HostedPrincipal } from "../eve/hosted-auth";
import {
  InMemorySandboxExecutionLeaseStore,
  reconcileExpiredSandboxLeases,
} from "./execution-lease";
import {
  SANDBOX_EXECUTION_POLICY,
  sandboxExecutionPolicyDigest,
} from "./execution-policy";

const principal = (ownerUserId: string): HostedPrincipal => ({
  issuer: "https://builder.example.test",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_1",
  ownerUserId,
  scopes: ["eve:start"],
});

const acquire = (
  store: InMemorySandboxExecutionLeaseStore,
  ownerUserId: string,
  sessionId: string,
  nowEpochMs = 1_000,
) =>
  store.acquire({
    principal: principal(ownerUserId),
    adapterSessionId: sessionId,
    providerSandboxId: `sandbox_${sessionId}`,
    policy: SANDBOX_EXECUTION_POLICY,
    nowEpochMs,
  });

describe("sandbox execution lease", () => {
  it("is idempotent at exact inputs and rejects a raced subject lease", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    const [first, raced] = await Promise.all([
      acquire(store, "user_1", "session_1"),
      acquire(store, "user_1", "session_2"),
    ]);
    expect([first.disposition, raced.disposition].sort()).toEqual([
      "acquired",
      "rejected",
    ]);
    const replay = await acquire(store, "user_1", "session_1");
    expect(replay.disposition).toBe("existing");
    if (replay.disposition === "rejected") throw new Error("unexpected");
    expect(replay.lease.epoch).toBe(1);
    expect(replay.lease.policyDigest).toBe(sandboxExecutionPolicyDigest());
  });

  it("releases idempotently and increments the epoch on reacquisition", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    const acquired = await acquire(store, "user_1", "session_1");
    if (acquired.disposition === "rejected") throw new Error("unexpected");
    const released = await store.release({
      principal: acquired.lease.principal,
      adapterSessionId: acquired.lease.adapterSessionId,
      epoch: acquired.lease.epoch,
      reason: "waiting",
      nowEpochMs: 2_000,
    });
    expect(released.state).toBe("released");
    expect(
      await store.release({
        principal: acquired.lease.principal,
        adapterSessionId: acquired.lease.adapterSessionId,
        epoch: acquired.lease.epoch,
        reason: "waiting",
        nowEpochMs: 2_001,
      }),
    ).toEqual(released);
    const next = await acquire(store, "user_1", "session_1", 3_000);
    if (next.disposition === "rejected") throw new Error("unexpected");
    expect(next.lease.epoch).toBe(2);
  });

  it("claims expired work once and reports stop failures without identifiers", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    await acquire(store, "user_1", "session_1", 1);
    const stopSandbox = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const receipt = await reconcileExpiredSandboxLeases({
      store,
      stopSandbox,
      nowEpochMs: 1 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
    });
    expect(receipt).toMatchObject({ claimed: 1, stopped: [] });
    expect(receipt.failed).toHaveLength(1);
    expect(receipt.failed[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("session_1");
    const retryStop = vi.fn(async () => undefined);
    const retried = await reconcileExpiredSandboxLeases({
      store,
      stopSandbox: retryStop,
      nowEpochMs: 2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
    });
    expect(retried).toMatchObject({ claimed: 1, failed: [] });
    expect(retried.stopped).toHaveLength(1);
    expect(
      await reconcileExpiredSandboxLeases({
        store,
        stopSandbox: retryStop,
        nowEpochMs: 3 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      }),
    ).toEqual({ claimed: 0, stopped: [], failed: [] });
  });
});
