import { describe, expect, it, vi } from "vitest";

import type { SandboxProcess } from "eve/sandbox";
import {
  quotaWrappedSandboxCommand,
  runBoundedSandboxCommand,
} from "./bounded-command";

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
  it("wraps every command with process, file, and workspace quotas", () => {
    const command = quotaWrappedSandboxCommand("mise run check");
    for (const required of [
      "ulimit -t",
      "ulimit -f",
      "ulimit -n",
      "ulimit -u",
      "setsid bash",
      "du -sx --block-size=1 /workspace",
      "find /workspace -xdev -type f",
      "kill -KILL -- -",
    ])
      expect(command).toContain(required);
  });

  it("collects bounded output through spawn rather than buffered run", async () => {
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
        command: expect.stringContaining("setsid bash"),
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
