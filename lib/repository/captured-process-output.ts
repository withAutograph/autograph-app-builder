import { execFileSync, spawn } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";

/** Stream command stdout with backpressure and verify process completion.
 * @yields {Uint8Array} Byte chunks from stdout.
 */
export const streamProcessStdout = async function* streamProcessStdout(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): AsyncGenerator<Uint8Array> {
  const child = spawn(command, [...args], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["ignore", "pipe", "inherit"],
  });
  // oxlint-disable-next-line promise/avoid-new -- Node ChildProcess exposes events rather than a completion promise.
  const completion = new Promise<void>((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) {
        resolve();
      } else {
        const reason = code === null ? `on signal ${signal ?? "unknown"}` : `with status ${code}`;
        reject(new Error(`${command} exited ${reason}.`));
      }
    });
  });
  // Observe an early spawn failure while the consumer is waiting on stdout.
  // oxlint-disable-next-line github/no-then, promise/prefer-await-to-then -- Attach a rejection observer before stdout iteration begins.
  void completion.catch(() => {
    // The generator awaits completion after it drains stdout.
  });
  try {
    if (child.stdout === null) {
      throw new Error(`${command} did not provide stdout.`);
    }
    for await (const chunk of child.stdout) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error(`${command} returned non-byte stdout.`);
      }
      yield chunk;
    }
    await completion;
  } finally {
    if (child.exitCode === null) {
      child.kill();
    }
    try {
      await completion;
    } catch {
      // Preserve the original stream or cancellation error.
    }
  }
};

/** Adapt streamed command stdout to a provider file-write stream. */
export const processStdoutByteStream = (
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): ReadableStream<Uint8Array> => {
  const iterator = streamProcessStdout(command, args, options)[Symbol.asyncIterator]();
  return new ReadableStream({
    async cancel() {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- AsyncGenerator.return requires an explicit argument.
      await iterator.return?.(undefined);
    },
    async pull(controller) {
      const result = await iterator.next();
      if (result.done === true) {
        controller.close();
      } else {
        controller.enqueue(result.value);
      }
    },
  });
};

/** Captures a command's stdout through a temp file, without execFile's output cap. */
export const captureProcessStdout = function captureProcessStdout(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv; input?: string | Uint8Array } = {},
): Buffer {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "app-builder-command-output-"));
  const outputPath = nodePath.join(directory, "stdout");
  const outputFd = openSync(outputPath, "w");
  try {
    const execOptions: ExecFileSyncOptions = {
      stdio: [options.input === undefined ? "ignore" : "pipe", outputFd, "inherit"],
    };
    if (options.cwd !== undefined) {
      execOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      execOptions.env = options.env;
    }
    if (options.input !== undefined) {
      execOptions.input = options.input;
    }
    execFileSync(command, [...args], execOptions);
    return readFileSync(outputPath);
  } finally {
    closeSync(outputFd);
    rmSync(directory, { force: true, recursive: true });
  }
};

/** Synchronous digest for repository inspections that cannot retain blob output. */
export const digestProcessStdoutSync = function digestProcessStdoutSync(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): string {
  const directory = mkdtempSync(nodePath.join(tmpdir(), "app-builder-command-digest-"));
  const outputPath = nodePath.join(directory, "stdout");
  const outputFd = openSync(outputPath, "w");
  try {
    execFileSync(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", outputFd, "inherit"],
    });
    const inputFd = openSync(outputPath, "r");
    try {
      const hash = createHash("sha256");
      const chunk = Buffer.allocUnsafe(64 * 1024);
      for (;;) {
        const length = readSync(inputFd, chunk, 0, chunk.length, null);
        if (length === 0) {
          return hash.digest("hex");
        }
        hash.update(chunk.subarray(0, length));
      }
    } finally {
      closeSync(inputFd);
    }
  } finally {
    closeSync(outputFd);
    rmSync(directory, { force: true, recursive: true });
  }
};

/* eslint-disable eslint/no-await-in-loop -- Hash output chunks incrementally to bound memory. */
export const digestProcessStdout = async function digestProcessStdout(
  command: string,
  args: readonly string[],
  options: { cwd?: string; env?: NodeJS.ProcessEnv } = {},
): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of streamProcessStdout(command, args, options)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
};
/* eslint-enable eslint/no-await-in-loop */
