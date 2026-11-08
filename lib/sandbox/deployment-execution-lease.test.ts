import { afterEach, describe, expect, it, vi } from "vitest";

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

// eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
function sandboxFixture(stop = vi.fn(async () => {})) {
  return {
    id: "provider_session_1",
    stop,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function install(store: InMemorySandboxExecutionLeaseStore, member = true) {
  setHostedSandboxExecutionLeaseDependenciesForTest({
    enabled: () => true,
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    isMember: async () => member,
    store: () => store,
  });
}

afterEach(clearHostedSandboxExecutionLeaseCacheForTest);

describe("hosted sandbox turn lease lifecycle", () => {
  it("acquires and releases a fresh epoch at each of two turn boundaries", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const firstStop = vi.fn(async () => {});
    const firstSandbox = sandboxFixture(firstStop);
    const first = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 1000,
      sandbox: firstSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(first?.epoch).toBe(1);
    await expect(
      assertHostedSandboxCommandAuthority({
        nowEpochMs: 1001,
        sessionId: "session_1",
      }),
    ).resolves.toMatchObject({ epoch: 1, state: "active" });
    await expect(
      releaseHostedSandboxExecutionLease({
        nowEpochMs: 2000,
        reason: "turn-completed",
        sandbox: firstSandbox,
        sessionAuth: sessionAuth(),
        sessionId: "session_1",
      }),
    ).resolves.toMatchObject({ lease: { state: "released" }, released: true });

    const secondStop = vi.fn(async () => {});
    const secondSandbox = sandboxFixture(secondStop);
    const second = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 3000,
      sandbox: secondSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(second?.epoch).toBe(2);
    await releaseHostedSandboxExecutionLease({
      nowEpochMs: 4000,
      reason: "turn-cancelled",
      sandbox: secondSandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    expect(firstStop).toHaveBeenCalledOnce();
    expect(secondStop).toHaveBeenCalledOnce();
  });

  it("releases after module-local command state is lost and reacquires safely", async () => {
    const store = new InMemorySandboxExecutionLeaseStore();
    install(store);
    const sandbox = sandboxFixture();
    await acquireHostedSandboxExecutionLease({
      nowEpochMs: 1000,
      sandbox,
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
    });
    clearHostedSandboxExecutionLeaseCacheForTest();
    install(store);
    await expect(assertHostedSandboxCommandAuthority({ sessionId: "session_1" })).rejects.toThrow(
      "authority is unavailable",
    );
    await expect(
      releaseHostedSandboxExecutionLease({
        nowEpochMs: 2000,
        reason: "turn-failed",
        sandbox,
        sessionAuth: sessionAuth(),
        sessionId: "session_1",
      }),
    ).resolves.toMatchObject({ lease: { epoch: 1 }, released: true });
    const reacquired = await acquireHostedSandboxExecutionLease({
      nowEpochMs: 3000,
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
          // oxlint-disable-next-line anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
          ({
            // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
            acquire: async () => {
              throw new Error("acquire failed");
            },
          }) as never,
      },
    ];
    for (const candidate of cases) {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      const stop = vi.fn(async () => {});
      setHostedSandboxExecutionLeaseDependenciesForTest({
        enabled: () => true,
        // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
        isMember: async () => candidate.member,
        store: candidate.store,
      });
      // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
      const rejection = await acquireHostedSandboxExecutionLease({
        sandbox: sandboxFixture(stop),
        sessionAuth: candidate.auth,
        sessionId: "session_1",
        // oxlint-disable-next-line github/no-then, anti-slop/no-unknown-parameters -- Preserve the existing rejection handling and settlement behavior. Preserve the existing unknown input contract.
      }).catch((error: unknown) => error);
      expect(rejection).toBeInstanceOf(Error);
      if (!(rejection instanceof Error)) {
        throw new Error("Expected lease acquisition to reject with an Error.");
      }
      expect(rejection.message).toContain(candidate.message);
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
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
      isMember: async () => true,
      store: () => {
        throw original;
      },
    });
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning test double
    const stop = vi.fn(async () => {
      throw new Error("provider unavailable");
    });
    const rejection = await acquireHostedSandboxExecutionLease({
      sandbox: sandboxFixture(stop),
      sessionAuth: sessionAuth(),
      sessionId: "session_1",
      // oxlint-disable-next-line github/no-then, anti-slop/no-unknown-parameters -- Preserve the existing rejection handling and settlement behavior. Preserve the existing unknown input contract.
    }).catch((error: unknown) => error);
    expect(rejection).toBe(original);
    expect(sandboxCleanupEvidence(rejection)).toEqual({
      attempted: true,
      stopped: false,
      timedOut: false,
    });
  });
});
