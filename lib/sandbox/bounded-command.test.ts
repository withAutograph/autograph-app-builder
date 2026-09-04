import { describe, expect, it, vi } from "vitest";

import type { SandboxProcess } from "eve/sandbox";
import { runBoundedSandboxCommand } from "./bounded-command";

const bytes = (value: string) => new TextEncoder().encode(value);
const stream = (...chunks: string[]) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(bytes(chunk));
      controller.close();
    },
  });

function processFixture(stdout: string[], stderr: string[] = []) {
  const kill = vi.fn(async () => undefined);
  const process = {
    stdout: stream(...stdout),
    stderr: stream(...stderr),
    wait: vi.fn(async () => ({ exitCode: 0 })),
    kill,
  } as unknown as SandboxProcess;
  return { process, kill };
}

describe("bounded sandbox command", () => {
  it("passes the authored command directly to spawn", async () => {
    const fixture = processFixture(["hello"], ["warning"]);
    const spawn = vi.fn(async (options: unknown) => {
      void options;
      return fixture.process;
    });
    await expect(
      runBoundedSandboxCommand({ spawn }, { command: "mise run check" }),
    ).resolves.toEqual({ exitCode: 0, stdout: "hello", stderr: "warning" });
    expect(spawn).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "mise run check",
        abortSignal: expect.any(AbortSignal),
      }),
    );
  });

  it("kills the process before retaining output beyond the byte limit", async () => {
    const fixture = processFixture(["1234", "5678"]);
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { outputBytes: 6 },
      ),
    ).rejects.toMatchObject({
      name: "SandboxCommandLimitError",
      code: "output-limit",
    });
    expect(fixture.kill).toHaveBeenCalledOnce();
  });

  it("accounts stdout and stderr against one shared byte limit", async () => {
    const fixture = processFixture(["1234"], ["5678"]);
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { outputBytes: 6 },
      ),
    ).rejects.toMatchObject({ code: "output-limit" });
    expect(fixture.kill).toHaveBeenCalledOnce();
  });

  it("kills a command that produces no output before its wall timeout", async () => {
    const idle = () => new ReadableStream<Uint8Array>({ start() {} });
    const kill = vi.fn(async () => undefined);
    const process = {
      stdout: idle(),
      stderr: idle(),
      wait: () => new Promise<never>(() => undefined),
      kill,
    } as unknown as SandboxProcess;
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => process },
        { command: "idle" },
        { noOutputTimeoutMs: 10, timeoutMs: 1_000 },
      ),
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
    const kill = vi.fn(async () => undefined);
    const process = {
      stdout: oneThenIdle(),
      stderr: idle(),
      wait: () => new Promise<never>(() => undefined),
      kill,
    } as unknown as SandboxProcess;
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => process },
        { command: "progress-then-idle" },
        { noOutputTimeoutMs: 10, timeoutMs: 1_000 },
      ),
    ).rejects.toMatchObject({ code: "no-output-timeout" });
    expect(kill).toHaveBeenCalledOnce();
  });

  it("does not let a hung provider kill replace the original limit error", async () => {
    const fixture = processFixture(["too much output"]);
    fixture.process.kill = vi.fn(() => new Promise<never>(() => undefined));
    await expect(
      runBoundedSandboxCommand(
        { spawn: async () => fixture.process },
        { command: "generate" },
        { outputBytes: 2, killCleanupTimeoutMs: 10 },
      ),
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
      { command: "true", env: { SAFE_INPUT: "exact" } },
    );
    expect((spawn.mock.calls[0]?.[0] as { env?: unknown }).env).toEqual({
      SAFE_INPUT: "exact",
    });
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("GITHUB_TOKEN");
    expect(JSON.stringify(spawn.mock.calls)).not.toContain("DATABASE_URL");
  });
});
