import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it, vi } from "vitest";

import {
  createDevelopmentShutdown,
  developmentChildExit,
  stopDevelopmentChild,
  waitForDevelopmentPortRelease,
  waitForDevelopmentShutdown,
} from "./process-supervisor";

describe("development process supervision", () => {
  it("turns SIGTERM into orderly child shutdown and the conventional exit code", async () => {
    const signals = new EventEmitter();
    const shutdown = createDevelopmentShutdown(signals);
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)"],
      { stdio: "ignore" }
    );
    const exited = developmentChildExit(child);
    const stopping = waitForDevelopmentShutdown(
      shutdown.signal,
      shutdown.exitCode
    );

    signals.emit("SIGTERM");
    expect(await stopping).toEqual({ code: 143, kind: "stop" });
    await stopDevelopmentChild(child);
    expect(await exited).toBe(1);
    shutdown.dispose();
  });

  it("uses the conventional SIGINT exit code", async () => {
    const signals = new EventEmitter();
    const shutdown = createDevelopmentShutdown(signals);
    const stopping = waitForDevelopmentShutdown(
      shutdown.signal,
      shutdown.exitCode
    );
    signals.emit("SIGINT");
    expect(await stopping).toEqual({ code: 130, kind: "stop" });
    shutdown.dispose();
  });

  it("stops a detached Eve-style process group as one local cycle", async () => {
    if (process.platform === "win32") {
      return;
    }
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { detached: true, stdio: "ignore" }
    );
    const exited = developmentChildExit(child);

    await stopDevelopmentChild(child, { processGroup: true });
    expect(await exited).toBe(1);
  });

  it("signals the Eve wrapper once before forcing its task-owned group", async () => {
    if (process.platform === "win32") {
      return;
    }
    const child = new EventEmitter() as ChildProcess;
    const directSignals: (NodeJS.Signals | number | undefined)[] = [];
    const groupSignals: Parameters<typeof process.kill>[1][] = [];
    Object.defineProperties(child, {
      exitCode: { value: null, writable: true },
      pid: { value: 43_210 },
      signalCode: { value: null, writable: true },
    });
    child.kill = ((signal?: NodeJS.Signals | number) => {
      directSignals.push(signal);
      return true;
    }) as ChildProcess["kill"];
    const kill = vi
      .spyOn(process, "kill")
      .mockImplementation((_pid, signal) => {
        groupSignals.push(signal);
        if (signal === "SIGKILL") {
          child.emit("exit", null, "SIGKILL");
        }
        return true;
      });

    try {
      await stopDevelopmentChild(child, {
        gracefulTimeoutMs: 1,
        processGroup: true,
      });
      expect(directSignals).toEqual(["SIGTERM"]);
      expect(groupSignals).toEqual(["SIGKILL"]);
    } finally {
      kill.mockRestore();
    }
  });

  it("cleans up a listener when the Eve wrapper exits before its descendant", async () => {
    if (process.platform === "win32") {
      return;
    }
    const port = 43_987;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "require('node:net').createServer().listen(${port}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();`,
      ],
      { detached: true, stdio: "ignore" }
    );
    await developmentChildExit(child);

    await stopDevelopmentChild(child, { processGroup: true });
    await waitForDevelopmentPortRelease(port, { timeoutMs: 2000 });
  });

  it("allows Eve's nested detached server time to settle after the wrapper exits", async () => {
    if (process.platform === "win32") {
      return;
    }
    const port = 43_988;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "const server = require('node:net').createServer().listen(${port}); process.on('message', (message) => { if (message === 'shutdown') setTimeout(() => server.close(() => process.exit(0)), 850); }); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }); child.unref(); process.on("SIGTERM", () => { child.send("shutdown"); process.exit(0); });`,
      ],
      { detached: true, stdio: "ignore" }
    );
    await stopDevelopmentChild(child, {
      gracefulTimeoutMs: 1_100,
      processGroup: true,
    });
    await waitForDevelopmentPortRelease(port, { timeoutMs: 2000 });
  });
});
