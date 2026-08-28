import { readFile } from "node:fs/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import hook from "../../agent/hooks/release-sandbox-compute";
import {
  clearHostedSandboxExecutionLeaseCacheForTest,
  setHostedSandboxExecutionLeaseDependenciesForTest,
} from "./deployment-execution-lease";

const originalEnvironment = {
  EVE_HOSTED_ADAPTER: process.env.EVE_HOSTED_ADAPTER,
  EVE_HOSTED_SANDBOX_EXECUTION: process.env.EVE_HOSTED_SANDBOX_EXECUTION,
};

function restoreEnvironment() {
  for (const [key, value] of Object.entries(originalEnvironment)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

afterEach(() => {
  restoreEnvironment();
  clearHostedSandboxExecutionLeaseCacheForTest();
});

describe("Eve durable turn execution envelope", () => {
  it("acquires before dynamic tools at turn.started and releases only at terminal boundaries", async () => {
    const [hook, sandbox] = await Promise.all([
      readFile("agent/hooks/release-sandbox-compute.ts", "utf8"),
      readFile("agent/sandbox.ts", "utf8"),
    ]);
    expect(hook).toContain('"turn.started"');
    expect(hook).toContain("acquireHostedSandboxExecutionLease");
    expect(hook).toContain('"turn.completed"');
    expect(hook).toContain('"turn.cancelled"');
    expect(hook).toContain('"turn.failed"');
    expect(hook).not.toContain('"session.waiting"');
    expect(sandbox).not.toContain("acquireHostedSandboxExecutionLease");
  });

  it.each([
    {
      activation: "absent",
      environment: {},
    },
    {
      activation: "incorrect execution gate",
      environment: {
        EVE_HOSTED_ADAPTER: "1",
        EVE_HOSTED_SANDBOX_EXECUTION: "enabled-v0",
      },
    },
    {
      activation: "incorrect adapter gate",
      environment: {
        EVE_HOSTED_ADAPTER: "0",
        EVE_HOSTED_SANDBOX_EXECUTION: "enabled-v1",
      },
    },
  ])(
    "does not resolve compute or storage for $activation at turn boundaries",
    async ({ environment }) => {
      delete process.env.EVE_HOSTED_ADAPTER;
      delete process.env.EVE_HOSTED_SANDBOX_EXECUTION;
      Object.assign(process.env, environment);

      const enabled = vi.fn(() => true);
      const store = vi.fn(() => {
        throw new Error("database must remain unopened");
      });
      const isMember = vi.fn(async () => true);
      setHostedSandboxExecutionLeaseDependenciesForTest({
        enabled,
        store,
        isMember,
      });
      const stop = vi.fn(async () => undefined);
      const getSandbox = vi.fn(async () => ({
        id: "provider_session_1",
        stop,
      }));
      const context = {
        getSandbox,
        session: { auth: {}, id: "session_1" },
      } as never;
      const events = hook.events as Record<
        string,
        (event: never, context: never) => void | Promise<void>
      >;

      await events["turn.started"]?.({} as never, context);
      await events["turn.completed"]?.({} as never, context);

      expect(getSandbox).not.toHaveBeenCalled();
      expect(stop).not.toHaveBeenCalled();
      expect(enabled).not.toHaveBeenCalled();
      expect(store).not.toHaveBeenCalled();
      expect(isMember).not.toHaveBeenCalled();
    },
  );
});
