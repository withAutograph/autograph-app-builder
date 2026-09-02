import type { ChildProcess } from "node:child_process";
import { createConnection } from "node:net";

type DevelopmentSignal = "SIGINT" | "SIGTERM";

type SignalTarget = Readonly<{
  once(signal: DevelopmentSignal, listener: () => void): unknown;
  off(signal: DevelopmentSignal, listener: () => void): unknown;
}>;

export function createDevelopmentShutdown(
  target: SignalTarget = process,
): Readonly<{
  signal: AbortSignal;
  exitCode: () => number;
  dispose: () => void;
}> {
  const controller = new AbortController();
  let exitCode = 0;
  const interrupt = () => {
    exitCode = 130;
    controller.abort();
  };
  const terminate = () => {
    exitCode = 143;
    controller.abort();
  };
  target.once("SIGINT", interrupt);
  target.once("SIGTERM", terminate);
  return {
    signal: controller.signal,
    exitCode: () => exitCode,
    dispose: () => {
      target.off("SIGINT", interrupt);
      target.off("SIGTERM", terminate);
    },
  };
}

export function waitForDevelopmentShutdown(
  signal: AbortSignal,
  exitCode: () => number,
) {
  if (signal.aborted)
    return Promise.resolve({ kind: "stop" as const, code: exitCode() });
  return new Promise<{ kind: "stop"; code: number }>((resolveStop) => {
    signal.addEventListener(
      "abort",
      () => resolveStop({ kind: "stop", code: exitCode() }),
      { once: true },
    );
  });
}

export function developmentChildExit(child: ChildProcess) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  if (child.signalCode !== null) return Promise.resolve(1);
  return new Promise<number>((resolveExit, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => resolveExit(code ?? (signal ? 1 : 0)));
  });
}

export async function stopDevelopmentChild(
  child: ChildProcess,
  options: Readonly<{
    processGroup?: boolean;
    gracefulTimeoutMs?: number;
  }> = {},
) {
  const childExited = child.exitCode !== null || child.signalCode !== null;
  // The wrapper can exit before an Eve descendant does (for example when the
  // wrapper observes a launch error).  Still signal its task-owned process
  // group so a listener inherited by that group cannot survive a restart.
  if (childExited && !options.processGroup) return;
  const gracefulTimeoutMs = options.gracefulTimeoutMs ?? 5_000;
  const exited = developmentChildExit(child);
  const signal = (value: NodeJS.Signals) => {
    if (
      options.processGroup &&
      child.pid !== undefined &&
      process.platform !== "win32"
    ) {
      try {
        process.kill(-child.pid, value);
        return;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
        throw error;
      }
    }
    child.kill(value);
  };
  signal("SIGTERM");
  if (
    options.processGroup &&
    child.pid !== undefined &&
    process.platform !== "win32"
  ) {
    // Eve may allow its wrapper to exit while its local listener finishes (or
    // ignores) shutdown. The child PID is also the task-owned detached process
    // group ID, so wait for the *whole* cycle rather than treating wrapper exit
    // as evidence that port 2000 is available for the next cycle.
    // Process-group liveness probing is not portable (macOS can return EPERM
    // after the wrapper is reaped even though a descendant remains). Give the
    // task-owned group a short grace window, then ensure it cannot retain the
    // loopback listener into the next development cycle.
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, options.gracefulTimeoutMs ?? 250),
    );
    signal("SIGKILL");
    if (!childExited) await exited;
    return;
  }
  if (childExited) return;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) =>
      setTimeout(() => resolveWait(false), gracefulTimeoutMs),
    ),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    signal("SIGKILL");
    await exited;
  }
}

export async function waitForDevelopmentPortRelease(
  port: number,
  options: Readonly<{ timeoutMs?: number; pollMs?: number }> = {},
) {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const pollMs = options.pollMs ?? 50;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const occupied = await new Promise<boolean>((resolveOccupied) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      const finish = (value: boolean) => {
        socket.destroy();
        resolveOccupied(value);
      };
      socket.once("connect", () => finish(true));
      socket.once("error", () => finish(false));
    });
    if (!occupied) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, pollMs));
  }
  throw new Error(
    `Development Eve port ${port} was not released after shutdown.`,
  );
}
