import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

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
      { stdio: "ignore" },
    );
    const exited = developmentChildExit(child);
    const stopping = waitForDevelopmentShutdown(
      shutdown.signal,
      shutdown.exitCode,
    );

    signals.emit("SIGTERM");
    expect(await stopping).toEqual({ kind: "stop", code: 143 });
    await stopDevelopmentChild(child);
    expect(await exited).toBe(1);
    shutdown.dispose();
  });

  it("uses the conventional SIGINT exit code", async () => {
    const signals = new EventEmitter();
    const shutdown = createDevelopmentShutdown(signals);
    const stopping = waitForDevelopmentShutdown(
      shutdown.signal,
      shutdown.exitCode,
    );
    signals.emit("SIGINT");
    expect(await stopping).toEqual({ kind: "stop", code: 130 });
    shutdown.dispose();
  });

  it("stops a detached Eve-style process group as one local cycle", async () => {
    if (process.platform === "win32") return;
    const child = spawn(
      process.execPath,
      [
        "-e",
        [
          'require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });',
          "setInterval(() => {}, 1000);",
        ].join(""),
      ],
      { detached: true, stdio: "ignore" },
    );
    const exited = developmentChildExit(child);

    await stopDevelopmentChild(child, { processGroup: true });
    expect(await exited).toBe(1);
  });

  it("cleans up a listener when the Eve wrapper exits before its descendant", async () => {
    if (process.platform === "win32") return;
    const port = 43987;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "require('node:net').createServer().listen(${port}); setInterval(() => {}, 1000)"], { stdio: "ignore" }); child.unref();`,
      ],
      { detached: true, stdio: "ignore" },
    );
    await developmentChildExit(child);

    await stopDevelopmentChild(child, { processGroup: true });
    await waitForDevelopmentPortRelease(port, { timeoutMs: 2_000 });
  });

  it("allows Eve's nested detached server time to settle after the wrapper exits", async () => {
    if (process.platform === "win32") return;
    const port = 43988;
    const child = spawn(
      process.execPath,
      [
        "-e",
        `const child = require("node:child_process").spawn(process.execPath, ["-e", "const server = require('node:net').createServer().listen(${port}); process.on('message', (message) => { if (message === 'shutdown') setTimeout(() => server.close(() => process.exit(0)), 850); }); setInterval(() => {}, 1000)"], { detached: true, stdio: ["ignore", "ignore", "ignore", "ipc"] }); child.unref(); process.on("SIGTERM", () => { child.send("shutdown"); process.exit(0); });`,
      ],
      { detached: true, stdio: "ignore" },
    );
    await stopDevelopmentChild(child, {
      processGroup: true,
      gracefulTimeoutMs: 1_100,
    });
    await waitForDevelopmentPortRelease(port, { timeoutMs: 2_000 });
  });
});
