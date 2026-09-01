import type {
  SandboxCommandResult,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";

import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export class SandboxCommandLimitError extends Error {
  constructor(
    readonly code: "timeout" | "no-output-timeout" | "output-limit",
  ) {
    super("The sandbox command exceeded its execution envelope.");
    this.name = "SandboxCommandLimitError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function boundedSandboxCommand(command: string): string {
  const script = `
set -euo pipefail
setsid bash -lc ${shellQuote(command)} &
child=$!
cleanup() {
  kill -TERM -- -"$child" 2>/dev/null || true
}
trap cleanup EXIT INT TERM
set +e
wait "$child"
child_status=$?
set -e
trap - EXIT INT TERM
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
        command: boundedSandboxCommand(options.command),
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
