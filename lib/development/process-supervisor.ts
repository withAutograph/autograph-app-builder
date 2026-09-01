import type { ChildProcess } from "node:child_process";

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

export async function stopDevelopmentChild(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = developmentChildExit(child);
  child.kill("SIGTERM");
  const graceful = await Promise.race([
    exited.then(() => true),
    new Promise<false>((resolveWait) =>
      setTimeout(() => resolveWait(false), 5_000),
    ),
  ]);
  if (!graceful && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await exited;
  }
}
