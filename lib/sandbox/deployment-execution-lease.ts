import type { RuntimeSandboxSession } from "eve/sandbox";

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
import {
  SANDBOX_EXECUTION_POLICY,
  sandboxExecutionPolicyDigest,
} from "./execution-policy";
import { createPostgresSandboxExecutionLeaseStore } from "./postgres-execution-lease-store";

export const HOSTED_SANDBOX_EXECUTION_ACTIVATION = "enabled-v1";
const cleanupEvidenceKey = Symbol.for(
  "autograph.app-builder.sandbox-cleanup-evidence.v1",
);

export type SandboxCleanupEvidence = {
  attempted: true;
  stopped: boolean;
  timedOut: boolean;
};

type CommandAuthority = {
  lease: SandboxExecutionLease;
  store: SandboxExecutionLeaseStore;
};

type RuntimeDependencies = {
  enabled(environment: Readonly<Record<string, string | undefined>>): boolean;
  store(
    environment: Readonly<Record<string, string | undefined>>,
  ): SandboxExecutionLeaseStore;
  isMember(input: {
    principal: HostedPrincipal;
    workspaceId: string;
    environment: Readonly<Record<string, string | undefined>>;
  }): Promise<boolean>;
};

const commandAuthorities = new Map<string, CommandAuthority>();
let database: ReturnType<typeof openHostedPostgresDatabase> | undefined;

export function isHostedSandboxExecutionEnabled(
  environment: Readonly<Record<string, string | undefined>>,
) {
  return (
    environment.EVE_HOSTED_ADAPTER === "1" &&
    environment.EVE_HOSTED_SANDBOX_EXECUTION ===
      HOSTED_SANDBOX_EXECUTION_ACTIVATION
  );
}

function hostedLeaseEnabled(
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (!isHostedSandboxExecutionEnabled(environment)) return false;
  readHostedDeploymentEnvironment(environment);
  return true;
}

function hostedLeaseDatabase(
  environment: Readonly<Record<string, string | undefined>>,
) {
  database ??= openHostedPostgresDatabase(
    parseHostedDatabaseUrl(environment.DATABASE_URL),
  );
  return database;
}

const defaultDependencies: RuntimeDependencies = {
  enabled: hostedLeaseEnabled,
  store: (environment) =>
    createPostgresSandboxExecutionLeaseStore(hostedLeaseDatabase(environment)),
  async isMember({ principal, workspaceId, environment }) {
    return createPostgresWorkspaceMembership(
      hostedLeaseDatabase(environment),
    ).isMember({ principal, workspaceId });
  },
};

let dependencies = defaultDependencies;

function errorWithCleanupEvidence(
  error: unknown,
  evidence: SandboxCleanupEvidence,
) {
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

export function sandboxCleanupEvidence(error: unknown) {
  return error instanceof Error
    ? ((error as unknown as Record<PropertyKey, unknown>)[
        cleanupEvidenceKey
      ] as SandboxCleanupEvidence | undefined)
    : undefined;
}

async function stopWithin(
  sandbox: Pick<RuntimeSandboxSession, "stop">,
  timeoutMs = SANDBOX_EXECUTION_POLICY.command.maximumKillCleanupTimeMs,
): Promise<SandboxCleanupEvidence> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = Promise.resolve(sandbox.stop());
  stop.catch(() => undefined);
  const timeout = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
    timer.unref?.();
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
    clearTimeout(timer);
  }
}

/** Acquire one epoch at Eve's awaited `turn.started` boundary. */
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
  if (!enabled) return undefined;
  try {
    const { authority, principal } = exactForwardedSessionAuthority(
      input.sessionAuth,
    );
    if (
      !(await dependencies.isMember({
        principal,
        workspaceId: authority.workspaceId,
        environment,
      }))
    ) {
      throw new Error("Hosted sandbox execution membership is not active.");
    }
    const store = dependencies.store(environment);
    const result = await store.acquire({
      principal,
      adapterSessionId: input.sessionId,
      providerSandboxId: input.sandbox.id,
      policy: SANDBOX_EXECUTION_POLICY,
      nowEpochMs: input.nowEpochMs ?? Date.now(),
    });
    if (result.disposition === "rejected") {
      throw new Error(
        result.reason === "recovery-in-progress"
          ? "Hosted sandbox recovery is still in progress."
          : "Hosted sandbox execution concurrency is exhausted.",
      );
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
export async function assertHostedSandboxCommandAuthority(input: {
  sessionId: string;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!dependencies.enabled(environment)) return undefined;
  const active = commandAuthorities.get(input.sessionId);
  if (active === undefined) {
    throw new Error("Hosted sandbox command authority is unavailable.");
  }
  const nowEpochMs = input.nowEpochMs ?? Date.now();
  let lease = await active.store.assertCurrent({
    principal: active.lease.principal,
    adapterSessionId: active.lease.adapterSessionId,
    providerSandboxId: active.lease.providerSandboxId,
    epoch: active.lease.epoch,
    policyDigest: active.lease.policyDigest,
    nowEpochMs,
  });
  if (
    nowEpochMs - lease.heartbeatAtEpochMs >=
    SANDBOX_EXECUTION_POLICY.lease.heartbeatMs
  ) {
    lease = await active.store.heartbeat({
      principal: lease.principal,
      adapterSessionId: lease.adapterSessionId,
      epoch: lease.epoch,
      nowEpochMs,
    });
    commandAuthorities.set(input.sessionId, { ...active, lease });
  }
  return lease;
}

/** Stop compute and release without consulting process-local command state. */
export async function releaseHostedSandboxExecutionLease(input: {
  sessionId: string;
  sessionAuth: unknown;
  sandbox: RuntimeSandboxSession;
  reason: SandboxLeaseReleaseReason;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!dependencies.enabled(environment)) return { released: false } as const;
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
    principal,
    adapterSessionId: input.sessionId,
    providerSandboxId: input.sandbox.id,
    policyDigest: sandboxExecutionPolicyDigest(),
    reason: input.reason,
    nowEpochMs: input.nowEpochMs ?? Date.now(),
  });
  commandAuthorities.delete(input.sessionId);
  return released === null
    ? ({ released: false } as const)
    : ({ released: true, lease: released } as const);
}

export function setHostedSandboxExecutionLeaseDependenciesForTest(
  replacement: RuntimeDependencies,
) {
  dependencies = replacement;
}

export function clearHostedSandboxExecutionLeaseCacheForTest() {
  commandAuthorities.clear();
  database = undefined;
  dependencies = defaultDependencies;
}
