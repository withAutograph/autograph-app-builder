import type { RuntimeSandboxSession } from "eve/sandbox";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  acquireHostedSandboxExecutionLease,
  assertHostedSandboxCommandAuthority,
  clearHostedSandboxExecutionLeaseCacheForTest,
  releaseHostedSandboxExecutionLease,
  sandboxCleanupEvidence,
  setHostedSandboxExecutionLeaseDependenciesForTest,
} from "./deployment-execution-lease";
import { InMemorySandboxExecutionLeaseStore } from "./execution-lease";

const forwarded = () => ({
  attributes: {
    "mcp:audience": "https://builder.example.test/mcp",
    "mcp:scopes": ["eve:start"],
    "mcp:workspace-id": "workspace_1",
  },
  authenticator: "mcp-oauth-jwks",
  issuer: "https://builder.example.test/api/auth",
  principalId: "user_1",
  principalType: "user",
  subject: "user_1",
});
const sessionAuth = () => ({ current: forwarded(), initiator: forwarded() });

function sandboxFixture(stop = vi.fn(async () => {})) {
  return {
    id: "provider_session_1",
    stop,
  } as unknown as RuntimeSandboxSession;
}

function install(store: InMemorySandboxExecutionLeaseStore, member = true) {
  setHostedSandboxExecutionLeaseDependenciesForTest({
    enabled: () => true,
    isMember: async () => member,
    store: () => store,
  });
}

afterEach(clearHostedSandboxExecutionLeaseCacheForTest);

describe("hosted sandbox turn lease lifecycle", () => {
  it("acquires and releases a fresh epoch at each of two turn boundaries", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const firstSandbox = sandboxFixture();
    const first = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 1_000,
      sandbox: firstSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(first?.epoch).toBe(1);
    await expect(
      assertHostedSandboxCommandAuthority({
        nowEpochMs: 1_001,
        sessionId: "session_1",
      })
    ).resolves.toMatchObject({ epoch: 1, state: "active" });
    await expect(
      releaseHostedSandboxExecutionLease({
        nowEpochMs: 2_000,
        reason: "turn-completed",
        sandbox: firstSandbox,
        sessionAuth: sessionAuth(),
        sessionId: "session_1",
      })
    ).resolves.toMatchObject({ lease: { state: "released" }, released: true });

    const secondSandbox = sandboxFixture();
    const second = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 3_000,
      sandbox: secondSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(second?.epoch).toBe(2);
    await releaseHostedSandboxExecutionLease({
      nowEpochMs: 4_000,
      reason: "turn-cancelled",
      sandbox: secondSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(firstSandbox.stop).toHaveBeenCalledOnce();
    expect(secondSandbox.stop).toHaveBeenCalledOnce();
  });

  it("releases after module-local command state is lost and reacquires safely", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const sandbox = sandboxFixture();
    await acquireHostedSandboxExecutionLease({
      nowEpochMs: 1_000,
      sandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    clearHostedSandboxExecutionLeaseCacheForTest();
    install(store);
    await expect(
      assertHostedSandboxCommandAuthority({ sessionId: "session_1" })
    ).rejects.toThrow("authority is unavailable");
    await expect(
      releaseHostedSandboxExecutionLease({
        nowEpochMs: 2_000,
        reason: "turn-failed",
        sandbox,
        sessionAuth: sessionAuth(),
        sessionId: "session_1",
      })
    ).resolves.toMatchObject({ lease: { epoch: 1 }, released: true });
    const reacquired = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 3_000,
      sandbox: sandboxFixture(),
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(reacquired?.epoch).toBe(2);
  });

  it("stops compute on authority, membership, database, and acquire failures", async () => {
    const cases: {
      auth: unknown;
      member: boolean;
      store: () => InMemorySandboxExecutionLeaseStore;
      message: string;
    }[] = [
      {
        auth: {},
        member: true,
        message: "Hosted session authority is invalid",
        store: () => new InMemorySandboxExecutionLeaseStore(),
      },
      {
        auth: sessionAuth(),
        member: false,
        message: "membership is not active",
        store: () => new InMemorySandboxExecutionLeaseStore(),
      },
      {
        auth: sessionAuth(),
        member: true,
        message: "database unavailable",
        store: () => {
          throw new Error("database unavailable");
        },
      },
      {
        auth: sessionAuth(),
        member: true,
        message: "acquire failed",
        store: () =>
          ({
            acquire: async () => {
              throw new Error("acquire failed");
            },
          }) as never,
      },
    ];
    for (const candidate of cases) {
      const stop = vi.fn(async () => {});
      setHostedSandboxExecutionLeaseDependenciesForTest({
        enabled: () => true,
        isMember: async () => candidate.member,
        store: candidate.store,
      });
      const rejection = await acquireHostedSandboxExecutionLease({
        sandbox: sandboxFixture(stop),
        sessionAuth: candidate.auth,
        sessionId: "session_1",
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      expect((rejection as Error).message).toContain(candidate.message);
      expect(stop).toHaveBeenCalledOnce();
      expect(sandboxCleanupEvidence(rejection)).toEqual({
        attempted: true,
        stopped: true,
        timedOut: false,
      });
    }
  });

  it("preserves the original store error and records failed cleanup", async () => {
    const original = new Error("database unavailable");
    setHostedSandboxExecutionLeaseDependenciesForTest({
      enabled: () => true,
      isMember: async () => true,
      store: () => {
        throw original;
      },
    });
    const stop = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const rejection = await acquireHostedSandboxExecutionLease({
      sandbox: sandboxFixture(stop),
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    }).catch((error: unknown) => error);
    expect(rejection).toBe(original);
    expect(sandboxCleanupEvidence(rejection)).toEqual({
      attempted: true,
      stopped: false,
      timedOut: false,
    });
  });
});
