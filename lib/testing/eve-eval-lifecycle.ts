/* oxlint-disable eslint/no-await-in-loop -- lock ownership checks and quarantine mutations must remain sequential. */
import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";

type EvalSignal = "SIGINT" | "SIGTERM";

type SignalTarget = Readonly<{
  on: (signal: EvalSignal, listener: () => void) => unknown;
  off: (signal: EvalSignal, listener: () => void) => unknown;
}>;

export type EveEvalPrewarmLockReceipt = Readonly<{
  lock: string;
  pid?: number;
  status: "active" | "preserved" | "removed";
  reason?: string;
}>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function isErrno(error: unknown, code: string) {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function ownerBound(info: Awaited<ReturnType<typeof lstat>>) {
  return (
    typeof info.uid === "number" &&
    typeof info.mode === "number" &&
    info.uid === process.getuid?.() &&
    !info.isSymbolicLink() &&
    // oxlint-disable-next-line eslint/no-bitwise -- File permission mask check.
    (info.mode & 0o022) === 0
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function sameFile(
  first: Awaited<ReturnType<typeof lstat>>,
  second: Awaited<ReturnType<typeof lstat>>,
) {
  return (
    first.dev === second.dev &&
    first.ino === second.ino &&
    first.size === second.size &&
    first.mtimeMs === second.mtimeMs
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (isErrno(error, "ESRCH")) return false;
    if (isErrno(error, "EPERM")) return true;
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function contained(root: string, path: string) {
  const candidate = relative(root, path);
  return (
    candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..${sep}`) &&
    !isAbsolute(candidate)
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readLockOwner(lock: string) {
  const ownerPath = join(lock, "owner.json");
  const info = await lstat(ownerPath);
  if (!info.isFile() || !ownerBound(info))
    throw new Error("owner.json was not an owner-bound regular file");
  const source = await readFile(ownerPath, "utf-8");
  const value = JSON.parse(source) as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Object.keys(value).toSorted().join(",") !== "createdAt,pid"
  )
    throw new Error("owner.json did not match Eve's lock schema");
  const owner = value as { createdAt?: unknown; pid?: unknown };
  if (
    typeof owner.createdAt !== "string" ||
    !Number.isFinite(Date.parse(owner.createdAt)) ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 0
  )
    throw new Error("owner.json contained an invalid owner");
  return { info, pid: Number(owner.pid), source };
}

/**
 * Eve 0.44.x retains template prewarm locks for up to thirty minutes without
 * consulting the recorded owner PID. A benchmark restart may remove only a
 * lock whose exact owner file is trustworthy, unchanged, and demonstrably
 * dead. Active and malformed locks remain visible instead of being hidden.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function reconcileDeadEveEvalPrewarmLocks(
  appRoot: string,
  options: Readonly<{ processAlive?: (pid: number) => boolean }> = {},
): Promise<readonly EveEvalPrewarmLockReceipt[]> {
  const canonicalRoot = await realpath(appRoot);
  const rootInfo = await lstat(canonicalRoot);
  if (resolve(appRoot) !== canonicalRoot || !rootInfo.isDirectory() || !ownerBound(rootInfo))
    throw new Error("The Eve eval application root was not owner-bound.");
  const locksRoot = join(canonicalRoot, ".eve", "sandbox-cache", "template-locks");
  let backends;
  try {
    backends = await readdir(locksRoot, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }
  const receipts: EveEvalPrewarmLockReceipt[] = [];
  for (const backend of backends.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const backendPath = join(locksRoot, backend.name);
    if (!backend.isDirectory() || backend.isSymbolicLink()) continue;
    const entries = await readdir(backendPath, { withFileTypes: true });
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.name.endsWith(".lock")) continue;
      const lock = join(backendPath, entry.name);
      const display = relative(canonicalRoot, lock);
      if (!entry.isDirectory() || entry.isSymbolicLink() || !contained(locksRoot, lock)) {
        receipts.push({
          lock: display,
          status: "preserved",
          reason: "lock path was not a contained regular directory",
        });
        continue;
      }
      let owner;
      try {
        const lockInfo = await lstat(lock);
        if (!ownerBound(lockInfo)) throw new Error("lock directory was not owner-bound");
        owner = await readLockOwner(lock);
      } catch (error) {
        receipts.push({
          lock: display,
          status: "preserved",
          reason: error instanceof Error ? error.message : "owner read failed",
        });
        continue;
      }
      const processAlive = options.processAlive ?? defaultProcessAlive;
      if (processAlive(owner.pid)) {
        receipts.push({ lock: display, pid: owner.pid, status: "active" });
        continue;
      }
      try {
        const currentOwner = await readLockOwner(lock);
        if (
          currentOwner.pid !== owner.pid ||
          currentOwner.source !== owner.source ||
          !sameFile(currentOwner.info, owner.info)
        ) {
          receipts.push({
            lock: display,
            pid: owner.pid,
            status: "preserved",
            reason: "lock owner changed during reconciliation",
          });
          continue;
        }
        const quarantine = `${lock}.dead-${owner.pid}-${randomUUID()}`;
        await rename(lock, quarantine);
        const movedOwner = await readLockOwner(quarantine);
        if (
          movedOwner.pid !== owner.pid ||
          movedOwner.source !== owner.source ||
          !sameFile(movedOwner.info, owner.info)
        ) {
          await rename(quarantine, lock).catch(() => undefined);
          throw new Error("lock owner changed while it was quarantined");
        }
        await rm(quarantine, { recursive: true });
        receipts.push({ lock: display, pid: owner.pid, status: "removed" });
      } catch (error) {
        if (isErrno(error, "ENOENT")) continue;
        receipts.push({
          lock: display,
          pid: owner.pid,
          status: "preserved",
          reason: error instanceof Error ? error.message : "lock removal failed",
        });
      }
    }
  }
  return receipts;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createEveEvalRuntimeDirectories(
  parent: string = tmpdir(),
): Readonly<{ home: string; root: string; workflowData: string }> {
  const root = realpathSync(mkdtempSync(join(parent, "app-builder-eval-")));
  chmodSync(root, 0o700);
  const home = join(root, "home");
  const workflowData = join(root, "workflow-data");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workflowData, { mode: 0o700 });
  for (const path of [root, home, workflowData]) {
    const info = lstatSync(path);
    if (
      realpathSync(path) !== path ||
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      info.uid !== process.getuid?.() ||
      // oxlint-disable-next-line eslint/no-bitwise -- File permission mask check.
      (info.mode & 0o077) !== 0
    )
      throw new Error("The Eve eval runtime directory was not owner-only.");
  }
  return { home, root, workflowData };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function signalExitCode(signal: NodeJS.Signals | null) {
  return signal === "SIGINT" ? 130 : signal === "SIGTERM" ? 143 : 128;
}

/**
 * Keeps the structural capability wrapper alive while Eve runs its own
 * shutdown hooks. The detached process group is task-owned and provides a
 * bounded final backstop for listeners or descendants left by an interruption.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function waitForEveEvalChild(
  input: Readonly<{
    authorization: Duplex;
    child: ChildProcess;
    gracefulTimeoutMs?: number;
    signalTarget?: SignalTarget;
  }>,
): Promise<number> {
  const signalTarget = input.signalTarget ?? process;
  const gracefulTimeoutMs = input.gracefulTimeoutMs ?? 16_000;
  return new Promise<number>((resolve, reject) => {
    let requestedSignal: EvalSignal | undefined;
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const forceGroup = () => {
      if (input.child.pid === undefined || process.platform === "win32") {
        input.child.kill("SIGKILL");
        return;
      }
      try {
        process.kill(-input.child.pid, "SIGKILL");
      } catch (error) {
        if (!isErrno(error, "ESRCH")) throw error;
      }
    };
    const handlers = {} as {
      interrupt: () => void;
      terminate: () => void;
      failed: (error: Error) => void;
      exited: (code: number | null, signal: NodeJS.Signals | null) => void;
    };
    const cleanup = () => {
      if (forceTimer !== undefined) clearTimeout(forceTimer);
      signalTarget.off("SIGINT", handlers.interrupt);
      signalTarget.off("SIGTERM", handlers.terminate);
      input.child.off("error", handlers.failed);
      input.child.off("exit", handlers.exited);
      input.authorization.destroy();
    };
    const requestStop = (signal: EvalSignal) => {
      if (requestedSignal !== undefined) {
        forceGroup();
        return;
      }
      requestedSignal = signal;
      input.child.kill(signal);
      forceTimer = setTimeout(forceGroup, gracefulTimeoutMs);
      forceTimer.unref?.();
    };
    const interrupt = () => requestStop("SIGINT");
    const terminate = () => requestStop("SIGTERM");
    const failed = (error: Error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      // A successful Eve CLI exit can still outpace a forked local host. The
      // detached group is scoped to this one eval, so completion and failure
      // share the same descendant cleanup boundary.
      forceGroup();
      cleanup();
      resolve(code ?? signalExitCode(requestedSignal ?? signal));
    };
    Object.assign(handlers, { interrupt, terminate, failed, exited });
    signalTarget.on("SIGINT", handlers.interrupt);
    signalTarget.on("SIGTERM", handlers.terminate);
    input.child.once("error", handlers.failed);
    input.child.once("exit", handlers.exited);
  });
}
