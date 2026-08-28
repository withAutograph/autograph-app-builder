import { afterEach, describe, expect, it, vi } from "vitest";

import type { RuntimeSandboxSession } from "eve/sandbox";
import { InMemorySandboxExecutionLeaseStore } from "./execution-lease";
import {
  acquireHostedSandboxExecutionLease,
  assertHostedSandboxCommandAuthority,
  clearHostedSandboxExecutionLeaseCacheForTest,
  releaseHostedSandboxExecutionLease,
  sandboxCleanupEvidence,
  setHostedSandboxExecutionLeaseDependenciesForTest,
} from "./deployment-execution-lease";

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

function sandboxFixture(stop = vi.fn(async () => undefined)) {
  return {
    id: "provider_session_1",
    stop,
  } as unknown as RuntimeSandboxSession;
}

function install(store: InMemorySandboxExecutionLeaseStore, member = true) {
  setHostedSandboxExecutionLeaseDependenciesForTest({
    enabled: () => true,
    store: () => store,
    isMember: async () => member,
  });
}

afterEach(clearHostedSandboxExecutionLeaseCacheForTest);

describe("hosted sandbox turn lease lifecycle", () => {
  it("acquires and releases a fresh epoch at each of two turn boundaries", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const firstSandbox = sandboxFixture();
    const first = await acquireHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox: firstSandbox,
      nowEpochMs: 1_000,
    });
    expect(first?.epoch).toBe(1);
    await expect(
      assertHostedSandboxCommandAuthority({
        sessionId: "session_1",
        nowEpochMs: 1_001,
      }),
    ).resolves.toMatchObject({ epoch: 1, state: "active" });
    await expect(
      releaseHostedSandboxExecutionLease({
        sessionId: "session_1",
        sessionAuth: sessionAuth(),
        sandbox: firstSandbox,
        reason: "turn-completed",
        nowEpochMs: 2_000,
      }),
    ).resolves.toMatchObject({ released: true, lease: { state: "released" } });

    const secondSandbox = sandboxFixture();
    const second = await acquireHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox: secondSandbox,
      nowEpochMs: 3_000,
    });
    expect(second?.epoch).toBe(2);
    await releaseHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox: secondSandbox,
      reason: "turn-cancelled",
      nowEpochMs: 4_000,
    });
    expect(firstSandbox.stop).toHaveBeenCalledOnce();
    expect(secondSandbox.stop).toHaveBeenCalledOnce();
  });

  it("releases after module-local command state is lost and reacquires safely", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const sandbox = sandboxFixture();
    await acquireHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox,
      nowEpochMs: 1_000,
    });
    clearHostedSandboxExecutionLeaseCacheForTest();
    install(store);
    await expect(
      assertHostedSandboxCommandAuthority({ sessionId: "session_1" }),
    ).rejects.toThrow("authority is unavailable");
    await expect(
      releaseHostedSandboxExecutionLease({
        sessionId: "session_1",
        sessionAuth: sessionAuth(),
        sandbox,
        reason: "turn-failed",
        nowEpochMs: 2_000,
      }),
    ).resolves.toMatchObject({ released: true, lease: { epoch: 1 } });
    const reacquired = await acquireHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox: sandboxFixture(),
      nowEpochMs: 3_000,
    });
    expect(reacquired?.epoch).toBe(2);
  });

  it("stops compute on authority, membership, database, and acquire failures", async () => {
    const cases: Array<{
      auth: unknown;
      member: boolean;
      store: () => InMemorySandboxExecutionLeaseStore;
      message: string;
    }> = [
      {
        auth: {},
        member: true,
        store: () => new InMemorySandboxExecutionLeaseStore(),
        message: "Hosted session authority is invalid",
      },
      {
        auth: sessionAuth(),
        member: false,
        store: () => new InMemorySandboxExecutionLeaseStore(),
        message: "membership is not active",
      },
      {
        auth: sessionAuth(),
        member: true,
        store: () => {
          throw new Error("database unavailable");
        },
        message: "database unavailable",
      },
      {
        auth: sessionAuth(),
        member: true,
        store: () =>
          ({
            acquire: async () => {
              throw new Error("acquire failed");
            },
          }) as never,
        message: "acquire failed",
      },
    ];
    for (const candidate of cases) {
      const stop = vi.fn(async () => undefined);
      setHostedSandboxExecutionLeaseDependenciesForTest({
        enabled: () => true,
        store: candidate.store,
        isMember: async () => candidate.member,
      });
      const rejection = await acquireHostedSandboxExecutionLease({
        sessionId: "session_1",
        sessionAuth: candidate.auth,
        sandbox: sandboxFixture(stop),
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
      store: () => {
        throw original;
      },
      isMember: async () => true,
    });
    const stop = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const rejection = await acquireHostedSandboxExecutionLease({
      sessionId: "session_1",
      sessionAuth: sessionAuth(),
      sandbox: sandboxFixture(stop),
    }).catch((error: unknown) => error);
    expect(rejection).toBe(original);
    expect(sandboxCleanupEvidence(rejection)).toEqual({
      attempted: true,
      stopped: false,
      timedOut: false,
    });
  });
});
