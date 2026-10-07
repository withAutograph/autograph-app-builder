import { spawnSync } from "node:child_process";
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
    native.runCommand.mockImplementation(
      async (params: Parameters<VercelSdkSessionNative["runCommand"]>[0]) => {
        await Promise.resolve();
        if (params.stdout === undefined || params.stderr === undefined) {
          throw new Error("Detached output streams missing");
        }
        expect(params.stdout.write(output)).toBe(false);
        params.stderr.write(Buffer.from("diagnostic"));
        return { kill, wait };
      },
    );
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
  it("kills the native process when the caller aborts and lets wait reject", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(null);
    const controller = new AbortController();
    native.runCommand.mockResolvedValue({
      kill,
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
      command: "mise run app:describe spend-review",
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
