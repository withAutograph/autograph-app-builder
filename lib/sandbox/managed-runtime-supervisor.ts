/* oxlint-disable promise/avoid-new -- Node child spawn/close events and bounded owned cleanup require event-to-Promise adapters. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { managedRuntimeIdentitySchema } from "./managed-runtime-capabilities";
import type { ManagedRuntimeIdentity } from "./managed-runtime-capabilities";

export const managedLifecycleCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({
    operation: z.enum(["stop-and-wait", "start-same-environment", "observe-readiness"]),
    commandId: z.uuid(),
  }),
]);
export type ManagedLifecycleCommand = z.infer<typeof managedLifecycleCommandSchema>;
const exitSchema = z.strictObject({
  code: z.number().int().nullable(),
  signal: z.string().nullable(),
  observedAt: z.iso.datetime(),
});
const processSchema = z.strictObject({
  generation: z.number().int().positive().refine(Number.isSafeInteger),
  pid: z.number().int().positive().refine(Number.isSafeInteger),
  startedAt: z.iso.datetime(),
  exit: exitSchema.optional(),
  readiness: z.strictObject({ ready: z.boolean(), observedAt: z.iso.datetime() }).optional(),
});
export const managedLifecycleReceiptSchema = z.strictObject({
  identity: managedRuntimeIdentitySchema,
  state: z.enum([
    "stopped",
    "starting",
    "ready",
    "stopping",
    "revoked",
    "expired",
    "reconciliation-required",
  ]),
  process: processSchema.optional(),
  commandId: z.uuid().optional(),
  operation: z.enum(["status", "stop-and-wait", "start-same-environment", "observe-readiness"]),
});
export type ManagedChildExit = z.infer<typeof exitSchema>;
export interface ManagedOwnedChild {
  pid: number;
  closed: Promise<ManagedChildExit>;
  terminate: () => Promise<ManagedChildExit>;
}
export type ManagedProcessObservation = z.infer<typeof processSchema>;
export type ManagedLifecycleReceipt = z.infer<typeof managedLifecycleReceiptSchema>;
interface OwnedManagedProcess {
  child: ManagedOwnedChild;
  observation: ManagedProcessObservation;
}
const childHasExited = (owned: OwnedManagedProcess) => owned.observation.exit !== undefined;
const unavailable = () => new Error("Managed lifecycle is unavailable.");
const bounded = async <T>(promise: Promise<T>, milliseconds: number): Promise<T> => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => {
          reject(unavailable());
        }, milliseconds);
      }),
    ]);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
};
/** Private trusted launch definition, never part of an IPC command. Captures one environment without ambient host credentials. */
export const createManagedOwnedChildLauncher = (input: {
  executable: string;
  args: readonly string[];
  cwd: string;
  appEnvironment: Readonly<Record<string, string>>;
  stopTimeoutMs?: number;
}) => {
  const launch = structuredClone(input);
  const stopTimeoutMs = input.stopTimeoutMs ?? 5000;
  return async (): Promise<ManagedOwnedChild> => {
    const child: ChildProcess = spawn(launch.executable, [...launch.args], {
      cwd: launch.cwd,
      // Node accepts arbitrary string environment entries; Next adds a required
      // NODE_ENV to ProcessEnv for its own server, not this owned child.
      // SAFETY: Every supplied value is a string; no host environment is inherited.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Adapt the Next-augmented Node declaration without adding an app environment variable.
      env: { ...launch.appEnvironment } as NodeJS.ProcessEnv,
      stdio: "ignore",
      detached: true,
    });
    let failure = false;
    const closed = new Promise<ManagedChildExit>((resolve) => {
      child.once("error", () => {
        failure = true;
      });
      child.once("close", (code, signal) => {
        resolve({ code, signal, observedAt: new Date().toISOString() });
      });
    });
    // Only this launch creates and captures the group. No caller can supply a PID/PGID.
    const ownedGroup = child.pid;
    const groupExists = () => {
      if (ownedGroup === undefined) {
        return false;
      }
      try {
        process.kill(-ownedGroup, 0);
        return true;
      } catch (error) {
        if (z.object({ code: z.literal("ESRCH") }).safeParse(error).success) {
          return false;
        }
        if (z.object({ code: z.literal("EPERM") }).safeParse(error).success) {
          // Permission denial proves neither disappearance nor successful cleanup.
          return true;
        }
        throw unavailable();
      }
    };
    const signalGroup = (signal: NodeJS.Signals) => {
      if (ownedGroup === undefined) {
        return;
      }
      try {
        process.kill(-ownedGroup, signal);
      } catch (error) {
        if (!z.object({ code: z.literal("ESRCH") }).safeParse(error).success) {
          throw unavailable();
        }
      }
    };
    const waitUntilGone = async () => {
      const deadline = Date.now() + stopTimeoutMs;
      const exit = await bounded(closed, stopTimeoutMs);
      while (groupExists()) {
        if (Date.now() >= deadline) {
          throw unavailable();
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- Sequentially observe only the created process group until bounded cleanup completes.
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
      return exit;
    };
    let termination: Promise<ManagedChildExit> | undefined;
    const terminate = () => {
      termination ??= (async () => {
        signalGroup("SIGTERM");
        try {
          return await waitUntilGone();
        } catch {
          signalGroup("SIGKILL");
          return await waitUntilGone();
        }
      })();
      return termination;
    };
    // Start cleanup as soon as the owned wrapper exits, before its group could be reused.
    child.once("close", () => {
      void (async () => {
        try {
          await terminate();
        } catch {
          // The retained termination promise reports uncertain cleanup to the supervisor.
        }
      })();
    });
    try {
      await bounded(
        new Promise<void>((resolve, reject) => {
          child.once("spawn", resolve);
          child.once("error", () => {
            reject(unavailable());
          });
        }),
        stopTimeoutMs,
      );
      const pid = child.pid;
      if (pid === undefined || failure) {
        throw unavailable();
      }
      return { pid, closed, terminate };
    } catch {
      await terminate();
      throw unavailable();
    }
  };
};

/** Owns exactly the child supplied by its retained launch closure. No caller selects a PID, command, environment, or origin. */
export const createManagedRuntimeSupervisor = (input: {
  identity: ManagedRuntimeIdentity;
  expiresAt: number;
  ownershipSignal: AbortSignal;
  assertCurrent: () => Promise<void>;
  launchSameEnvironment: () => Promise<ManagedOwnedChild>;
  observeReadiness: (input: {
    generation: number;
    pid: number;
    signal: AbortSignal;
  }) => Promise<boolean>;
  now?: () => Date;
}) => {
  const identity = managedRuntimeIdentitySchema.parse(structuredClone(input.identity));
  const now = input.now ?? (() => new Date());
  let state: ManagedLifecycleReceipt["state"] = "stopped";
  let generation = 0;
  const intentionalExit = () => new Set(["stopping", "revoked", "expired"]).has(state);
  let current: { child: ManagedOwnedChild; observation: ManagedProcessObservation } | undefined;
  let tail: Promise<void> = Promise.resolve();
  const commands = new Map<
    string,
    { operation: ManagedLifecycleCommand["operation"]; result: Promise<ManagedLifecycleReceipt> }
  >();
  const closedByOwner = new AbortController();
  const signal = AbortSignal.any([
    closedByOwner.signal,
    input.ownershipSignal,
    AbortSignal.timeout(Math.max(0, input.expiresAt - now().getTime())),
  ]);
  const snapshot = (
    operation: ManagedLifecycleCommand["operation"],
    commandId?: string,
  ): ManagedLifecycleReceipt =>
    structuredClone({
      identity,
      state,
      ...(current ? { process: current.observation } : {}),
      operation,
      ...(commandId === undefined ? {} : { commandId }),
    });
  const assertCurrent = async () => {
    if (signal.aborted || now().getTime() >= input.expiresAt) {
      throw unavailable();
    }
    await input.assertCurrent();
    if (signal.aborted || now().getTime() >= input.expiresAt) {
      throw unavailable();
    }
  };
  const revoke = async () => {
    state = now().getTime() >= input.expiresAt ? "expired" : "revoked";
    if (current) {
      current.observation.exit = await current.child.terminate();
    }
  };
  signal.addEventListener(
    "abort",
    () => {
      void (async () => {
        try {
          await revoke();
        } catch {
          state = "reconciliation-required";
        }
      })();
    },
    { once: true },
  );
  const perform = async (command: Exclude<ManagedLifecycleCommand, { operation: "status" }>) => {
    await assertCurrent();
    if (command.operation === "stop-and-wait") {
      state = "stopping";
      if (current) {
        current.observation.exit = await current.child.terminate();
      }
      await assertCurrent();
      state = "stopped";
    } else if (command.operation === "start-same-environment") {
      if (current && !current.observation.exit) {
        throw unavailable();
      }
      if (current) {
        await current.child.terminate();
      }
      await assertCurrent();
      state = "starting";
      const child = await input.launchSameEnvironment();
      generation += 1;
      const owned: OwnedManagedProcess = {
        child,
        observation: { generation, pid: child.pid, startedAt: now().toISOString() },
      };
      current = owned;
      void (async () => {
        const exit = await child.closed;
        owned.observation.exit = exit;
        if (current === owned && !intentionalExit()) {
          state = "reconciliation-required";
        }
      })();
      try {
        await assertCurrent();
      } catch (error) {
        await child.terminate();
        throw error;
      }
    } else {
      if (!current || current.observation.exit) {
        throw unavailable();
      }
      const ready = await bounded(
        input.observeReadiness({
          generation: current.observation.generation,
          pid: current.child.pid,
          signal,
        }),
        10_000,
      );
      await assertCurrent();
      if (childHasExited(current)) {
        throw unavailable();
      }
      current.observation.readiness = { ready, observedAt: now().toISOString() };
      state = ready ? "ready" : "starting";
    }
    return snapshot(command.operation, command.commandId);
  };
  return {
    async execute(value: ManagedLifecycleCommand): Promise<ManagedLifecycleReceipt> {
      const command = managedLifecycleCommandSchema.parse(value);
      if (command.operation === "status") {
        await assertCurrent();
        return snapshot("status");
      }
      const previous = commands.get(command.commandId);
      if (previous) {
        if (previous.operation !== command.operation) {
          throw unavailable();
        }
        await assertCurrent();
        return await previous.result;
      }
      const result = (async () => {
        await tail;
        try {
          return await perform(command);
        } catch {
          if (!signal.aborted) {
            state = "reconciliation-required";
          }
          throw unavailable();
        }
      })();
      commands.set(command.commandId, { operation: command.operation, result });
      tail = (async () => {
        try {
          await result;
        } catch {
          /* The receipt retains the original failure; the serial owner queue remains usable. */
        }
      })();
      return await result;
    },
    async close() {
      closedByOwner.abort();
      await revoke();
    },
  };
};
