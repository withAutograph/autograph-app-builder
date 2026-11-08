/* oxlint-disable eslint/require-await -- Async SDK doubles and async generators preserve the native Promise/iterator contracts. */
import { setImmediate as nextTurn } from "node:timers/promises";
import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import { Readable } from "node:stream";
import { text as readNodeText } from "node:stream/consumers";
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
  const diskFixture = () => {
    const directory = mkdtempSync(path.join(os.tmpdir(), "builder-linear-stream-"));
    const native = fixture();
    const uploads: Buffer[] = [];
    native.fs.mkdir.mockImplementation(async (target: string, options: { recursive: true }) => {
      mkdirSync(target, options);
    });
    native.fs.rm.mockImplementation(
      async (target: string, options: { recursive: true; force: true }) => {
        rmSync(target, options);
      },
    );
    native.writeFiles.mockImplementation(
      async (files: { path: string; content: Buffer; mode?: number }[]) => {
        for (const file of files) {
          uploads.push(file.content);
          writeFileSync(file.path, file.content, { mode: file.mode });
        }
      },
    );
    native.runCommand.mockImplementation(async (options: { args?: string[] }) => {
      const result = spawnSync(process.execPath, options.args ?? [], { encoding: "utf-8" });
      if (result.error) {
        throw result.error;
      }
      return {
        wait: async () => ({ exitCode: result.status ?? 1 }),
        kill: vi.fn().mockResolvedValue(null),
      };
    });
    return {
      directory,
      native,
      uploads,

      target: path.join(directory, "output.bin"),
      cleanup: () => {
        rmSync(directory, { recursive: true, force: true });
      },
    };
  };

  it("uploads each byte once in bounded chunks and atomically preserves exact final bytes and mode", async () => {
    const f = diskFixture();
    try {
      writeFileSync(f.target, "prior");
      chmodSync(f.target, 0o750);
      const bytes = Buffer.alloc(17 * 1024 * 1024 + 71);
      for (let index = 0; index < bytes.length; index += 1) {
        bytes[index] = index % 251;
      }
      const content = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let offset = 0; offset < bytes.length; offset += 131_071) {
            controller.enqueue(bytes.subarray(offset, offset + 131_071));
          }
          controller.close();
        },
      });
      const controller = new AbortController();
      await createVercelSdkSession(f.native).writeFile({
        abortSignal: controller.signal,
        content,
        path: f.target,
      });
      expect(readFileSync(f.target).equals(bytes)).toBe(true);
      // oxlint-disable-next-line eslint/no-bitwise -- Verify the existing executable permissions survive atomic replacement.
      expect(statSync(f.target).mode & 0o777).toBe(0o750);
      const uploaded = f.uploads;
      expect(uploaded.reduce((total, file) => total + file.byteLength, 0)).toBe(bytes.length);
      expect(uploaded.every((file) => file.byteLength <= 8 * 1024 * 1024)).toBe(true);
      expect(f.native.fs.appendFile).not.toHaveBeenCalled();
      expect(f.native.readFileToBuffer).not.toHaveBeenCalled();
      expect(readdirSync(f.directory)).toEqual(["output.bin"]);
    } finally {
      f.cleanup();
    }
  });

  it.each(["abort", "stream-error"])(
    "preserves the existing target and cleans owned staging on %s after an upload",
    async (outcome) => {
      const f = diskFixture();
      try {
        writeFileSync(f.target, "prior bytes");
        const controller = new AbortController();
        let pulls = 0;
        const content = new ReadableStream<Uint8Array>(
          {
            pull(stream) {
              pulls += 1;
              if (pulls === 1) {
                stream.enqueue(Buffer.alloc(8 * 1024 * 1024, 1));
              } else if (outcome === "abort") {
                controller.abort(new Error("cancelled-transfer"));
                stream.enqueue(Buffer.from("later"));
              } else {
                stream.error(new Error("failed-stream"));
              }
            },
          },
          { highWaterMark: 0 },
        );
        await expect(
          createVercelSdkSession(f.native).writeFile({
            abortSignal: controller.signal,
            content,
            path: f.target,
          }),
        ).rejects.toThrow();
        expect(readFileSync(f.target, "utf-8")).toBe("prior bytes");
        expect(f.native.writeFiles).toHaveBeenCalledTimes(1);
        expect(readdirSync(f.directory)).toEqual(["output.bin"]);
        expect(f.native.fs.appendFile).not.toHaveBeenCalled();
      } finally {
        f.cleanup();
      }
    },
  );

  it("commits an empty stream and does not publish a failed final assembly", async () => {
    const f = diskFixture();
    try {
      const empty = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.close();
        },
      });
      await createVercelSdkSession(f.native).writeFile({ content: empty, path: f.target });
      expect(statSync(f.target).size).toBe(0);
      writeFileSync(f.target, "prior");
      const original = f.native.writeFiles.getMockImplementation();
      if (!original) {
        throw new Error("Missing file fixture");
      }
      f.native.writeFiles.mockImplementation(
        async (
          files: { path: string; content: Buffer; mode?: number }[],
          options?: { signal?: AbortSignal },
        ) => {
          await original(files, options);
          for (const file of files) {
            rmSync(file.path);
          }
        },
      );
      const content = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Buffer.from("new"));
          controller.close();
        },
      });
      await expect(
        createVercelSdkSession(f.native).writeFile({ content, path: f.target }),
      ).rejects.toThrow("could not complete");
      expect(readFileSync(f.target, "utf-8")).toBe("prior");
      expect(readdirSync(f.directory)).toEqual(["output.bin"]);
    } finally {
      f.cleanup();
    }
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
        yield { data: output.toString(), stream: "stdout" };
        yield { data: "diagnostic", stream: "stderr" };
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
          yield { data: expected.slice(index, index + 32_768), stream: "stdout" };
        }
        yield { data: "lock generation diagnostic\n", stream: "stderr" };
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
        yield { data: "", stream: "stdout" };
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
        yield { data: "partial JSON", stream: "stdout" };
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
      expect(outcome).toMatchObject({ reason: fail, status: "rejected" });
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
        yield { data: "unread output", stream: "stdout" };
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
        yield { data: "unread output", stream: "stdout" };
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
        yield { data: "late tail", stream: "stdout" };
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
      // Child exit can drain an unread stderr pipe before stdout finishes yielding.
      const diagnostic = readNodeText(child.stderr);
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
            yield { data: String(bytes), stream: "stdout" };
          }
          yield { data: await diagnostic, stream: "stderr" };
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

it("reapplies configured toolchain environment to commands on a replacement native handle, preserving command overrides", async () => {
  const native = fixture();
  native.runCommand.mockResolvedValue({
    stdout: async () => "",
    stderr: async () => "",
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  });
  const replacement = fixture();
  replacement.runCommand.mockResolvedValue({
    stdout: async () => "",
    stderr: async () => "",
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  });
  let active = native;
  const session = createVercelSdkSession(native, () => active, undefined, {
    CARGO_HOME: "/private/cargo",
    MISE_DATA_DIR: "/private/mise",
    PATH: "/private/bin:/usr/bin",
  });
  await session.run({ command: "cargo --version", env: { EXPLICIT: "retained" } });
  expect(native.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      env: {
        CARGO_HOME: "/private/cargo",
        EXPLICIT: "retained",
        MISE_DATA_DIR: "/private/mise",
        PATH: "/private/bin:/usr/bin",
      },
    }),
  );
  active = replacement;
  await session.run({
    command: "mise exec -- rustc --version",
    env: { PATH: "/command/bin:/usr/bin" },
  });
  expect(replacement.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      env: {
        CARGO_HOME: "/private/cargo",
        MISE_DATA_DIR: "/private/mise",
        PATH: "/command/bin:/usr/bin",
      },
    }),
  );
});

it("reapplies configured toolchain environment to commands on a replacement native handle, preserving command overrides", async () => {
  const native = fixture();
  native.runCommand.mockResolvedValue({
    stdout: async () => "",
    stderr: async () => "",
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  });
  const replacement = fixture();
  replacement.runCommand.mockResolvedValue({
    stdout: async () => "",
    stderr: async () => "",
    wait: async () => ({ exitCode: 0 }),
    kill: async () => {},
  });
  let active = native;
  const session = createVercelSdkSession(native, () => active, undefined, {
    CARGO_HOME: "/private/cargo",
    MISE_DATA_DIR: "/private/mise",
    PATH: "/private/bin:/usr/bin",
  });
  await session.run({ command: "cargo --version", env: { EXPLICIT: "retained" } });
  expect(native.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      env: {
        CARGO_HOME: "/private/cargo",
        EXPLICIT: "retained",
        MISE_DATA_DIR: "/private/mise",
        PATH: "/private/bin:/usr/bin",
      },
    }),
  );
  active = replacement;
  await session.run({
    command: "mise exec -- rustc --version",
    env: { PATH: "/command/bin:/usr/bin" },
  });
  expect(replacement.runCommand).toHaveBeenLastCalledWith(
    expect.objectContaining({
      env: {
        CARGO_HOME: "/private/cargo",
        MISE_DATA_DIR: "/private/mise",
        PATH: "/command/bin:/usr/bin",
      },
    }),
  );
});
