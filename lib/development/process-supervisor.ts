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
  // The wrapper can exit before Eve's local server finishes its shutdown
  // handshake. Still signal this task-owned process group on restart; Eve's
  // separately detached server receives its shutdown request from the CLI.
  if (childExited && !options.processGroup) return;
  const gracefulTimeoutMs =
    options.gracefulTimeoutMs ?? (options.processGroup ? 1_100 : 5_000);
  const exited = developmentChildExit(child);
  const signalProcessGroup = (value: NodeJS.Signals) => {
    if (child.pid === undefined || process.platform === "win32") {
      child.kill(value);
      return;
    }
    try {
      process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
    }
  };
  if (
    options.processGroup &&
    child.pid !== undefined &&
    process.platform !== "win32"
  ) {
    // Signal the wrapper only while it is alive. It forwards this signal once
    // to Eve. Signalling the whole group here would also hit Eve directly,
    // making the wrapper's forward a second signal that bypasses Eve's orderly
    // shutdown and can orphan its separately detached local server.
    if (childExited) signalProcessGroup("SIGTERM");
    else child.kill("SIGTERM");
    // `eve dev` uses a separately detached local-server child. Its CLI sends
    // that child an IPC shutdown request and has a 900ms shutdown backstop.
    // Do not cut that handshake short: a premature group kill leaves the
    // detached listener on port 2000 even after the wrapper is gone. The group
    // still belongs solely to this development cycle, so force it only after
    // a window longer than Eve's own backstop.
    await new Promise((resolveWait) =>
      setTimeout(resolveWait, gracefulTimeoutMs),
    );
    signalProcessGroup("SIGKILL");
    if (!childExited) await exited;
    return;
  }
  child.kill("SIGTERM");
  if (childExited) return;
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) =>
      setTimeout(() => resolveWait(false), gracefulTimeoutMs),
    ),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
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
