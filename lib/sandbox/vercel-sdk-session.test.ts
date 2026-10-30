/* oxlint-disable eslint/require-await -- Async SDK doubles and async generators preserve the native Promise/iterator contracts. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import { Readable } from "node:stream";
import { createVercelSdkSession } from "./vercel-sdk-session";

const fixture = () => ({
  expiresAt: new Date(Date.now() + 300_000),
  extendTimeout: vi.fn(async () => {
    await Promise.resolve();
  }),
  fs: {
    appendFile: vi.fn().mockResolvedValue(null),
    mkdir: vi.fn().mockResolvedValue(null),
    rm: vi.fn().mockResolvedValue(null),
    writeFile: vi.fn().mockResolvedValue(null),
  },
  name: "sdk-test",
  readFile: vi.fn(),
  readFileToBuffer: vi.fn(),
  runCommand: vi.fn(),
  update: vi.fn().mockResolvedValue(null),
  writeFiles: vi.fn().mockResolvedValue(null),
});
const text = async (stream: ReadableStream<Uint8Array>) => {
  let result = "";
  for await (const chunk of stream) {
    result += new TextDecoder().decode(chunk);
  }
  return result;
};

describe("Builder SDK session I/O", () => {
  it("writes streaming files incrementally and forwards cancellation without retaining the whole file", async () => {
    const native = fixture();
    const session = createVercelSdkSession(native);
    const { signal } = new AbortController();
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("first"));
        controller.enqueue(Buffer.from("second"));
        controller.close();
      },
    });
    await session.writeFile({ abortSignal: signal, content, path: "directory/new.txt" });
    expect(native.fs.mkdir).toHaveBeenCalledWith("/workspace/directory", {
      recursive: true,
      signal,
    });
    expect(native.fs.writeFile).toHaveBeenCalledWith(
      "/workspace/directory/new.txt",
      Buffer.alloc(0),
      { signal },
    );
    expect(native.fs.appendFile.mock.calls).toEqual([
      ["/workspace/directory/new.txt", Buffer.from("first"), { signal }],
      ["/workspace/directory/new.txt", Buffer.from("second"), { signal }],
    ]);
  });
  it("preserves missing-file, streamed-read, text line and strict UTF-8 semantics", async () => {
    const native = fixture();
    const session = createVercelSdkSession(native);
    native.readFileToBuffer
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from("one\ntwo\nthree\n"))
      .mockResolvedValueOnce(Buffer.from([0xff]));
    expect(await session.readTextFile({ path: "missing" })).toBeNull();
    expect(await session.readTextFile({ endLine: 99, path: "test", startLine: 2 })).toBe(
      "two\nthree\n",
    );
    await expect(session.readTextFile({ path: "bad" })).rejects.toThrow();
    native.readFile.mockResolvedValue(Readable.from([Buffer.from("streamed")]));
    const stream = await session.readFile({ path: "file" });
    expect(
      await text(
        stream ??
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.close();
            },
          }),
      ),
    ).toBe("streamed");
  });
  it("streams detached output with writable backpressure and preserves wait and kill", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    const deferred = Promise.withResolvers<boolean>();
    const finished = deferred.promise;
    const wait = vi.fn(async () => {
      await finished;
      return { exitCode: 7 };
    });
    const output = Buffer.from("x".repeat(100_000));
    native.runCommand.mockResolvedValue({
      kill,
      wait,
      async *logs() {
        yield { stream: "stdout", data: output.toString() };
        yield { stream: "stderr", data: "diagnostic" };
      },
    });
    const process = await createVercelSdkSession(native).spawn({
      command: "bun dev",
      env: { PORT: "3000" },
      workingDirectory: "repository",
    });
    const stdout = text(process.stdout);
    const stderr = text(process.stderr);
    const done = process.wait();
    deferred.resolve(true);
    expect(await done).toEqual({ exitCode: 7 });
    expect(await stdout).toBe(output.toString());
    expect(await stderr).toBe("diagnostic");
    await process.kill();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(native.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ["-c", "bun dev"],
        cmd: "bash",
        cwd: "/workspace/repository",
        detached: true,
        env: { PORT: "3000" },
      }),
    );
  });
  it("drains SDK logs after process exit and preserves large JSON under consumer backpressure", async () => {
    const native = fixture();
    const data = "catalog café entry\n".repeat(90_000);
    const expected = JSON.stringify({ data });
    let exited = false;
    let delivered = 0;
    const command = {
      kill: vi.fn().mockResolvedValue(null),
      wait: vi.fn(async () => {
        exited = true;
        return { exitCode: 7 };
      }),
      async *logs() {
        for (let index = 0; index < expected.length; index += 32_768) {
          // Model the installed SDK's HTTP log stream delivering after wait() has resolved.
          // oxlint-disable-next-line eslint/no-await-in-loop -- Each delayed chunk exercises independent log transport progress.
          await nextTurn();
          delivered += 1;
          yield { stream: "stdout", data: expected.slice(index, index + 32_768) };
        }
        yield { stream: "stderr", data: "lock generation diagnostic\n" };
      },
    };
    native.runCommand.mockImplementation(
      async (params: Parameters<VercelSdkSessionNative["runCommand"]>[0]) => {
        // Match SDK 3.3.0: output options start an unawaited log pipe, independent of wait().
        if (params.stdout !== undefined || params.stderr !== undefined) {
          params.stdout?.on("error", () => {});
          params.stderr?.on("error", () => {});
          void (async () => {
            for await (const log of command.logs()) {
              if (log.stream === "stdout") {
                params.stdout?.write(log.data);
              } else {
                params.stderr?.write(log.data);
              }
            }
          })();
        }
        return command;
      },
    );
    const process = await createVercelSdkSession(native).spawn({ command: "catalog-plan" });
    let completed = false;
    const done = (async () => {
      const result = await process.wait();
      completed = true;
      return result;
    })();
    await nextTurn();
    expect(exited).toBe(true);
    const completedBeforeRead = completed;
    // A producer must not race unboundedly ahead while no consumer is reading.
    expect(delivered).toBeLessThan(4);
    const stdout = (async () => {
      const decoder = new TextDecoder();
      let output = "";
      for await (const chunk of process.stdout) {
        output += decoder.decode(chunk, { stream: true });
        // oxlint-disable-next-line eslint/no-await-in-loop -- Deliberately slower downstream consumption verifies backpressure.
        await nextTurn();
      }
      return output + decoder.decode();
    })();
    const [result, output, diagnostic] = await Promise.all([done, stdout, text(process.stderr)]);
    expect(result.exitCode).toBe(7);
    expect(JSON.parse(output)).toEqual({ data });
    expect(completedBeforeRead).toBe(false);
    expect(diagnostic).toBe("lock generation diagnostic\n");
  });
  it("kills the native process when the caller aborts and lets wait reject", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    const controller = new AbortController();
    native.runCommand.mockResolvedValue({
      kill,
      async *logs() {
        yield { stream: "stdout", data: "" };
      },
      wait: async () => {
        await Promise.resolve();
        throw new Error("caller cancelled");
      },
    });
    const process = await createVercelSdkSession(native).spawn({
      abortSignal: controller.signal,
      command: "sleep 30",
    });
    controller.abort(new Error("caller cancelled"));
    await expect(process.wait()).rejects.toThrow("caller cancelled");
    expect(kill).toHaveBeenCalledOnce();
  });
  it("rejects wait and both output readers when SDK log transport fails after process exit", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    const fail = new Error("SDK log transport disconnected");
    native.runCommand.mockResolvedValue({
      kill,
      wait: async () => ({ exitCode: 0 }),
      async *logs() {
        yield { stream: "stdout", data: "partial JSON" };
        throw fail;
      },
    });
    const process = await createVercelSdkSession(native).spawn({ command: "catalog-plan" });
    let capturedPrefix = "";
    const stdout = (async () => {
      for await (const chunk of process.stdout) {
        capturedPrefix += new TextDecoder().decode(chunk);
      }
    })();
    const outcomes = await Promise.allSettled([process.wait(), stdout, text(process.stderr)]);
    for (const outcome of outcomes) {
      expect(outcome).toMatchObject({ status: "rejected", reason: fail });
    }
    expect(capturedPrefix).toBe("partial JSON");
    expect(kill).toHaveBeenCalledWith("SIGTERM");
  });
  it("cancels a backpressured log drain after process exit and stops the active lease", async () => {
    vi.useFakeTimers();
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    const controller = new AbortController();
    let exited = false;
    native.runCommand.mockResolvedValue({
      kill,
      wait: async () => {
        exited = true;
        return { exitCode: 0 };
      },
      async *logs() {
        yield { stream: "stdout", data: "unread output" };
      },
    });
    try {
      const process = await createVercelSdkSession(native).spawn({
        command: "catalog-plan",
        abortSignal: controller.signal,
      });
      expect(exited).toBe(true);
      controller.abort(new Error("caller cancelled during output drain"));
      const outcomes = await Promise.allSettled([
        process.wait(),
        text(process.stdout),
        text(process.stderr),
      ]);
      for (const outcome of outcomes) {
        expect(outcome.status).toBe("rejected");
      }
      expect(kill).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("kills the native process when an output consumer cancels before draining", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    native.runCommand.mockResolvedValue({
      kill,
      wait: async () => ({ exitCode: 0 }),
      async *logs() {
        yield { stream: "stdout", data: "unread output" };
      },
    });
    const process = await createVercelSdkSession(native).spawn({ command: "catalog-plan" });
    await process.stdout.cancel(new Error("output consumer abandoned"));
    await expect(process.wait()).rejects.toThrow("output consumer abandoned");
    await expect(text(process.stderr)).rejects.toThrow("output consumer abandoned");
    expect(kill).toHaveBeenCalledOnce();
  });
  it("retains the authorized active lease until the final SDK log drains", async () => {
    vi.useFakeTimers();
    const native = { ...fixture(), expiresAt: new Date(Date.now() + 75_000) };
    const authorize = vi.fn().mockResolvedValue(null);
    const tail = Promise.withResolvers<boolean>();
    native.runCommand.mockResolvedValue({
      kill: vi.fn().mockResolvedValue(null),
      wait: async () => ({ exitCode: 0 }),
      async *logs() {
        await tail.promise;
        yield { stream: "stdout", data: "late tail" };
      },
    });
    try {
      const process = await createVercelSdkSession(native, () => native, authorize).spawn({
        command: "catalog-plan",
      });
      const results = Promise.all([process.wait(), text(process.stdout), text(process.stderr)]);
      await vi.advanceTimersByTimeAsync(15_000);
      expect(authorize).toHaveBeenCalledOnce();
      expect(native.extendTimeout).toHaveBeenCalledOnce();
      tail.resolve(true);
      expect(await results).toEqual([{ exitCode: 0 }, "late tail", ""]);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
  it("drains output from a real local Node process through the SDK log interface", async () => {
    const native = fixture();
    const data = "real process JSON café\n".repeat(70_000);
    native.runCommand.mockImplementation(async () => {
      const child = spawn(
        process.execPath,
        [
          "-e",
          'process.stdout.write(JSON.stringify({data:"real process JSON café\\n".repeat(70000)}));process.stderr.write("real diagnostic");',
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      child.stdout.setEncoding("utf-8");
      child.stderr.setEncoding("utf-8");
      const exited = Promise.withResolvers<{ exitCode: number | null }>();
      child.once("error", exited.reject);
      child.once("exit", (code) => {
        exited.resolve({ exitCode: code });
      });
      return {
        kill: async () => {
          child.kill("SIGTERM");
        },
        wait: async () => await exited.promise,
        async *logs() {
          for await (const bytes of child.stdout) {
            yield { stream: "stdout", data: String(bytes) };
          }
          for await (const bytes of child.stderr) {
            yield { stream: "stderr", data: String(bytes) };
          }
        },
      };
    });
    const childProcess = await createVercelSdkSession(native).spawn({
      command: "real-node-fixture",
    });
    const [result, output, diagnostic] = await Promise.all([
      childProcess.wait(),
      text(childProcess.stdout),
      text(childProcess.stderr),
    ]);
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(output)).toEqual({ data });
    expect(diagnostic).toBe("real diagnostic");
  });
  it("returns real command output, signal and nonzero exit status", async () => {
    const native = fixture();
    native.runCommand.mockResolvedValue({
      exitCode: 4,
      kill: vi.fn(),
      stderr: vi.fn().mockResolvedValue("stderr"),
      stdout: vi.fn().mockResolvedValue("stdout"),
      wait: vi.fn().mockResolvedValue({ exitCode: 4 }),
    });
    const { signal } = new AbortController();
    expect(
      await createVercelSdkSession(native).run({
        abortSignal: signal,
        command: "git diff",
      }),
    ).toEqual({ exitCode: 4, stderr: "stderr", stdout: "stdout" });
    expect(native.runCommand).toHaveBeenCalledWith(expect.objectContaining({ cwd: "/workspace" }));
    expect(native.runCommand.mock.calls[0]?.[0]).toHaveProperty("signal");
  });
});

it("keeps the requested SDK working directory despite a login profile that changes directories", async () => {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "sdk-working-directory-")));
  const homeDirectory = path.join(root, "home");
  const child = path.join(root, "child");
  mkdirSync(homeDirectory);
  mkdirSync(child);
  writeFileSync(path.join(homeDirectory, ".bash_profile"), `cd "${child}"\n`);
  const native = fixture();
  native.runCommand.mockImplementation(
    async (params: Parameters<VercelSdkSessionNative["runCommand"]>[0]) => {
      await Promise.resolve();
      const result = spawnSync(params.cmd, params.args ?? [], {
        cwd: params.cwd,
        encoding: "utf-8",
        env: { ...process.env, ...params.env },
      });
      return {
        exitCode: result.status,
        kill: vi.fn(async () => {
          await Promise.resolve();
        }),
        stderr: async () => await Promise.resolve(result.stderr),
        stdout: async () => await Promise.resolve(result.stdout),
        wait: async () => await Promise.resolve({ exitCode: result.status }),
      };
    },
  );
  try {
    const result = await createVercelSdkSession(native).run({
      command: "pwd",
      env: { HOME: homeDirectory },
      workingDirectory: root,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe(root);
  } finally {
    rmSync(root, { force: true, recursive: true });
  }
});

it("kills a running command when renewal fails and leaves no idle renewal", async () => {
  vi.useFakeTimers();
  const native = { ...fixture(), expiresAt: new Date(Date.now() + 75_000) };
  native.extendTimeout.mockRejectedValue(new Error("renewal unavailable"));
  const kill = vi.fn(async () => {
    await Promise.resolve();
  });
  const wait = vi.fn(async (options: { signal?: AbortSignal }) => {
    const deferred = Promise.withResolvers<{ exitCode: number }>();
    options.signal?.addEventListener(
      "abort",
      () => {
        deferred.reject(new Error("renewal unavailable"));
      },
      { once: true },
    );
    return await deferred.promise;
  });
  native.runCommand.mockResolvedValue({
    kill,
    stderr: async () => await Promise.resolve(""),
    stdout: async () => await Promise.resolve(""),
    wait,
  });
  try {
    const pending = createVercelSdkSession(native).run({
      command: "mise run --no-deps app:describe spend-review",
    });
    const rejected = expect(pending).rejects.toThrow("renewal unavailable");
    await vi.advanceTimersByTimeAsync(15_000);
    await rejected;
    expect(kill).toHaveBeenCalledOnce();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    await vi.advanceTimersByTimeAsync(600_000);
    expect(native.extendTimeout).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    vi.useRealTimers();
  }
});
