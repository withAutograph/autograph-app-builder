/* eslint-disable unicorn/prefer-event-target -- Node ChildProcess lifecycle tests require EventEmitter semantics. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import {
  createEveEvalRuntimeDirectories,
  reconcileDeadEveEvalPrewarmLocks,
  waitForEveEvalChild,
} from "./eve-eval-lifecycle";

function lockFixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "eve-eval-locks-")));
  const backend = join(root, ".eve", "sandbox-cache", "template-locks", "vercel-authorized");
  mkdirSync(backend, { recursive: true });
  const addLock = (name: string, owner: unknown) => {
    const lock = join(backend, `${name}.lock`);
    mkdirSync(lock);
    writeFileSync(join(lock, "owner.json"), `${JSON.stringify(owner)}\n`, {
      mode: 0o600,
    });
    return lock;
  };
  return { addLock, backend, root };
}

async function startServer(port: number) {
  const child = spawn(
    process.execPath,
    [
      "-e",
      [
        'const { createServer } = require("node:net");',
        "const server = createServer();",
        "server.listen(Number(process.argv[1]), '127.0.0.1', () => process.send(server.address().port));",
        "process.on('SIGTERM', () => server.close(() => process.exit(143)));",
      ].join(""),
      String(port),
    ],
    {
      detached: process.platform !== "win32",
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    },
  );
  const ready = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("message", (message) => resolve(Number(message)));
  });
  return { child, port: ready };
}

describe("Eve eval resource lifecycle", () => {
  it("removes only an exact dead-owner prewarm lock and is repeatable", async () => {
    const fixture = lockFixture();
    const dead = fixture.addLock("dead", {
      createdAt: "2026-09-12T12:00:00.000Z",
      pid: 17_158,
    });
    const active = fixture.addLock("active", {
      createdAt: "2026-09-12T12:00:00.000Z",
      pid: process.pid,
    });
    const malformed = fixture.addLock("malformed", {
      pid: 17_158,
    });

    const first = await reconcileDeadEveEvalPrewarmLocks(fixture.root, {
      processAlive: (pid) => pid === process.pid,
    });
    expect(first).toEqual([
      expect.objectContaining({ pid: process.pid, status: "active" }),
      expect.objectContaining({ pid: 17_158, status: "removed" }),
      expect.objectContaining({
        status: "preserved",
        reason: "owner.json did not match Eve's lock schema",
      }),
    ]);
    expect(existsSync(dead)).toBe(false);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(malformed)).toBe(true);

    const second = await reconcileDeadEveEvalPrewarmLocks(fixture.root, {
      processAlive: (pid) => pid === process.pid,
    });
    expect(second).toEqual([
      expect.objectContaining({ pid: process.pid, status: "active" }),
      expect.objectContaining({ status: "preserved" }),
    ]);
  });

  it("preserves a symlinked lock instead of following it", async () => {
    const fixture = lockFixture();
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "eve-eval-outside-")));
    writeFileSync(
      join(outside, "owner.json"),
      `${JSON.stringify({ createdAt: new Date().toISOString(), pid: 1 })}\n`,
    );
    const lock = join(fixture.backend, "linked.lock");
    symlinkSync(outside, lock);

    await expect(
      reconcileDeadEveEvalPrewarmLocks(fixture.root, {
        processAlive: () => false,
      }),
    ).resolves.toEqual([
      expect.objectContaining({
        lock: expect.stringContaining("linked.lock"),
        status: "preserved",
      }),
    ]);
    expect(existsSync(join(outside, "owner.json"))).toBe(true);
  });

  it("creates a unique owner-only HOME and workflow database boundary", () => {
    const first = createEveEvalRuntimeDirectories();
    const second = createEveEvalRuntimeDirectories();

    expect(first.root).not.toBe(second.root);
    for (const path of [
      first.root,
      first.home,
      first.workflowData,
      second.root,
      second.home,
      second.workflowData,
    ]) {
      const info = lstatSync(path);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o077).toBe(0);
    }
  });

  it("releases the listener and permits an immediate same-port restart", async () => {
    const signals = new EventEmitter();
    const first = await startServer(0);
    const firstAuthorization = new PassThrough();
    const firstExit = waitForEveEvalChild({
      authorization: firstAuthorization,
      child: first.child,
      signalTarget: signals,
    });
    signals.emit("SIGTERM");
    await expect(firstExit).resolves.toBe(143);
    expect(firstAuthorization.destroyed).toBe(true);
    expect(signals.listenerCount("SIGINT")).toBe(0);
    expect(signals.listenerCount("SIGTERM")).toBe(0);

    const second = await startServer(first.port);
    const secondExit = waitForEveEvalChild({
      authorization: new PassThrough(),
      child: second.child,
      signalTarget: signals,
    });
    signals.emit("SIGTERM");
    await expect(secondExit).resolves.toBe(143);
  });

  it("forces only the detached eval group after a repeated interruption", async () => {
    if (process.platform === "win32") return;
    const signals = new EventEmitter();
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
      pid: { value: 54_589 },
    });
    const directSignals: (NodeJS.Signals | number | undefined)[] = [];
    child.kill = ((signal?: NodeJS.Signals | number) => {
      directSignals.push(signal);
      return true;
    }) as ChildProcess["kill"];
    const groupSignals: Parameters<typeof process.kill>[1][] = [];
    const kill = vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      groupSignals.push(signal);
      if (signal === "SIGKILL") child.emit("exit", null, "SIGKILL");
      return true;
    });

    try {
      const exit = waitForEveEvalChild({
        authorization: new PassThrough(),
        child,
        gracefulTimeoutMs: 60_000,
        signalTarget: signals,
      });
      signals.emit("SIGINT");
      signals.emit("SIGINT");
      await expect(exit).resolves.toBe(130);
      expect(directSignals).toEqual(["SIGINT"]);
      expect(groupSignals).toEqual(["SIGKILL", "SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  it("cleans the task-owned group after a successful Eve wrapper exit", async () => {
    if (process.platform === "win32") return;
    const child = new EventEmitter() as ChildProcess;
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      signalCode: { value: null, writable: true },
      pid: { value: 54_590 },
    });
    child.kill = vi.fn(() => true) as ChildProcess["kill"];
    const kill = vi.spyOn(process, "kill").mockImplementation(() => true);

    try {
      const exit = waitForEveEvalChild({
        authorization: new PassThrough(),
        child,
        signalTarget: new EventEmitter(),
      });
      child.emit("exit", 0, null);
      await expect(exit).resolves.toBe(0);
      expect(kill).toHaveBeenCalledTimes(1);
      expect(kill).toHaveBeenCalledWith(-54_590, "SIGKILL");
    } finally {
      kill.mockRestore();
    }
  });
});
