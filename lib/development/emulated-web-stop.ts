import type { ChildProcess } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { developmentChildExit } from "./process-supervisor";

/** Give the owned shell time to finish Docker's bounded stop before group cleanup. */
export const stopEmulatedWebServices = async (child: ChildProcess, timeoutMs = 15_000) => {
  if (child.pid === undefined) {
    return;
  }
  const exited = developmentChildExit(child);
  const timer = new AbortController();
  try {
    if (child.exitCode === null && child.signalCode === null) {
      child.kill("SIGTERM");
      await Promise.race([exited, delay(timeoutMs, undefined, { signal: timer.signal })]);
    }
    try {
      process.kill(-child.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) {
        throw error;
      }
    }
    await exited;
  } finally {
    timer.abort();
  }
};
