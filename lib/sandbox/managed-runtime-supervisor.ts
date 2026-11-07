/* oxlint-disable promise/avoid-new -- Node child spawn/close events and bounded owned cleanup require event-to-Promise adapters. */
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { z } from "zod";
import { managedRuntimeIdentitySchema } from "./managed-runtime-capabilities";
import type { ManagedRuntimeIdentity } from "./managed-runtime-capabilities";

const managedLifecycleOperations = [
  "stop-and-wait",
  "start-same-environment",
  "observe-readiness",
] as const;
const reconciliationRequiredState = "reconciliation-required";
const stoppedState = "stopped";

export const managedLifecycleCommandSchema = z.discriminatedUnion("operation", [
  z.strictObject({ operation: z.literal("status") }),
  z.strictObject({
    commandId: z.uuid(),
    operation: z.enum(managedLifecycleOperations),
  }),
]);
export type ManagedLifecycleCommand = z.infer<typeof managedLifecycleCommandSchema>;
const exitSchema = z.strictObject({
  code: z.number().int().nullable(),
  observedAt: z.iso.datetime(),
  signal: z.string().nullable(),
});
const processSchema = z.strictObject({
  exit: exitSchema.optional(),
  generation: z.number().int().positive().refine(Number.isSafeInteger),
  pid: z.number().int().positive().refine(Number.isSafeInteger),
  readiness: z.strictObject({ observedAt: z.iso.datetime(), ready: z.boolean() }).optional(),
  startedAt: z.iso.datetime(),
});
export const managedLifecycleReceiptSchema = z.strictObject({
  commandId: z.uuid().optional(),
  identity: managedRuntimeIdentitySchema,
  operation: z.enum(["status", ...managedLifecycleOperations]),
  process: processSchema.optional(),
  state: z.enum([
    stoppedState,
    "starting",
    "ready",
    "stopping",
    "revoked",
    "expired",
    reconciliationRequiredState,
  ]),
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
const missingProcessGroupCode = "ESRCH";
const deniedProcessGroupCode = "EPERM";
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
      detached: true,
      // Node accepts arbitrary string environment entries; Next adds a required
      // NODE_ENV to ProcessEnv for its own server, not this owned child.
      // SAFETY: Every supplied value is a string; no host environment is inherited.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Adapt the Next-augmented Node declaration without adding an app environment variable.
      env: { ...launch.appEnvironment } as NodeJS.ProcessEnv,
      stdio: "ignore",
    });
    let failure = false;
    const closed = new Promise<ManagedChildExit>((resolve) => {
      child.once("error", () => {
        failure = true;
      });
      child.once("close", (code, signal) => {
        resolve({ code, observedAt: new Date().toISOString(), signal });
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
        if (z.object({ code: z.literal(missingProcessGroupCode) }).safeParse(error).success) {
          return false;
        }
        if (z.object({ code: z.literal(deniedProcessGroupCode) }).safeParse(error).success) {
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
        if (!z.object({ code: z.literal(missingProcessGroupCode) }).safeParse(error).success) {
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
    const terminate = async () => {
      termination ??= (async () => {
        signalGroup("SIGTERM");
        try {
          return await waitUntilGone();
        } catch {
          signalGroup("SIGKILL");
          return await waitUntilGone();
        }
      })();
      return await termination;
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
      const { pid } = child;
      if (pid === undefined || failure) {
        throw unavailable();
      }
      return { closed, pid, terminate };
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
  let state: ManagedLifecycleReceipt["state"] = stoppedState;
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
  ): ManagedLifecycleReceipt => {
    const receipt: ManagedLifecycleReceipt = { identity, operation, state };
    if (current !== undefined) {
      receipt.process = current.observation;
    }
    if (commandId !== undefined) {
      receipt.commandId = commandId;
    }
    return structuredClone(receipt);
  };
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
          state = reconciliationRequiredState;
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
      state = stoppedState;
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
          state = reconciliationRequiredState;
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
      current.observation.readiness = { observedAt: now().toISOString(), ready };
      state = ready ? "ready" : "starting";
    }
    return snapshot(command.operation, command.commandId);
  };
  return {
    async close() {
      closedByOwner.abort();
      await revoke();
    },
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
            state = reconciliationRequiredState;
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
  };
};
