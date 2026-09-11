import type { SandboxProcess } from "eve/sandbox";
import { describe, expect, it, vi } from "vitest";

import { runBoundedSandboxCommand } from "./bounded-command";

const bytes = (value: string) => new TextEncoder().encode(value);
const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(bytes(chunk));
      }
      controller.close();
    },
  });

function processFixture(stdout: string[], stderr: string[] = []) {
  const kill = vi.fn(async () => {});
  const process = {
    kill,
    stderr: stream(...stderr),
    stdout: stream(...stdout),
    wait: vi.fn(async () => ({ exitCode: 0 })),
  } as unknown as SandboxProcess;
  return { kill, process };
}

describe("bounded sandbox command", () => {
  it("passes the authored command directly to spawn", async () => {
    const fixture = processFixture(["hello"], ["warning"]);
    const spawn = vi.fn(async (options: unknown) => {
      void options;
      return fixture.process;
    });
    await expect(
      runBoundedSandboxCommand({ spawn }, { command: "mise run check" })
    ).resolves.toEqual({ exitCode: 0, stderr: "warning", stdout: "hello" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: expect.any(AbortSignal),
        command: "mise run check",
      })
    );
  });

  it("kills the process before retaining output beyond the byte limit", async () => {
    const fixture = processFixture(["1234", "5678"]);
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { outputBytes: 6 }
      )
    ).rejects.toMatchObject({
      code: "output-limit",
      name: "SandboxCommandLimitError",
    });
    expect(fixture.kill).toHaveBeenCalledOnce();
  });

  it("accounts stdout and stderr against one shared byte limit", async () => {
    const fixture = processFixture(["1234"], ["5678"]);
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { outputBytes: 6 }
      )
    ).rejects.toMatchObject({ code: "output-limit" });
    expect(fixture.kill).toHaveBeenCalledOnce();
  });

  it("kills a command that produces no output before its wall timeout", async () => {
    const idle = () => new ReadableStream<Uint8Array>({ start() {} });
    const kill = vi.fn(async () => {});
    const process = {
      kill,
      stderr: idle(),
      stdout: idle(),
      wait: () => new Promise<never>(() => undefined),
    } as unknown as SandboxProcess;
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => process },
        { command: "idle" },
        { noOutputTimeoutMs: 10, timeoutMs: 1000 }
      )
    ).rejects.toMatchObject({ code: "no-output-timeout" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("rearms the no-output timeout after the last combined-stream chunk", async () => {
    const oneThenIdle = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(bytes("progress"));
        },
      });
    const idle = () => new ReadableStream<Uint8Array>({ start() {} });
    const kill = vi.fn(async () => {});
    const process = {
      kill,
      stderr: idle(),
      stdout: oneThenIdle(),
      wait: () => new Promise<never>(() => undefined),
    } as unknown as SandboxProcess;
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => process },
        { command: "progress-then-idle" },
        { noOutputTimeoutMs: 10, timeoutMs: 1000 }
      )
    ).rejects.toMatchObject({ code: "no-output-timeout" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not let a hung provider kill replace the original limit error", async () => {
    const fixture = processFixture(["too much output"]);
    fixture.process.kill = vi.fn(() => new Promise<never>(() => {}));
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { killCleanupTimeoutMs: 10, outputBytes: 2 }
      )
    ).rejects.toMatchObject({ code: "output-limit" });
  });

  it("does not project parent environment credentials", async () => {
    const fixture = processFixture([]);
    const spawn = vi.fn(async (options: unknown) => {
      void options;
      return fixture.process;
    });
    await runBoundedSandboxCommand(
      { spawn },
      { command: "true", env: { SAFE_INPUT: "exact" } }
    );
    expect((spawn.mock.calls[0]?.[0] as { env?: unknown }).env).toEqual({
      SAFE_INPUT: "exact",
    });
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("DATABASE_URL");
  });
});
