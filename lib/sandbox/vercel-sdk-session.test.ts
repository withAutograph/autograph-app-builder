import { describe, expect, it, vi } from "vitest";
import type { Sandbox } from "@vercel/sandbox";
import { Readable } from "node:stream";
import { createVercelSdkSession } from "./vercel-sdk-session";

const fixture = () => ({
  name: "sdk-test",
  fs: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    writeFile: vi.fn().mockResolvedValue(undefined),
    appendFile: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  writeFiles: vi.fn().mockResolvedValue(undefined),
  readFileToBuffer: vi.fn(),
  readFile: vi.fn(),
  runCommand: vi.fn(),
  update: vi.fn().mockResolvedValue(undefined),
});
const text = async (stream: ReadableStream<Uint8Array>) => {
  let result = "";
  for await (const chunk of stream) result += new TextDecoder().decode(chunk);
  return result;
};

describe("Builder SDK session I/O", () => {
  it("writes streaming files incrementally and forwards cancellation without retaining the whole file", async () => {
    const native = fixture();
    const session = createVercelSdkSession(native as unknown as Sandbox);
    const { signal } = new AbortController();
    const content = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Buffer.from("first"));
        controller.enqueue(Buffer.from("second"));
        controller.close();
      },
    });
    await session.writeFile({ path: "directory/new.txt", content, abortSignal: signal });
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
    const session = createVercelSdkSession(native as unknown as Sandbox);
    native.readFileToBuffer
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(Buffer.from("one\ntwo\nthree\n"))
      .mockResolvedValueOnce(Buffer.from([0xff]));
    expect(await session.readTextFile({ path: "missing" })).toBeNull();
    expect(await session.readTextFile({ path: "test", startLine: 2, endLine: 99 })).toBe(
      "two\nthree\n",
    );
    await expect(session.readTextFile({ path: "bad" })).rejects.toThrow();
    native.readFile.mockResolvedValue(Readable.from([Buffer.from("streamed")]));
    const stream = await session.readFile({ path: "file" });
    expect(await text(stream!)).toBe("streamed");
  });
  it("streams detached output with writable backpressure and preserves wait and kill", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(undefined);
    let finish!: () => void;
    const finished = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const wait = vi.fn(async () => {
      await finished;
      return { exitCode: 7 };
    });
    const output = Buffer.from("x".repeat(100_000));
    native.runCommand.mockImplementation(async (params) => {
      expect(params.stdout.write(output)).toBe(false);
      params.stderr.write(Buffer.from("diagnostic"));
      return { wait, kill };
    });
    const process = await createVercelSdkSession(native as unknown as Sandbox).spawn({
      command: "bun dev",
      workingDirectory: "repository",
      env: { PORT: "3000" },
    });
    const stdout = text(process.stdout);
    const stderr = text(process.stderr);
    const done = process.wait();
    finish();
    expect(await done).toEqual({ exitCode: 7 });
    expect(await stdout).toBe(output.toString());
    expect(await stderr).toBe("diagnostic");
    await process.kill();
    expect(kill).toHaveBeenCalledWith("SIGTERM");
    expect(native.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        cmd: "bash",
        args: ["-lc", "bun dev"],
        cwd: "/workspace/repository",
        env: { PORT: "3000" },
        detached: true,
      }),
    );
  });
  it("kills the native process when the caller aborts and lets wait reject", async () => {
    const native = fixture();
    const kill = vi.fn().mockResolvedValue(undefined);
    const controller = new AbortController();
    native.runCommand.mockResolvedValue({
      kill,
      wait: () => Promise.reject(controller.signal.reason),
    });
    const process = await createVercelSdkSession(native as unknown as Sandbox).spawn({
      command: "sleep 30",
      abortSignal: controller.signal,
    });
    controller.abort(new Error("caller cancelled"));
    await expect(process.wait()).rejects.toThrow("caller cancelled");
    expect(kill).toHaveBeenCalledOnce();
  });
  it("returns real command output, signal and nonzero exit status", async () => {
    const native = fixture();
    native.runCommand.mockResolvedValue({
      exitCode: 4,
      stdout: vi.fn().mockResolvedValue("stdout"),
      stderr: vi.fn().mockResolvedValue("stderr"),
    });
    const { signal } = new AbortController();
    expect(
      await createVercelSdkSession(native as unknown as Sandbox).run({
        command: "git diff",
        abortSignal: signal,
      }),
    ).toEqual({ exitCode: 4, stdout: "stdout", stderr: "stderr" });
    expect(native.runCommand).toHaveBeenCalledWith(
      expect.objectContaining({ signal, cwd: "/workspace" }),
    );
  });
});
