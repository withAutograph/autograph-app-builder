import type {
  SandboxCommandResult,
  SandboxRunOptions,
  SandboxSession,
} from "eve/sandbox";

import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";

export class SandboxCommandLimitError extends Error {
  constructor(readonly code: "timeout" | "output-limit" | "process-limit") {
    super("The sandbox command exceeded its execution envelope.");
    this.name = "SandboxCommandLimitError";
  }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\"'\"'`)}'`;
}

export function quotaWrappedSandboxCommand(command: string): string {
  const quota = SANDBOX_EXECUTION_POLICY.command;
  const maximumFileBlocks = Math.floor(quota.maximumFileBytes / 512);
  const script = `
set -euo pipefail
ulimit -t ${Math.ceil(quota.maximumWallTimeMs / 1_000)}
ulimit -f ${maximumFileBlocks}
ulimit -n ${quota.maximumOpenFiles}
ulimit -u ${quota.maximumProcesses}
setsid bash -lc ${shellQuote(command)} &
child=$!
cleanup() { kill -TERM -- -"$child" 2>/dev/null || true; }
trap cleanup EXIT INT TERM
while kill -0 "$child" 2>/dev/null; do
  workspace_bytes=$(du -sx --block-size=1 /workspace 2>/dev/null | awk '{print $1}')
  workspace_files=$(find /workspace -xdev -type f -printf '.' 2>/dev/null | wc -c)
  if [ "\${workspace_bytes:-0}" -gt ${quota.maximumWorkspaceBytes} ] || [ "\${workspace_files:-0}" -gt ${quota.maximumWorkspaceFiles} ]; then
    kill -TERM -- -"$child" 2>/dev/null || true
    sleep 1
    kill -KILL -- -"$child" 2>/dev/null || true
    wait "$child" 2>/dev/null || true
    printf '%s\\n' sandbox_workspace_quota_exceeded >&2
    exit 125
  fi
  sleep 1
done
trap - EXIT INT TERM
wait "$child"
`;
  return `bash -lc ${shellQuote(script)}`;
}

async function collectBounded(
  stream: ReadableStream<Uint8Array>,
  maximumBytes: number,
  abort: () => void,
): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > maximumBytes) {
        abort();
        throw new SandboxCommandLimitError("output-limit");
      }
      chunks.push(next.value);
    }
  } finally {
    reader.releaseLock();
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))),
  );
}

export async function runBoundedSandboxCommand(
  sandbox: Pick<SandboxSession, "spawn">,
  options: Omit<SandboxRunOptions, "abortSignal"> & {
    abortSignal?: AbortSignal;
  },
  limits?: { timeoutMs?: number; outputBytes?: number },
): Promise<SandboxCommandResult> {
  const timeoutMs = Math.min(
    limits?.timeoutMs ?? SANDBOX_EXECUTION_POLICY.command.maximumWallTimeMs,
    SANDBOX_EXECUTION_POLICY.command.maximumWallTimeMs,
  );
  const outputBytes = Math.min(
    limits?.outputBytes ?? SANDBOX_EXECUTION_POLICY.command.maximumOutputBytes,
    SANDBOX_EXECUTION_POLICY.command.maximumOutputBytes,
  );
  const controller = new AbortController();
  const timeout = setTimeout(
    () => controller.abort(new SandboxCommandLimitError("timeout")),
    timeoutMs,
  );
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, controller.signal])
    : controller.signal;
  let process: Awaited<ReturnType<SandboxSession["spawn"]>> | undefined;
  try {
    process = await sandbox.spawn({
      ...options,
      command: quotaWrappedSandboxCommand(options.command),
      abortSignal: signal,
    });
    const abort = () =>
      controller.abort(new SandboxCommandLimitError("output-limit"));
    const [stdout, stderr, result] = await Promise.all([
      collectBounded(process.stdout, outputBytes, abort),
      collectBounded(process.stderr, outputBytes, abort),
      Promise.resolve(process.wait()),
    ]);
    return { exitCode: result.exitCode, stdout, stderr };
  } catch (error) {
    if (process !== undefined)
      await Promise.resolve(process.kill()).catch(() => undefined);
    if (controller.signal.reason instanceof SandboxCommandLimitError)
      throw controller.signal.reason;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
