/* oxlint-disable eslint/no-await-in-loop -- Readiness retries await the same owned process under its current lease. */
/** Fixed VM worker entry, bundled with the shared supervisor and Arrusted's public verifier. */
import { readFile, writeFile, lstat, unlink, rename, mkdir } from "node:fs/promises";
import path from "node:path";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { z } from "zod";
import {
  createManagedRuntimeSupervisor,
  createManagedOwnedChildLauncher,
} from "../sandbox/managed-runtime-supervisor";
import { createManagedRuntimeBridge } from "../sandbox/managed-runtime-bridge";
import type { ManagedGatewayVerificationAdapter } from "../sandbox/managed-runtime-bridge";
import {
  managedRuntimeCurrentSchema,
  managedRuntimePublicProfileSchema,
} from "../sandbox/managed-runtime-capabilities";
import type { ManagedRuntimeCurrent } from "../sandbox/managed-runtime-capabilities";
import { SANDBOX_EXECUTION_POLICY } from "../sandbox/execution-policy";
import { startManagedRuntimeIpc } from "../sandbox/managed-runtime-ipc";

export const managedRuntimeOwnerLease = (approvedExpiry: string, now = Date.now()) =>
  new Date(
    Math.min(Date.parse(approvedExpiry), now + SANDBOX_EXECUTION_POLICY.lease.heartbeatMs),
  ).toISOString();

export const managedRuntimeEntryInputSchema = z.strictObject({
  version: z.literal(1),
  current: managedRuntimeCurrentSchema,
  profile: managedRuntimePublicProfileSchema,
  actors: z
    .array(z.strictObject({ actorId: z.string().min(1), organizationId: z.string().min(1) }))
    .min(1),
  root: z.string().min(1),
  rootDirectory: z.string().min(1),
  appEnvironment: z.record(z.string(), z.string()),
  appPort: z.number().int().min(1).max(65_535),
  bridgePort: z.number().int().min(1).max(65_535),
  lifecycleSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  transportSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});
export type ManagedRuntimeEntryInput = z.infer<typeof managedRuntimeEntryInputSchema>;
export const managedRuntimeReadySchema = z.strictObject({
  current: managedRuntimeCurrentSchema,
  socketPath: z.string().min(1),
  appPort: z.number().int(),
  bridgePort: z.number().int(),
});
const unavailable = () => new Error("Managed runtime authority is unavailable.");
class ManagedRuntimeCleanupError extends Error {
  constructor() {
    super("Managed runtime cleanup is incomplete.");
    this.name = "ManagedRuntimeCleanupError";
  }
}
const atomicMetadata = async (
  file: string,
  value: ManagedRuntimeCurrent | z.infer<typeof managedRuntimeReadySchema>,
) => {
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value), { mode: 0o600, flag: "wx" });
  await rename(temporary, file);
};
/** Input contains no selector/lifecycle/transport bearers. Runtime credentials are unlinked before app spawn. */
export const readManagedRuntimeEntryInput = async (file: string) => {
  const info = await lstat(file);
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    // oxlint-disable-next-line eslint/no-bitwise -- Unix permission bits protect this private credential handoff.
    (info.mode & 0o777) !== 0o600 ||
    info.uid !== process.getuid?.()
  ) {
    throw unavailable();
  }
  const value = managedRuntimeEntryInputSchema.parse(JSON.parse(await readFile(file, "utf-8")));
  await unlink(file);
  return value;
};
export const runManagedRuntimeEntry = async <Configuration>(
  input: ManagedRuntimeEntryInput,
  verification: ManagedGatewayVerificationAdapter<Configuration>,
  parentSignal?: AbortSignal,
) => {
  const parsed = managedRuntimeEntryInputSchema.parse(input);
  const { current: initial } = parsed;
  const identity = {
    intentId: initial.intentId,
    approvalRef: initial.approvalRef,
    owner: initial.owner,
    appId: initial.appId,
    runtimeAttemptId: initial.runtimeAttemptId,
    fence: initial.fence,
    sandboxId: initial.sandboxId,
    providerSessionId: initial.providerSessionId,
  };
  const ownership = new AbortController();
  const ownershipSignal = parentSignal
    ? AbortSignal.any([parentSignal, ownership.signal])
    : ownership.signal;
  const currentPath = path.join(parsed.rootDirectory, "current.json");
  await mkdir(parsed.rootDirectory, { recursive: true, mode: 0o700 });
  await atomicMetadata(currentPath, {
    ...initial,
    leaseExpiresAt: managedRuntimeOwnerLease(initial.leaseExpiresAt),
  });
  const readCurrent = async () => {
    ownershipSignal.throwIfAborted();
    const current = managedRuntimeCurrentSchema.parse(
      JSON.parse(await readFile(currentPath, "utf-8")),
    );
    const { state, leaseExpiresAt, ...observed } = current;
    if (
      !isDeepStrictEqual(observed, identity) ||
      !Number.isFinite(Date.parse(leaseExpiresAt)) ||
      Date.parse(leaseExpiresAt) <= Date.now() ||
      ["revoked", "expired", "reconciliation-required"].includes(state)
    ) {
      throw unavailable();
    }
    return current;
  };
  const assertCurrent = async () => {
    await readCurrent();
  };
  const appKey = `${identity.appId.toUpperCase().replaceAll("-", "_")}_DATABASE_URL`;
  const permitted = new Set([
    appKey,
    "PLATFORM_JWKS_URL",
    "PLATFORM_ORIGIN",
    "PLATFORM_PUBLIC_ORIGIN",
    "PLATFORM_APP_BOUNDARY",
  ]);
  if (
    parsed.profile.appId !== identity.appId ||
    Object.keys(parsed.appEnvironment).some((key) => !permitted.has(key))
  ) {
    throw unavailable();
  }
  // Public verification data is projected by this owner, never accepted as an app override.
  // The existing strict profile schema excludes signer material and private JWK fields.
  const appEnvironment = {
    ...parsed.appEnvironment,
    PLATFORM_MANAGED_GATEWAY_PUBLIC_PROFILE: JSON.stringify(parsed.profile),
  };
  // Arrusted's app:runtime reads its binding from this private state directory
  // before launching an app. Preserve the same resource across process replacement.
  const appStateDirectory = path.join(parsed.rootDirectory, "app-state");
  await mkdir(appStateDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(appStateDirectory, "environment.json"),
    JSON.stringify(appEnvironment),
    { mode: 0o600, flag: "wx" },
  );
  const launchSameEnvironment = createManagedOwnedChildLauncher({
    executable: "mise",
    args: ["run", "app:runtime", "run", identity.appId, "dev"],
    cwd: parsed.root,
    appEnvironment: {
      ...appEnvironment,
      APP_RUNTIME_STATE_DIR: appStateDirectory,
      PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
      HOME: process.env.HOME ?? "/tmp",
      PORT: String(parsed.appPort),
    },
  });
  const supervisor = createManagedRuntimeSupervisor({
    identity,
    expiresAt: Date.parse(initial.leaseExpiresAt),
    ownershipSignal,
    assertCurrent,
    launchSameEnvironment,
    observeReadiness: async ({ signal }) => {
      try {
        const response = await fetch(`http://127.0.0.1:${parsed.appPort}/`, {
          redirect: "manual",
          signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]),
        });
        await response.body?.cancel();
        return response.status < 500;
      } catch {
        signal.throwIfAborted();
        return false;
      }
    },
  });
  const ipc = await startManagedRuntimeIpc({
    lifecycleSha256: parsed.lifecycleSha256,
    supervisor,
    rootDirectory: parsed.rootDirectory,
  });
  const bridge = createManagedRuntimeBridge({
    identity,
    profile: parsed.profile,
    transportSha256: parsed.transportSha256,
    actors: parsed.actors,
    appPort: parsed.appPort,
    expiresAt: Date.parse(initial.leaseExpiresAt),
    ownershipSignal,
    readCurrent,
    verification,
  });
  let closing: Promise<void> | undefined;
  interface RuntimeMonitoring {
    watch?: ReturnType<typeof setInterval>;
  }
  const monitoring: RuntimeMonitoring = {};
  const close = async () => {
    closing ??= (async () => {
      ownership.abort();
      if (monitoring.watch !== undefined) {
        clearInterval(monitoring.watch);
      }
      const outcomes = await Promise.allSettled([bridge.close(), ipc.close(), supervisor.close()]);
      if (outcomes.some((outcome) => outcome.status === "rejected")) {
        throw new ManagedRuntimeCleanupError();
      }
    })();
    await closing;
  };
  monitoring.watch = setInterval(() => {
    void (async () => {
      try {
        await assertCurrent();
      } catch {
        await close();
      }
    })();
  }, 1000);
  try {
    const listening = once(bridge.server, "listening");
    bridge.server.listen(parsed.bridgePort, "0.0.0.0");
    await listening;
    await supervisor.execute({ operation: "start-same-environment", commandId: randomUUID() });
    let ready = await supervisor.execute({
      operation: "observe-readiness",
      commandId: randomUUID(),
    });
    while (ready.state !== "ready") {
      await assertCurrent();
      // oxlint-disable-next-line eslint/no-await-in-loop -- Observe actual app startup under the owned runtime expiry.
      await delay(250, undefined, { signal: ownershipSignal });
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each readiness observation has its own retained operation identity.
      ready = await supervisor.execute({ operation: "observe-readiness", commandId: randomUUID() });
    }
    const current = { ...initial, state: "ready" as const };
    await atomicMetadata(currentPath, { ...(await readCurrent()), state: "ready" });
    await atomicMetadata(
      path.join(parsed.rootDirectory, "ready.json"),
      managedRuntimeReadySchema.parse({
        current,
        socketPath: ipc.socketPath,
        appPort: parsed.appPort,
        bridgePort: parsed.bridgePort,
      }),
    );
    return {
      close,
      replacePublicProfile: async (profile: Parameters<typeof bridge.replacePublicProfile>[0]) => {
        await bridge.replacePublicProfile(profile);
      },
    };
  } catch (error) {
    await close();
    throw error;
  }
};
/** This function is called only by the fixed build wrapper; callers cannot select an adapter module. */
export const runManagedRuntimeEntryCli = async <Configuration>(
  verification: ManagedGatewayVerificationAdapter<Configuration>,
) => {
  const [operation, flag, file, ...extra] = process.argv.slice(2);
  if (
    operation !== "protected-managed-app-runtime" ||
    flag !== "--input-file" ||
    file === undefined ||
    extra.length !== 0
  ) {
    throw unavailable();
  }
  const shutdown = new AbortController();
  let runtime: Awaited<ReturnType<typeof runManagedRuntimeEntry<Configuration>>> | undefined;
  const close = () => {
    shutdown.abort();
    if (runtime !== undefined) {
      void (async () => {
        try {
          await runtime.close();
          process.exit(0);
        } catch {
          process.exit(1);
        }
      })();
    }
  };
  process.once("SIGTERM", close);
  process.once("SIGINT", close);
  try {
    const input = await readManagedRuntimeEntryInput(file);
    runtime = await runManagedRuntimeEntry(input, verification, shutdown.signal);
    if (shutdown.signal.aborted) {
      await runtime.close();
    }
  } catch (error) {
    if (error instanceof ManagedRuntimeCleanupError || !shutdown.signal.aborted) {
      throw error;
    }
  }
};
