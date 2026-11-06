import { spawnSync } from "node:child_process";
import { runInNewContext } from "node:vm";
import { describe, expect, it } from "vitest";
import {
  inspectSandboxRuntimeResources,
  runtimeResourceDiagnosticProgram,
} from "./runtime-resource-diagnostics";

const facts = (program = runtimeResourceDiagnosticProgram) => {
  const result = spawnSync(process.execPath, ["-e", program], { encoding: "utf-8" });
  return { exitCode: result.status ?? 1, stderr: result.stderr, stdout: result.stdout };
};
describe("bounded runtime resource diagnostics", () => {
  it("runs the actual fixed observation program and preserves advisory scope", async () => {
    const observed = await inspectSandboxRuntimeResources({
      run: async () => facts(),
    });
    expect(observed.available).toBe(true);
    if (!observed.available) {
      throw new Error("Expected actual process observation");
    }
    expect(observed.observations.availableParallelism).toBeGreaterThan(0);
    expect(observed.observations.installed.map(({ name }) => name)).toEqual(["oxlint", "vp"]);
    expect(observed).not.toHaveProperty("ready");
  });
  it("returns only allowlisted numeric Linux facts and version identifiers, excluding environment and raw tool output", () => {
    let output = "";
    const files = new Map([
      [
        "/proc/meminfo",
        "MemTotal: 4000000 kB\nCommitLimit: 2000000 kB\nCommitted_AS: 1900000 kB\nSecret: credential\n",
      ],
      [
        "/proc/self/limits",
        "Max address space         unlimited            unlimited            bytes\nMax data size             1000                 2000                 bytes\nMax secret                private              private              bytes\n",
      ],
      ["/proc/sys/vm/overcommit_memory", "2\n"],
    ]);
    // oxlint-disable-next-line sonarjs/code-eval -- Execute only the repository-owned fixed diagnostic program with closed fixture I/O.
    runInNewContext(runtimeResourceDiagnosticProgram, {
      process: {
        stdout: {
          write: (value: string) => {
            output = value;
          },
        },
      },
      require: (name: string) => {
        if (name === "node:fs") {
          return {
            readFileSync: (file: string) => files.get(file),
            realpathSync: (file: string) => file,
          };
        }
        if (name === "node:os") {
          return {
            arch: () => "x64",
            availableParallelism: () => 2,
            platform: () => "linux",
            totalmem: () => 4_000_000_000,
          };
        }
        if (name === "node:child_process") {
          return {
            spawnSync: (_file: string, args: string[]) => ({
              status: 0,
              stderr: args[0] === "--version" ? "vp v0.3.1\nprivate" : "private",
              stdout: args[0] === "toolchain" ? "oxlint@1.81.0\nprivate" : "",
            }),
          };
        }
        throw new Error("Unexpected dependency");
      },
    });
    expect(output).toContain('"overcommitMemory":"2"');
    expect(output).toContain('"Committed_AS":1900000');
    expect(output).toContain('"version":"1.81.0"');
    expect(output).toContain('"version":"0.3.1"');
    expect(output).toContain('"versionSource":"vite-plus-toolchain"');
    expect(output).not.toMatch(/credential|private|Secret|secret|stderr|environment/u);
  });
  it("preserves command refusal without retaining raw output or guessing capacity", async () => {
    const result = await inspectSandboxRuntimeResources({
      run: async () => ({ exitCode: 1, stderr: "private stderr", stdout: "private stdout" }),
    });
    expect(result).toEqual({ available: false, exitCode: 1 });
  });
});
