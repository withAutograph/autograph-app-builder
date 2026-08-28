import type { RuntimeSandboxSession } from "eve/sandbox";

import { parseHostedDatabaseUrl } from "../db/postgres-connection-policy";
import { createPostgresWorkspaceMembership } from "../eve/postgres-workspace-membership";
import { readHostedDeploymentEnvironment } from "../hosted/deployment-environment";
import { exactForwardedSessionAuthority } from "../hosted/session-authority";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import type {
  SandboxExecutionLease,
  SandboxLeaseReleaseReason,
} from "./execution-lease";
import { SANDBOX_EXECUTION_POLICY } from "./execution-policy";
import { createPostgresSandboxExecutionLeaseStore } from "./postgres-execution-lease-store";

type ActiveLease = {
  lease: SandboxExecutionLease;
  sandbox: RuntimeSandboxSession;
};

const activeLeases = new Map<string, ActiveLease>();
let database: ReturnType<typeof openHostedPostgresDatabase> | undefined;

function hostedLeaseEnabled(
  environment: Readonly<Record<string, string | undefined>>,
) {
  if (environment.EVE_HOSTED_ADAPTER !== "1") return false;
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

/**
 * Acquires the durable execution lease before the first authored command in a
 * hosted Eve session. Provider creation is independently resource-bound; a
 * rejected lease stops that fresh compute before the model can use it.
 */
export async function acquireHostedSandboxExecutionLease(input: {
  sessionId: string;
  sessionAuth: unknown;
  sandbox: RuntimeSandboxSession;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!hostedLeaseEnabled(environment)) return undefined;
  const { authority, principal } = exactForwardedSessionAuthority(
    input.sessionAuth,
  );
  const pool = hostedLeaseDatabase(environment);
  const membership = createPostgresWorkspaceMembership(pool);
  if (
    !(await membership.isMember({
      principal,
      workspaceId: authority.workspaceId,
    }))
  ) {
    await input.sandbox.stop();
    throw new Error("Hosted sandbox execution membership is not active.");
  }
  const result = await createPostgresSandboxExecutionLeaseStore(pool).acquire({
    principal,
    adapterSessionId: input.sessionId,
    providerSandboxId: input.sandbox.id,
    policy: SANDBOX_EXECUTION_POLICY,
    nowEpochMs: input.nowEpochMs ?? Date.now(),
  });
  if (result.disposition === "rejected") {
    await input.sandbox.stop();
    throw new Error("Hosted sandbox execution concurrency is exhausted.");
  }
  activeLeases.set(input.sessionId, {
    lease: result.lease,
    sandbox: input.sandbox,
  });
  return result.lease;
}

export async function releaseHostedSandboxExecutionLease(input: {
  sessionId: string;
  reason: SandboxLeaseReleaseReason;
  environment?: Readonly<Record<string, string | undefined>>;
  nowEpochMs?: number;
}) {
  const environment = input.environment ?? process.env;
  if (!hostedLeaseEnabled(environment)) return { released: false } as const;
  const active = activeLeases.get(input.sessionId);
  if (active === undefined) return { released: false } as const;
  // Stop first. A provider failure leaves the durable lease active so no other
  // work can consume its slot until bounded expiry/reconciliation.
  await active.sandbox.stop();
  const released = await createPostgresSandboxExecutionLeaseStore(
    hostedLeaseDatabase(environment),
  ).release({
    principal: active.lease.principal,
    adapterSessionId: active.lease.adapterSessionId,
    epoch: active.lease.epoch,
    reason: input.reason,
    nowEpochMs: input.nowEpochMs ?? Date.now(),
  });
  activeLeases.delete(input.sessionId);
  return { released: true, lease: released } as const;
}

export function clearHostedSandboxExecutionLeaseCacheForTest() {
  activeLeases.clear();
  database = undefined;
}
