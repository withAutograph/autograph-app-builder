import { execFileSync } from "node:child_process";
import type { ExecFileSyncOptions } from "node:child_process";
import {
  closeSync,
  createReadStream,
  mkdtempSync,
  openSync,
  readFileSync,
  readSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createHash } from "node:crypto";

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
  const directory = mkdtempSync(nodePath.join(tmpdir(), "app-builder-command-digest-"));
  const outputPath = nodePath.join(directory, "stdout");
  const outputFd = openSync(outputPath, "w");
  try {
    const execOptions: ExecFileSyncOptions = {
      stdio: ["ignore", outputFd, "inherit"],
    };
    if (options.cwd !== undefined) {
      execOptions.cwd = options.cwd;
    }
    if (options.env !== undefined) {
      execOptions.env = options.env;
    }
    execFileSync(command, [...args], execOptions);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(outputPath)) {
      if (!(chunk instanceof Uint8Array)) {
        throw new Error("Command output stream returned non-byte content.");
      }
      hash.update(chunk);
    }
    return hash.digest("hex");
  } finally {
    closeSync(outputFd);
    rmSync(directory, { force: true, recursive: true });
  }
};
/* eslint-enable eslint/no-await-in-loop */
