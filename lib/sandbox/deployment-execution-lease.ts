import type { RuntimeSandboxSession } from "eve/sandbox";
import { setTimeout as delay } from "node:timers/promises";

import { parseHostedDatabaseUrl } from "../db/postgres-connection-policy";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { readHostedDeploymentEnvironment } from "../hosted/deployment-environment";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type {
  SandboxExecutionLease,
  SandboxExecutionLeaseStore,
  SandboxLeaseReleaseReason,
} from "./execution-lease";
import { SANDBOX_EXECUTION_POLICY, sandboxExecutionPolicyDigest } from "./execution-policy";
import { createPostgresSandboxExecutionLeaseStore } from "./postgres-execution-lease-store";

export const HOSTED_SANDBOX_EXECUTION_ACTIVATION = "enabled-v1";
const cleanupEvidenceKey = Symbol.for("autograph.app-builder.sandbox-cleanup-evidence.v1");

export interface SandboxCleanupEvidence {
  attempted: true;
  stopped: boolean;
  timedOut: boolean;
}

interface CommandAuthority {
  lease: SandboxExecutionLease;
  store: SandboxExecutionLeaseStore;
}

interface RuntimeDependencies {
  enabled: (environment: Readonly<Record<string, string | undefined>>) => boolean;
  store: (environment: Readonly<Record<string, string | undefined>>) => SandboxExecutionLeaseStore;
  isMember: (input: {
    principal: HostedPrincipal;
    workspaceId: string;
    environment: Readonly<Record<string, string | undefined>>;
  }) => Promise<boolean>;
}

const commandAuthorities = new Map<string, CommandAuthority>();
let database: ReturnType<typeof openHostedPostgresDatabase> | undefined;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function isHostedSandboxExecutionEnabled(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return (
    environment.EVE_HOSTED_ADAPTER === "1" &&
    environment.EVE_HOSTED_SANDBOX_EXECUTION === HOSTED_SANDBOX_EXECUTION_ACTIVATION
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function hostedLeaseEnabled(environment: Readonly<Record<string, string | undefined>>) {
  if (!isHostedSandboxExecutionEnabled(environment)) {return false;}
  readHostedDeploymentEnvironment(environment);
  return true;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function hostedLeaseDatabase(environment: Readonly<Record<string, string | undefined>>) {
  database ??= openHostedPostgresDatabase(parseHostedDatabaseUrl(environment.DATABASE_URL));
  return database;
}

const defaultDependencies: RuntimeDependencies = {
  enabled: hostedLeaseEnabled,
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  async isMember({ principal, workspaceId, environment }) {
    return createPostgresWorkspaceMembership(hostedLeaseDatabase(environment)).isMember({
      principal,
      workspaceId,
    });
  },
  store: (environment) =>
    createPostgresSandboxExecutionLeaseStore(hostedLeaseDatabase(environment)),
};

let dependencies = defaultDependencies;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function errorWithCleanupEvidence(error: unknown, evidence: SandboxCleanupEvidence) {
  const preserved =
    error instanceof Error
      ? error
      : new Error("Hosted sandbox execution acquisition failed.", {
          cause: error,
        });
  Object.defineProperty(preserved, cleanupEvidenceKey, {
    configurable: true,
    enumerable: false,
    value: evidence,
  });
  return preserved;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function sandboxCleanupEvidence(error: unknown) {
  return error instanceof Error
    ? ((error as unknown as Record<PropertyKey, unknown>)[cleanupEvidenceKey] as
        | SandboxCleanupEvidence
        | undefined)
    : undefined;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function stopWithin(
  sandbox: Pick<RuntimeSandboxSession, "stop">,
  timeoutMs = SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
): Promise<SandboxCleanupEvidence> {
  const timeoutController = new AbortController();
  const stop = Promise.resolve(sandbox.stop());
  // Intentionally observe stop failure without awaiting it before the timeout race.
  // oxlint-disable-next-line promise/prefer-await-to-then
  stop.catch(() => null);
  const timeout = delay(timeoutMs, "timeout" as const, {
    ref: false,
    signal: timeoutController.signal,
  });
  try {
    const result = await Promise.race([
      stop.then(() => "stopped" as const).catch(() => "failed" as const),
      timeout,
    ]);
    return {
      attempted: true,
      stopped: result === "stopped",
      timedOut: result === "timeout",
    };
  } finally {
    timeoutController.abort();
  }
}

/** Acquire one epoch at Eve's awaited `turn.started` boundary. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function acquireHostedSandboxExecutionLease(input: {
  sessionId: string;
  sessionAuth: unknown;
  sandbox: RuntimeSandboxSession;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  let enabled: boolean;
  try {
    enabled = dependencies.enabled(environment);
  } catch (error) {
    const evidence = await stopWithin(input.sandbox);
    throw errorWithCleanupEvidence(error, evidence);
  }
  if (!enabled) {return;}
  try {
    const { authority, principal } = exactForwardedSessionAuthority(input.sessionAuth);
    if (
      !(await dependencies.isMember({
        environment,
        principal,
        workspaceId: authority.workspaceId,
      }))
    ) {
      throw new Error("Hosted sandbox execution membership is not active.");
    }
    const store = dependencies.store(environment);
    const result = await store.acquire({
      adapterSessionId: input.sessionId,
      nowEpochMs: input.nowEpochMs ?? Date.now(),
      policy: SANDBOX_EXECUTION_POLICY,
      principal,
      providerSandboxId: input.sandbox.id,
    });
    if (result.disposition === "rejected") {
      throw new Error("Hosted sandbox recovery is still in progress.");
    }
    commandAuthorities.set(input.sessionId, {
      lease: result.lease,
      store,
    });
    return result.lease;
  } catch (error) {
    const evidence = await stopWithin(input.sandbox);
    throw errorWithCleanupEvidence(error, evidence);
  }
}

/** Reassert the current durable epoch immediately before command dispatch. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function assertHostedSandboxCommandAuthority(input: {
  sessionId: string;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!dependencies.enabled(environment)) {return;}
  const active = commandAuthorities.get(input.sessionId);
  if (active === undefined) {
    throw new Error("Hosted sandbox command authority is unavailable.");
  }
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  let lease = await active.store.assertCurrent({
    adapterSessionId: active.lease.adapterSessionId,
    epoch: active.lease.epoch,
    nowEpochMs,
    policyDigest: active.lease.policyDigest,
    principal: active.lease.principal,
    providerSandboxId: active.lease.providerSandboxId,
  });
  if (nowEpochMs - lease.heartbeatAtEpochMs >= SANDBOX_EXECUTION_POLICY.lease.heartbeatMs) {
    lease = await active.store.heartbeat({
      adapterSessionId: lease.adapterSessionId,
      epoch: lease.epoch,
      nowEpochMs,
      principal: lease.principal,
    });
    commandAuthorities.set(input.sessionId, { ...active, lease });
  }
  return lease;
}

/** Stop compute and release without consulting process-local command state. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function releaseHostedSandboxExecutionLease(input: {
  sessionId: string;
  sessionAuth: unknown;
  sandbox: RuntimeSandboxSession;
  reason: SandboxLeaseReleaseReason;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!dependencies.enabled(environment)) {return { released: false } as const;}
  let principal: HostedPrincipal;
  try {
    ({ principal } = exactForwardedSessionAuthority(input.sessionAuth));
  } catch (error) {
    const evidence = await stopWithin(input.sandbox);
    throw errorWithCleanupEvidence(error, evidence);
  }
  const evidence = await stopWithin(input.sandbox);
  if (!evidence.stopped) {
    throw errorWithCleanupEvidence(
      new Error("Hosted sandbox compute did not stop at the turn boundary."),
      evidence,
    );
  }
  const released = await dependencies.store(environment).releaseCurrent({
    adapterSessionId: input.sessionId,
    nowEpochMs: input.nowEpochMs ?? Date.now(),
    policyDigest: sandboxExecutionPolicyDigest(),
    principal,
    providerSandboxId: input.sandbox.id,
    reason: input.reason,
  });
  commandAuthorities.delete(input.sessionId);
  return released === null
    ? ({ released: false } as const)
    : ({ lease: released, released: true } as const);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function setHostedSandboxExecutionLeaseDependenciesForTest(
  replacement: RuntimeDependencies,
) {
  dependencies = replacement;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function clearHostedSandboxExecutionLeaseCacheForTest() {
  commandAuthorities.clear();
  database = undefined;
  dependencies = defaultDependencies;
}
