import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, it } from "vitest";

import {
  createDevelopmentShutdown,
  developmentChildExit,
  stopDevelopmentChild,
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
});
