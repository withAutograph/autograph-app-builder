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
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test",
  ownerUserId,
  scopes: ["eve:start"],
  workspaceId: "workspace_1",
});

const acquire = (
  store: InMemorySandboxExecutionLeaseStore,
  ownerUserId: string,
  sessionId: string,
  nowEpochMs = 1000
) =>
  store.acquire({
    adapterSessionId: sessionId,
    nowEpochMs,
    policy: SANDBOX_EXECUTION_POLICY,
    principal: principal(ownerUserId),
    providerSandboxId: `sandbox_${sessionId}`,
  });

describe("sandbox execution lease", () => {
  it("is idempotent at exact inputs without a per-subject quota", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    const [first, raced] = await Promise.all([
      acquire(store, "user_1", "session_1"),
      acquire(store, "user_1", "session_2"),
    ]);
    expect([first.disposition, raced.disposition]).toEqual([
      "acquired",
      "acquired",
    ]);
    const replay = await acquire(store, "user_1", "session_1");
    expect(replay.disposition).toBe("existing");
    if (replay.disposition === "rejected") {
      throw new Error("unexpected");
    }
    expect(replay.lease.epoch).toBe(1);
    expect(replay.lease.policyDigest).toBe(sandboxExecutionPolicyDigest());
  });

  it("releases idempotently and increments the epoch on reacquisition", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    const acquired = await acquire(store, "user_1", "session_1");
    if (acquired.disposition === "rejected") {
      throw new Error("unexpected");
    }
    const released = await store.release({
      adapterSessionId: acquired.lease.adapterSessionId,
      epoch: acquired.lease.epoch,
      nowEpochMs: 2_000,
      principal: acquired.lease.principal,
      reason: "waiting",
    });
    expect(released.state).toBe("released");
    expect(
      await store.release({
        adapterSessionId: acquired.lease.adapterSessionId,
        epoch: acquired.lease.epoch,
        nowEpochMs: 2_001,
        principal: acquired.lease.principal,
        reason: "waiting",
      })
    ).toEqual(released);
    const next = await acquire(store, "user_1", "session_1", 3000);
    if (next.disposition === "rejected") {
      throw new Error("unexpected");
    }
    expect(next.lease.epoch).toBe(2);
  });

  it("keeps stop failures orphaned and reuse-blocking until a successful retry", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    await acquire(store, "user_1", "session_1", 1);
    const stopSandbox = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const receipt = await reconcileExpiredSandboxLeases({
      nowEpochMs: 1 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      stopSandbox,
      store,
    });
    expect(receipt).toMatchObject({ claimed: 1, stopped: [] });
    expect(receipt.providerFailed).toHaveLength(1);
    expect(receipt.providerFailed[0]).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(JSON.stringify(receipt)).not.toContain("session_1");
    await expect(
      Promise.all([
        acquire(
          store,
          "user_1",
          "session_1",
          2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
        ),
        acquire(
          store,
          "user_1",
          "session_1",
          2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
        ),
      ])
    ).resolves.toEqual([
      { disposition: "rejected", reason: "recovery-in-progress" },
      { disposition: "rejected", reason: "recovery-in-progress" },
    ]);
    const retryStop = vi.fn(async () => {});
    const retried = await reconcileExpiredSandboxLeases({
      nowEpochMs: 2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      stopSandbox: retryStop,
      store,
    });
    expect(retried).toMatchObject({ claimed: 1, providerFailed: [] });
    expect(retried.stopped).toHaveLength(1);
    expect(
      await reconcileExpiredSandboxLeases({
        nowEpochMs: 3 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
        stopSandbox: retryStop,
        store,
      })
    ).toEqual({
      claimed: 0,
      providerFailed: [],
      settlementFailed: [],
      settlementRaced: [],
      stopped: [],
    });
  });

  it("continues a recovery batch while only successful provider stops release", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    await acquire(store, "user_1", "session_1", 1);
    await acquire(store, "user_2", "session_2", 1);
    const stopSandbox = vi.fn(async (providerSandboxId: string) => {
      if (providerSandboxId === "sandbox_session_1") {
        throw new Error("provider unavailable");
      }
    });
    const result = await reconcileExpiredSandboxLeases({
      nowEpochMs: 1 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      stopSandbox,
      store,
    });
    expect(stopSandbox).toHaveBeenCalledTimes(2);
    expect(result.providerFailed).toHaveLength(1);
    expect(result.stopped).toHaveLength(1);
    await expect(
      acquire(
        store,
        "user_1",
        "session_1",
        2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
      )
    ).resolves.toEqual({
      disposition: "rejected",
      reason: "recovery-in-progress",
    });
    await expect(
      acquire(
        store,
        "user_2",
        "session_2",
        2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
      )
    ).resolves.toMatchObject({ disposition: "acquired" });
  });

  it("makes recovery and reacquisition races retry-safe", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    const first = await acquire(store, "user_1", "session_1", 1);
    if (first.disposition === "rejected") {
      throw new Error("unexpected");
    }
    const [claim] = await store.claimExpired({
      limit: 1,
      nowEpochMs: 1 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
    });
    expect(claim).toBeDefined();
    await expect(
      acquire(
        store,
        "user_1",
        "session_1",
        2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
      )
    ).resolves.toEqual({
      disposition: "rejected",
      reason: "recovery-in-progress",
    });
    await store.settleRecovery({
      lease: claim!,
      nowEpochMs: 3 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      providerOutcome: "stopped",
    });
    const reacquired = await acquire(
      store,
      "user_1",
      "session_1",
      4 + SANDBOX_EXECUTION_POLICY.lease.ttlMs
    );
    if (reacquired.disposition === "rejected") {
      throw new Error("unexpected");
    }
    expect(reacquired.lease.epoch).toBe(2);
    await expect(
      store.settleRecovery({
        lease: claim!,
        nowEpochMs: 5 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
        providerOutcome: "stopped",
      })
    ).resolves.toBeNull();
  });

  it("separates provider stop from settlement and does not abort the batch", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    await acquire(store, "user_1", "session_1", 1);
    await acquire(store, "user_2", "session_2", 1);
    const settle = vi.spyOn(store, "settleRecovery");
    settle.mockRejectedValueOnce(new Error("settlement unavailable"));
    const stopSandbox = vi.fn(async () => {});
    const result = await reconcileExpiredSandboxLeases({
      nowEpochMs: 1 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      stopSandbox,
      store,
    });
    expect(stopSandbox).toHaveBeenCalledTimes(2);
    expect(result.settlementFailed).toHaveLength(1);
    expect(result.stopped).toHaveLength(1);
    expect(result.providerFailed).toEqual([]);
    const retried = await reconcileExpiredSandboxLeases({
      nowEpochMs: 2 + SANDBOX_EXECUTION_POLICY.lease.ttlMs,
      stopSandbox,
      store,
    });
    expect(retried.claimed).toBe(1);
    expect(retried.stopped).toHaveLength(1);
  });
});
