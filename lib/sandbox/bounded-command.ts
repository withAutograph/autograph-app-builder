import { setTimeout as delay } from "node:timers/promises";

import type { SandboxCommandResult, SandboxRunOptions, SandboxSession } from "eve/sandbox";

import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export class SandboxCommandLimitError extends Error {
  readonly code: "timeout" | "no-output-timeout" | "output-limit";

  constructor(code: "timeout" | "no-output-timeout" | "output-limit") {
    super("The sandbox command exceeded its execution envelope.");
    this.code = code;
    this.name = "SandboxCommandLimitError";
  }
}

type OutputReader = ReadableStreamDefaultReader<Uint8Array>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function collectBounded(
  reader: OutputReader,
  state: { bytes: number; readonly maximumBytes: number },
  observed: () => void,
): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  for (;;) {
    // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
    const next = await reader.read();
    if (next.done) {break;}
    state.bytes += next.value.byteLength;
    observed();
    if (state.bytes > state.maximumBytes) {
      throw new SandboxCommandLimitError("output-limit");
    }
    chunks.push(next.value);
  }
  return chunks;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function decodeChunks(chunks: readonly Uint8Array[]) {
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function timeoutRejection(error: Error, timeoutMs: number) {
  const controller = new AbortController();
  const promise = (async () => {
    await delay(timeoutMs, undefined, { ref: false, signal: controller.signal });
    throw error;
  })();
  return { clear: () => controller.abort(), promise };
}

// Keep timeout rejection construction private to command execution.
// oxlint-disable-next-line eslint/func-style, unicorn/consistent-function-scoping -- Preserve function declaration hoisting and initialization timing.
function resettableTimeoutRejection(error: Error, timeoutMs: number) {
  let cleared = false;
  let controller = new AbortController();
  const waitForTimeout = async (): Promise<never> => {
    const currentController = controller;
    try {
      await delay(timeoutMs, undefined, { ref: false, signal: currentController.signal });
    } catch {
      if (cleared) {throw currentController.signal.reason;}
      if (currentController !== controller) {return waitForTimeout();}
      throw error;
    }
    if (currentController === controller) {throw error;}
    return waitForTimeout();
  };
  const promise = waitForTimeout();
  const clear = () => {
    cleared = true;
    controller.abort();
  };
  const reset = () => {
    controller.abort();
    controller = new AbortController();
  };
  return { clear, promise, reset };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function settleWithin(operation: Promise<unknown>, timeoutMs: number) {
  const bounded = timeoutRejection(new Error("cleanup timed out"), timeoutMs);
  try {
    await Promise.race([operation.catch(() => null), bounded.promise]);
  } catch {
    // Cleanup evidence is the bounded return itself. The original command
    // error remains authoritative and is never replaced by cleanup failure.
  } finally {
    bounded.clear();
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
    limits?.noOutputTimeoutMs ?? SANDBOX_EXECUTION_POLICY.command.maximumNoOutputTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumNoOutputTimeMs,
  );
  const killCleanupTimeoutMs = Math.min(
    limits?.killCleanupTimeoutMs ?? SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
  );
  const controller = new AbortController();
  const wallTimeout = timeoutRejection(new SandboxCommandLimitError("timeout"), timeoutMs);
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
        abortSignal: signal,
        command: options.command,
      }),
    );
    process = await Promise.race([spawnPromise, wallTimeout.promise]);
    // The losing promise is observed to prevent an unhandled rejection.
    // oxlint-disable-next-line promise/prefer-await-to-then
    spawnPromise.catch(() => null);
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
    const completion = Promise.all([stdoutPromise, stderrPromise, Promise.resolve(process.wait())]);
    // The losing promise is observed to prevent an unhandled rejection.
    // oxlint-disable-next-line promise/prefer-await-to-then
    completion.catch(() => null);
    const abortRejection = Promise.withResolvers<never>();
    const rejectOnAbort = () => abortRejection.reject(signal.reason);
    if (signal.aborted) {rejectOnAbort();}
    else {signal.addEventListener("abort", rejectOnAbort, { once: true });}
    const [stdout, stderr, result] = await Promise.race([
      completion,
      wallTimeout.promise,
      noOutputTimeout.promise,
      abortRejection.promise,
    ]);
    return {
      exitCode: result.exitCode,
      stderr: decodeChunks(stderr),
      stdout: decodeChunks(stdout),
    };
  } catch (error) {
    controller.abort(error);
    const cleanup = [
      ...readers.map((reader) => Promise.resolve(reader.cancel(error))),
      ...(process === undefined ? [] : [Promise.resolve(process.kill())]),
    ];
    await settleWithin(Promise.allSettled(cleanup), killCleanupTimeoutMs);
    if (error instanceof SandboxCommandLimitError) {throw error;}
    if (controller.signal.reason instanceof SandboxCommandLimitError)
      {throw controller.signal.reason;}
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
