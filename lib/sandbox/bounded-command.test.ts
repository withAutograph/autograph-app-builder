import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import type { SandboxProcess } from "eve/sandbox";
import {
  WORKSPACE_QUOTA_MONITOR_SCRIPT,
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

function waitForExit(process: ReturnType<typeof spawn>) {
  return new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      process.once("error", reject);
      process.once("exit", (code, signal) => resolve({ code, signal }));
    },
  );
}

function readStream(stream: NodeJS.ReadableStream) {
  let output = "";
  stream.setEncoding("utf8");
  stream.on("data", (chunk: string) => {
    output += chunk;
  });
  return () => output;
}

function startMonitor(
  child: ReturnType<typeof spawn>,
  workspaceRoot: string,
  maximumBytes: number,
  maximumFiles: number,
  preload?: string,
) {
  const monitor = spawn(
    process.execPath,
    [
      ...(preload === undefined ? [] : ["--require", preload]),
      "-e",
      WORKSPACE_QUOTA_MONITOR_SCRIPT,
      "--",
      String(child.pid),
      String(maximumBytes),
      String(maximumFiles),
      "10",
      workspaceRoot,
    ],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  return { monitor, stderr: readStream(monitor.stderr) };
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
      "node -e",
      "sandbox_workspace_quota_exceeded",
      'wait "$monitor"',
    ])
      expect(command).toContain(required);
    expect(command).toContain("ulimit -f 131072");
    expect(command.match(/node -e/g)).toHaveLength(1);
    expect(command).not.toContain("bun -e");
    for (const repeatedProcess of [
      "du -sx",
      "find /workspace",
      "awk ",
      "wc -c",
    ])
      expect(command).not.toContain(repeatedProcess);
  });

  it("terminates the child group and exits 125 when workspace limits are exceeded", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "quota-monitor-limit-"));
    await writeFile(join(workspaceRoot, "one-file"), "content");
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    const childExit = waitForExit(child);
    const fixture = startMonitor(
      child,
      workspaceRoot,
      Number.MAX_SAFE_INTEGER,
      0,
    );
    const monitorExit = await waitForExit(fixture.monitor);
    const childResult = await childExit;
    expect(monitorExit).toEqual({ code: 125, signal: null });
    expect(childResult).toEqual({ code: null, signal: "SIGKILL" });
    expect(fixture.stderr()).toBe("sandbox_workspace_quota_exceeded\n");
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("terminates the child group when workspace traversal fails", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "quota-monitor-error-"));
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    const childExit = waitForExit(child);
    const fixture = startMonitor(
      child,
      join(workspaceRoot, "missing"),
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    const monitorExit = await waitForExit(fixture.monitor);
    const childResult = await childExit;
    expect(monitorExit).toEqual({ code: 2, signal: null });
    expect(childResult).toEqual({ code: null, signal: "SIGKILL" });
    expect(fixture.stderr()).toContain(
      "sandbox_workspace_quota_monitor_failed:",
    );
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("counts raw-byte file names without decoding them", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "quota-monitor-bytes-"));
    const preload = join(workspaceRoot, "raw-byte-filesystem.cjs");
    await writeFile(
      preload,
      String.raw`
const filesystem = require("node:fs");
const root = Buffer.from("/workspace");
const rawFile = Buffer.concat([root, Buffer.from("/"), Buffer.from([0xff])]);
filesystem.lstatSync = (path) => {
  if (Buffer.isBuffer(path) && path.equals(root))
    return {
      dev: 1,
      ino: 1,
      blocks: 0,
      isFile: () => false,
      isDirectory: () => true,
    };
  if (Buffer.isBuffer(path) && path.equals(rawFile))
    return {
      dev: 1,
      ino: 2,
      blocks: 1,
      isFile: () => true,
      isDirectory: () => false,
    };
  throw new Error("monitor decoded or changed the raw-byte path");
};
filesystem.readdirSync = (path, options) => {
  if (!Buffer.isBuffer(path) || !path.equals(root))
    throw new Error("monitor changed the raw-byte directory path");
  if (options?.encoding !== "buffer")
    throw new Error("monitor did not request raw directory entries");
  return [Buffer.from([0xff])];
};
`,
    );
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    const childExit = waitForExit(child);
    const fixture = startMonitor(
      child,
      "/workspace",
      Number.MAX_SAFE_INTEGER,
      0,
      preload,
    );
    const monitorExit = await waitForExit(fixture.monitor);
    const childResult = await childExit;
    expect(monitorExit).toEqual({ code: 125, signal: null });
    expect(childResult).toEqual({ code: null, signal: "SIGKILL" });
    expect(fixture.stderr()).toBe("sandbox_workspace_quota_exceeded\n");
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("exits cleanly after the child exits", async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), "quota-monitor-exit-"));
    const child = spawn("/bin/sh", ["-c", "sleep 0.05"], {
      detached: true,
      stdio: "ignore",
    });
    const childExit = waitForExit(child);
    const fixture = startMonitor(
      child,
      workspaceRoot,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    await childExit;
    await expect(waitForExit(fixture.monitor)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    expect(fixture.stderr()).toBe("");
    await rm(workspaceRoot, { recursive: true, force: true });
  });

  it("settles cleanly when the monitor is cancelled", async () => {
    const workspaceRoot = await mkdtemp(
      join(tmpdir(), "quota-monitor-cancel-"),
    );
    const child = spawn("/bin/sh", ["-c", "trap '' TERM; sleep 30"], {
      detached: true,
      stdio: "ignore",
    });
    const childExit = waitForExit(child);
    const fixture = startMonitor(
      child,
      workspaceRoot,
      Number.MAX_SAFE_INTEGER,
      Number.MAX_SAFE_INTEGER,
    );
    await new Promise((resolve) => setTimeout(resolve, 200));
    fixture.monitor.kill("SIGTERM");
    const childResult = await childExit;
    await expect(waitForExit(fixture.monitor)).resolves.toEqual({
      code: 0,
      signal: null,
    });
    expect(childResult).toEqual({ code: null, signal: "SIGKILL" });
    expect(fixture.stderr()).toBe("");
    await rm(workspaceRoot, { recursive: true, force: true });
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
