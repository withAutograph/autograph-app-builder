import type {
  SandboxCommandResult,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";

import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export class SandboxCommandLimitError extends Error {
  constructor(
    readonly code:
      "timeout" | "no-output-timeout" | "output-limit" | "process-limit",
  ) {
    super("The sandbox command exceeded its execution envelope.");
    this.name = "SandboxCommandLimitError";
  }
}

// Bash defines the `ulimit -f` block size as 1024 bytes.
const BASH_ULIMIT_FILE_BLOCK_BYTES = 1_024;

export const WORKSPACE_QUOTA_MONITOR_SCRIPT = String.raw`
const {
  lstatSync,
  readdirSync,
} = require("node:fs");

const [childValue, bytesValue, filesValue, intervalValue, workspaceRoot] =
  process.argv.slice(-5);
const child = Number(childValue);
const maximumBytes = Number(bytesValue);
const maximumFiles = Number(filesValue);
const intervalMs = Number(intervalValue);

if (
  !Number.isSafeInteger(child) ||
  child <= 0 ||
  !Number.isSafeInteger(maximumBytes) ||
  maximumBytes < 0 ||
  !Number.isSafeInteger(maximumFiles) ||
  maximumFiles < 0 ||
  !Number.isSafeInteger(intervalMs) ||
  intervalMs <= 0 ||
  typeof workspaceRoot !== "string" ||
  workspaceRoot.length === 0
) {
  process.exit(2);
}

let cancelled = false;
let cancellation;

const childIsAlive = () => {
  try {
    process.kill(child, 0);
    return true;
  } catch (error) {
    if (error && error.code === "ESRCH") return false;
    throw error;
  }
};

const workspaceUsage = () => {
  const workspaceRootBytes = Buffer.from(workspaceRoot);
  const root = lstatSync(workspaceRootBytes);
  const device = root.dev;
  const pending = [workspaceRootBytes];
  const allocatedInodes = new Set();
  let allocatedBytes = 0;
  let files = 0;

  while (pending.length > 0) {
    const path = pending.pop();
    let stat;
    try {
      stat = lstatSync(path);
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    if (stat.dev !== device) continue;
    const inode = stat.dev + ":" + stat.ino;
    if (!allocatedInodes.has(inode)) {
      allocatedInodes.add(inode);
      allocatedBytes += stat.blocks * 512;
    }
    if (stat.isFile()) files += 1;
    if (!stat.isDirectory()) continue;

    let entries;
    try {
      entries = readdirSync(path, { encoding: "buffer" });
    } catch (error) {
      if (error && error.code === "ENOENT") continue;
      throw error;
    }
    for (const entry of entries)
      pending.push(Buffer.concat([path, Buffer.from("/"), entry]));
  }

  return { allocatedBytes, files };
};

const delay = (durationMs) =>
  new Promise((resolve) => setTimeout(resolve, durationMs));

const terminateChild = async () => {
  try {
    process.kill(-child, "SIGTERM");
  } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
  await delay(1_000);
  try {
    process.kill(-child, "SIGKILL");
  } catch (error) {
    if (!error || error.code !== "ESRCH") throw error;
  }
};

const cancel = () => {
  cancelled = true;
  cancellation ??= terminateChild();
  cancellation.catch(() => undefined);
};
process.once("SIGINT", cancel);
process.once("SIGTERM", cancel);

const monitor = async () => {
  while (!cancelled && childIsAlive()) {
    const usage = workspaceUsage();
    if (
      usage.allocatedBytes > maximumBytes ||
      usage.files > maximumFiles
    ) {
      await terminateChild();
      process.stderr.write("sandbox_workspace_quota_exceeded\n");
      process.exitCode = 125;
      return;
    }
    await delay(intervalMs);
  }
  if (cancellation) await cancellation;
};

monitor().catch(async (error) => {
  try {
    await terminateChild();
  } catch (terminationError) {
    process.stderr.write(
      "sandbox_workspace_quota_termination_failed:" +
        (terminationError instanceof Error
          ? terminationError.message
          : String(terminationError)) +
        "\n",
    );
  }
  process.stderr.write(
    "sandbox_workspace_quota_monitor_failed:" +
      (error instanceof Error ? error.message : String(error)) +
      "\n",
  );
  process.exitCode = 2;
});
`;

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function quotaWrappedSandboxCommand(command: string): string {
  const quota = SANDBOX_EXECUTION_POLICY.command;
  const maximumFileBlocks = Math.floor(
    quota.maximumFileBytes / BASH_ULIMIT_FILE_BLOCK_BYTES,
  );
  const script = `
set -euo pipefail
ulimit -t ${Math.ceil(quota.maximumWallTimeMs / 1_000)}
ulimit -f ${maximumFileBlocks}
ulimit -n ${quota.maximumOpenFiles}
ulimit -u ${quota.maximumProcesses}
setsid bash -lc ${shellQuote(command)} &
child=$!
monitor=
cleanup() {
  kill -TERM -- -"$child" 2>/dev/null || true
  if [ -n "$monitor" ]; then kill -TERM "$monitor" 2>/dev/null || true; fi
}
trap cleanup EXIT INT TERM
bun -e ${shellQuote(WORKSPACE_QUOTA_MONITOR_SCRIPT)} -- "$child" ${quota.maximumWorkspaceBytes} ${quota.maximumWorkspaceFiles} 1000 /workspace &
monitor=$!
set +e
wait "$child"
child_status=$?
wait "$monitor"
monitor_status=$?
set -e
trap - EXIT INT TERM
if [ "$monitor_status" -ne 0 ]; then exit "$monitor_status"; fi
exit "$child_status"
`;
  return `bash -lc ${shellQuote(script)}`;
}

type OutputReader = ReadableStreamDefaultReader<Uint8Array>;

async function collectBounded(
  reader: OutputReader,
  state: { bytes: number; readonly maximumBytes: number },
  observed: () => void,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    const next = await reader.read();
    if (next.done) break;
    state.bytes += next.value.byteLength;
    observed();
    if (state.bytes > state.maximumBytes) {
      throw new SandboxCommandLimitError("output-limit");
    }
    chunks.push(next.value);
  }
  return chunks;
}

function decodeChunks(chunks: readonly Uint8Array[]) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
}

function timeoutRejection(error: Error, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => reject(error), timeoutMs);
    timeout.unref?.();
  });
  return { promise, clear: () => clearTimeout(timeout) };
}

function resettableTimeoutRejection(error: Error, timeoutMs: number) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let rejectPromise: (error: Error) => void = () => undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectPromise = reject;
  });
  const clear = () => clearTimeout(timeout);
  const reset = () => {
    clear();
    timeout = setTimeout(() => rejectPromise(error), timeoutMs);
    timeout.unref?.();
  };
  return { promise, clear, reset };
}

async function settleWithin(operation: Promise<unknown>, timeoutMs: number) {
  const bounded = timeoutRejection(new Error("cleanup timed out"), timeoutMs);
  try {
    await Promise.race([operation.catch(() => undefined), bounded.promise]);
  } catch {
    // Cleanup evidence is the bounded return itself. The original command
    // error remains authoritative and is never replaced by cleanup failure.
  } finally {
    bounded.clear();
  }
}

export async function runBoundedSandboxCommand(
  sandbox: Pick<SandboxSession, "spawn">,
  options: Omit<SandboxRunOptions, "abortSignal"> & {
    abortSignal?: AbortSignal;
  },
  limits?: {
    timeoutMs?: number;
    noOutputTimeoutMs?: number;
    outputBytes?: number;
    killCleanupTimeoutMs?: number;
  },
): Promise<SandboxCommandResult> {
  const timeoutMs = Math.min(
    limits?.timeoutMs ?? SANDBOX_EXECUTION_POLICY.command.maximumWallTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumWallTimeMs,
  );
  const outputBytes = Math.min(
    limits?.outputBytes ?? SANDBOX_EXECUTION_POLICY.command.maximumOutputBytes,
    SANDBOX_EXECUTION_POLICY.command.maximumOutputBytes,
  );
  const noOutputTimeoutMs = Math.min(
    limits?.noOutputTimeoutMs ??
      SANDBOX_EXECUTION_POLICY.command.maximumNoOutputTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumNoOutputTimeMs,
  );
  const killCleanupTimeoutMs = Math.min(
    limits?.killCleanupTimeoutMs ??
      SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
  );
  const controller = new AbortController();
  const wallTimeout = timeoutRejection(
    new SandboxCommandLimitError("timeout"),
    timeoutMs,
  );
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal;
  let process: Awaited<ReturnType<SandboxSession["spawn"]>> | undefined;
  let readers: readonly OutputReader[] = [];
  const noOutputTimeout = resettableTimeoutRejection(
    new SandboxCommandLimitError("no-output-timeout"),
    noOutputTimeoutMs,
  );
  try {
    const spawnPromise = Promise.resolve(
      sandbox.spawn({
        ...options,
        command: quotaWrappedSandboxCommand(options.command),
        abortSignal: signal,
      }),
    );
    process = await Promise.race([spawnPromise, wallTimeout.promise]);
    spawnPromise.catch(() => undefined);
    const stdoutReader = process.stdout.getReader();
    const stderrReader = process.stderr.getReader();
    readers = [stdoutReader, stderrReader];
    const outputState = { bytes: 0, maximumBytes: outputBytes };
    const observed = () => {
      noOutputTimeout.reset();
    };
    observed();
    const stdoutPromise = collectBounded(stdoutReader, outputState, observed);
    const stderrPromise = collectBounded(stderrReader, outputState, observed);
    const completion = Promise.all([
      stdoutPromise,
      stderrPromise,
      Promise.resolve(process.wait()),
    ]);
    completion.catch(() => undefined);
    const [stdout, stderr, result] = await Promise.race([
      completion,
      wallTimeout.promise,
      noOutputTimeout.promise,
      new Promise<never>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else
          signal.addEventListener("abort", () => reject(signal.reason), {
            once: true,
          });
      }),
    ]);
    return {
      exitCode: result.exitCode,
      stdout: decodeChunks(stdout),
      stderr: decodeChunks(stderr),
    };
  } catch (error) {
    controller.abort(error);
    const cleanup = [
      ...readers.map((reader) => Promise.resolve(reader.cancel(error))),
      ...(process === undefined ? [] : [Promise.resolve(process.kill())]),
    ];
    await settleWithin(Promise.allSettled(cleanup), killCleanupTimeoutMs);
    if (error instanceof SandboxCommandLimitError) throw error;
    if (controller.signal.reason instanceof SandboxCommandLimitError)
      throw controller.signal.reason;
    throw error;
  } finally {
    wallTimeout.clear();
    noOutputTimeout.clear();
    for (const reader of readers) {
      try {
        reader.releaseLock();
      } catch {
        // A cancelled reader may already have released its lock.
      }
    }
  }
}
