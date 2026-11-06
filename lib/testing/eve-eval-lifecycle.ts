import { randomUUID } from "node:crypto";
import type { ChildProcess } from "node:child_process";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { lstat, readFile, readdir, realpath, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import type { Duplex } from "node:stream";
import { z } from "zod";

type EvalSignal = "SIGINT" | "SIGTERM";
type SignalListener = () => void;
type ErrnoCode = "ENOENT" | "EPERM" | "ESRCH";
type ProcessFailure = Readonly<{ message: string; code?: ErrnoCode }>;
type SignalRegistration = (signal: EvalSignal, listener: SignalListener) => void;

type SignalTarget = Readonly<{
  on: SignalRegistration;
  off: SignalRegistration;
}>;

type EveEvalRuntimeDirectories = Readonly<{ home: string; root: string; workflowData: string }>;

interface ChildHandlers {
  interrupt?: () => void;
  terminate?: () => void;
  failed?: (error: Error) => void;
  exited?: (code: number | null, signal: NodeJS.Signals | null) => void;
}

export type EveEvalPrewarmLockReceipt = Readonly<{
  lock: string;
  pid?: number;
  status: "active" | "preserved" | "removed";
  reason?: string;
}>;

function parseProcessFailure(value: Error): ProcessFailure {
  if (!("code" in value)) {
    return { message: value.message };
  }
  const { code } = value;
  const parsedCode = code === "ENOENT" || code === "EPERM" || code === "ESRCH" ? code : undefined;
  return parsedCode === undefined
    ? { message: value.message }
    : { code: parsedCode, message: value.message };
}

function ownerBound(info: Awaited<ReturnType<typeof lstat>>) {
  return (
    info.uid === process.getuid?.() &&
    !info.isSymbolicLink() &&
    (info.mode & 0o022) === 0
  );
}

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

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const failure = error instanceof Error ? parseProcessFailure(error) : undefined;
    if (failure?.code === "ESRCH") {
      return false;
    }
    if (failure?.code === "EPERM") {
      return true;
    }
    throw error;
  }
}

function contained(root: string, path: string) {
  const candidate = nodePath.relative(root, path);
  return (
    candidate !== "" &&
    candidate !== ".." &&
    !candidate.startsWith(`..${nodePath.sep}`) &&
    !nodePath.isAbsolute(candidate)
  );
}

const ownerDocumentSchema = z.strictObject({
  createdAt: z.string().refine((value) => Number.isFinite(Date.parse(value))),
  pid: z.number().int().positive(),
});

async function readLockOwner(lock: string) {
  const ownerPath = nodePath.join(lock, "owner.json");
  const info = await lstat(ownerPath);
  if (!info.isFile() || !ownerBound(info)) {
    throw new Error("owner.json was not an owner-bound regular file");
  }
  const source = await readFile(ownerPath, "utf-8");
  let document: unknown;
  try {
    document = JSON.parse(source);
  } catch {
    throw new Error("owner.json did not match Eve's lock schema");
  }
  const owner = ownerDocumentSchema.safeParse(document);
  if (!owner.success) {
    throw new Error("owner.json did not match Eve's lock schema");
  }
  return { info, pid: owner.data.pid, source };
}

function sameLockOwner(first: LockOwner, second: LockOwner) {
  return (
    first.pid === second.pid && first.source === second.source && sameFile(first.info, second.info)
  );
}

/**
 * Eve 0.44.x retains template prewarm locks for up to thirty minutes without
 * consulting the recorded owner PID. A benchmark restart may remove only a
 * lock whose exact owner file is trustworthy, unchanged, and demonstrably
 * dead. Active and malformed locks remain visible instead of being hidden.
 */
async function removeDeadLock(
  lock: string,
  display: string,
  owner: LockOwner,
): Promise<EveEvalPrewarmLockReceipt> {
  const currentOwner = await readLockOwner(lock);
  const ownerMatches = sameLockOwner(currentOwner, owner);
  if (!ownerMatches) {
    return {
      lock: display,
      pid: owner.pid,
      reason: "lock owner changed during reconciliation",
      status: "preserved",
    };
  }
  const quarantine = `${lock}.dead-${owner.pid}-${randomUUID()}`;
  await rename(lock, quarantine);
  const movedOwner = await readLockOwner(quarantine);
  const movedOwnerMatches = sameLockOwner(movedOwner, owner);
  if (!movedOwnerMatches) {
    try {
      await rename(quarantine, lock);
    } catch {
      // The original lock path may have been concurrently recreated.
    }
    throw new Error("lock owner changed while it was quarantined");
  }
  await rm(quarantine, { recursive: true });
  return { lock: display, pid: owner.pid, status: "removed" };
}

async function reconcileLockEntry(context: LockEntryContext): Promise<EveEvalPrewarmLockReceipt[]> {
  const { backendPath, canonicalRoot, entry, locksRoot, options } = context;
  const lock = nodePath.join(backendPath, entry.name);
  const display = nodePath.relative(canonicalRoot, lock);
  if (!entry.isDirectory() || entry.isSymbolicLink() || !contained(locksRoot, lock)) {
    return [
      {
        lock: display,
        reason: "lock path was not a contained regular directory",
        status: "preserved",
      },
    ];
  }
  let owner;
  try {
    const lockInfo = await lstat(lock);
    if (!ownerBound(lockInfo)) {
      throw new Error("lock directory was not owner-bound");
    }
    owner = await readLockOwner(lock);
  } catch (error) {
    const failure = error instanceof Error ? parseProcessFailure(error) : undefined;
    return [preservedReceipt(display, failure, "owner read failed")];
  }
  if ((options.processAlive ?? defaultProcessAlive)(owner.pid)) {
    return [{ lock: display, pid: owner.pid, status: "active" }];
  }
  try {
    return [await removeDeadLock(lock, display, owner)];
  } catch (error) {
    const failure = error instanceof Error ? parseProcessFailure(error) : undefined;
    if (failure?.code === "ENOENT") {
      return [];
    }
    return [preservedReceipt(display, failure, "lock removal failed", owner.pid)];
  }
}

function preservedReceipt(
  display: string,
  failure: ProcessFailure | undefined,
  fallback: string,
  pid?: number,
): EveEvalPrewarmLockReceipt {
  const receipt: EveEvalPrewarmLockReceipt = {
    lock: display,
    reason: failure?.message ?? fallback,
    status: "preserved",
  };
  if (pid !== undefined) {
    Object.assign(receipt, { pid });
  }
  return receipt;
}

const isMissingLockDirectory = (failure: ProcessFailure | undefined) => failure?.code === "ENOENT";

const readBackendEntries = async (backendPath: string, isDirectory: boolean) => {
  if (!isDirectory) {
    return [];
  }
  return await readdir(backendPath, { withFileTypes: true });
};

const readLockBackends = async (locksRoot: string) => {
  try {
    return await readdir(locksRoot, { withFileTypes: true });
  } catch (error) {
    if (error instanceof Error && isMissingLockDirectory(parseProcessFailure(error))) {
      return [];
    }
    throw error;
  }
};

const isLockBackend = (entry: Awaited<ReturnType<typeof readdir>>[number]) =>
  entry.isDirectory() && !entry.isSymbolicLink();

const reconcileLockBackends = async (
  locksRoot: string,
  canonicalRoot: string,
  options: Readonly<{ processAlive?: (pid: number) => boolean }>,
) => {
  const backends = await readLockBackends(locksRoot);
  const receipts: EveEvalPrewarmLockReceipt[] = [];
  for (const backend of backends.toSorted((left, right) => left.name.localeCompare(right.name))) {
    const backendPath = nodePath.join(locksRoot, backend.name);
    const entries = await readBackendEntries(backendPath, isLockBackend(backend));
    for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.endsWith(".lock")) {
        receipts.push(
          ...(await reconcileLockEntry({ backendPath, canonicalRoot, entry, locksRoot, options })),
        );
      }
    }
  }
  return receipts;
};

type LockOwner = Awaited<ReturnType<typeof readLockOwner>>;

export async function reconcileDeadEveEvalPrewarmLocks(
  appRoot: string,
  options: Readonly<{ processAlive?: (pid: number) => boolean }> = {},
): Promise<readonly EveEvalPrewarmLockReceipt[]> {
  const canonicalRoot = await realpath(appRoot);
  const rootInfo = await lstat(canonicalRoot);
  if (
    nodePath.resolve(appRoot) !== canonicalRoot ||
    !rootInfo.isDirectory() ||
    !ownerBound(rootInfo)
  ) {
    throw new Error("The Eve eval application root was not owner-bound.");
  }
  const locksRoot = nodePath.join(canonicalRoot, ".eve", "sandbox-cache", "template-locks");
  return await reconcileLockBackends(locksRoot, canonicalRoot, options);
}

type LockEntryContext = Readonly<{
  backendPath: string;
  canonicalRoot: string;
  entry: Awaited<ReturnType<typeof readdir>>[number];
  locksRoot: string;
  options: Readonly<{ processAlive?: (pid: number) => boolean }>;
}>;

export function createEveEvalRuntimeDirectories(parent: string = tmpdir()) {
  const root = realpathSync(mkdtempSync(nodePath.join(parent, "app-builder-eval-")));
  chmodSync(root, 0o700);
  const home = nodePath.join(root, "home");
  const workflowData = nodePath.join(root, "workflow-data");
  mkdirSync(home, { mode: 0o700 });
  mkdirSync(workflowData, { mode: 0o700 });
  for (const path of [root, home, workflowData]) {
    const info = lstatSync(path);
    const safePath = realpathSync(path) === path && info.isDirectory() && !info.isSymbolicLink();
    if (
      !safePath ||
      info.uid !== process.getuid?.() ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error("The Eve eval runtime directory was not owner-only.");
    }
  }
  return { home, root, workflowData } satisfies EveEvalRuntimeDirectories;
}

function signalExitCode(signal: NodeJS.Signals | null) {
  if (signal === "SIGINT") {
    return 130;
  }
  if (signal === "SIGTERM") {
    return 143;
  }
  return 128;
}

/**
 * Keeps the structural capability wrapper alive while Eve runs its own
 * shutdown hooks. The detached process group is task-owned and provides a
 * bounded final backstop for listeners or descendants left by an interruption.
 */
export async function waitForEveEvalChild(
  input: Readonly<{
    authorization: Duplex;
    child: ChildProcess;
    gracefulTimeoutMs?: number;
    signalTarget?: SignalTarget;
  }>,
): Promise<number> {
  const signalTarget = input.signalTarget ?? process;
  const gracefulTimeoutMs = input.gracefulTimeoutMs ?? 16_000;
  const { promise, reject, resolve } = Promise.withResolvers<number>();
  {
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
        if (!(error instanceof Error) || parseProcessFailure(error).code !== "ESRCH") {
          throw error;
        }
      }
    };
    const handlers: ChildHandlers = {};
    const cleanup = () => {
      if (forceTimer !== undefined) {
        clearTimeout(forceTimer);
      }
      if (handlers.interrupt !== undefined) {
        signalTarget.off("SIGINT", handlers.interrupt);
      }
      if (handlers.terminate !== undefined) {
        signalTarget.off("SIGTERM", handlers.terminate);
      }
      if (handlers.failed !== undefined) {
        input.child.off("error", handlers.failed);
      }
      if (handlers.exited !== undefined) {
        input.child.off("exit", handlers.exited);
      }
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
    const interrupt = () => {
      requestStop("SIGINT");
    };
    const terminate = () => {
      requestStop("SIGTERM");
    };
    const failed = (error: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      reject(error);
    };
    const exited = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) {
        return;
      }
      settled = true;
      // A successful Eve CLI exit can still outpace a forked local host. The
      // detached group is scoped to this one eval, so completion and failure
      // share the same descendant cleanup boundary.
      forceGroup();
      cleanup();
      resolve(code ?? signalExitCode(requestedSignal ?? signal));
    };
    handlers.exited = exited;
    handlers.failed = failed;
    handlers.interrupt = interrupt;
    handlers.terminate = terminate;
    signalTarget.on("SIGINT", interrupt);
    signalTarget.on("SIGTERM", terminate);
    input.child.once("error", failed);
    input.child.once("exit", exited);
  }
  return await promise;
}
