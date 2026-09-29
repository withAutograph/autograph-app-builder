import { describe, expect, it, vi } from "vitest";
import type { VercelSdkSessionNative } from "./vercel-sdk-session";
import { Readable } from "node:stream";
import { createVercelSdkSession } from "./vercel-sdk-session";

const fixture = () => ({
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
        args: ["-lc", "bun dev"],
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
      stderr: vi.fn().mockResolvedValue("stderr"),
      stdout: vi.fn().mockResolvedValue("stdout"),
    });
    const { signal } = new AbortController();
    expect(
      await createVercelSdkSession(native).run({
        abortSignal: signal,
        command: "git diff",
      }),
    ).toEqual({ exitCode: 4, stderr: "stderr", stdout: "stdout" });
    expect(native.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace", signal }),
    );
  });
});
