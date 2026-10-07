/* oxlint-disable promise/avoid-new -- Deferred promises coordinate PostgreSQL lock holders and waiters deterministically. */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { z } from "zod";

import { builderProvisioningJournals } from "../../../../lib/db/schema";
import { operatorPlanDigest } from "../../../../lib/provisioning/hosted-operator-contract";
import { createPostgresHostedOperatorResourceLease } from "../../../../lib/provisioning/postgres-hosted-operator-resource-lease";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import type { HostedRuntimeTarget } from "../../../../lib/provisioning/hosted-runtime-journal";

const argument = (name: string) => {
  const index = process.argv.indexOf(name);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing ${name}.`);
  }
  return value;
};
const lockSessionSchema = z.strictObject({
  backend_start: z.union([z.date(), z.string().min(1)]),
  pid: z.number().int().positive(),
});
const booleanReadbackSchema = z.strictObject({ acquired: z.boolean() });
const currentReadbackSchema = z.strictObject({ current: z.boolean() });
const terminationReadbackSchema = z.strictObject({ terminated: z.boolean() });
const port = Number(argument("--port"));
if (!Number.isInteger(port) || port < 1 || port > 65_535) {
  throw new Error("Invalid PostgreSQL port.");
}
const clientA = postgres({
  database: "postgres",
  host: argument("--host"),
  max: 1,
  port,
  username: "postgres",
});
const lockClientAApplicationName = `protected_resource_lease_a_${randomUUID()}`;
const openLockClientA = (onConnectionClosed: () => void) =>
  postgres({
    connection: { application_name: lockClientAApplicationName },
    database: "postgres",
    host: argument("--host"),
    max: 1,
    onclose: onConnectionClosed,
    port,
    username: "postgres",
  });
const lockClientBApplicationName = `protected_resource_lease_b_${randomUUID()}`;
const openLockClientB = (onConnectionClosed: () => void) =>
  postgres({
    connection: { application_name: lockClientBApplicationName },
    database: "postgres",
    host: argument("--host"),
    max: 1,
    onclose: onConnectionClosed,
    port,
    username: "postgres",
  });
const openLockClientC = (onConnectionClosed: () => void) =>
  postgres({
    connection: { application_name: `protected_resource_lease_c_${randomUUID()}` },
    database: "postgres",
    host: argument("--host"),
    max: 1,
    onclose: onConnectionClosed,
    port,
    username: "postgres",
  });
const lockClientDApplicationName = `protected_resource_lease_d_${randomUUID()}`;
const openLockClientD = (onConnectionClosed: () => void) =>
  postgres({
    connection: { application_name: lockClientDApplicationName },
    database: "postgres",
    host: argument("--host"),
    max: 1,
    onclose: onConnectionClosed,
    port,
    username: "postgres",
  });
const lockClientEApplicationName = `protected_resource_lease_e_${randomUUID()}`;
let markLockClientEClosed: (() => void) | undefined;
const lockClientEClosed = new Promise<void>((resolve) => {
  markLockClientEClosed = resolve;
});
const openLockClientE = () =>
  postgres({
    connection: { application_name: lockClientEApplicationName },
    database: "postgres",
    host: argument("--host"),
    max: 1,
    onclose: () => markLockClientEClosed?.(),
    port,
    username: "postgres",
  });
const clientB = postgres({
  database: "postgres",
  host: argument("--host"),
  max: 2,
  port,
  username: "postgres",
});
const schema = { builderProvisioningJournals };
const databaseA = drizzle(clientA, { schema });
const databaseB = drizzle(clientB, { schema });
const storeA = createPostgresHostedRuntimeJournalStore(databaseA);
const storeB = createPostgresHostedRuntimeJournalStore(databaseB);
const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: `protected-access-${randomUUID()}`,
  workspaceId: `workspace-${randomUUID()}`,
};
const now = new Date();
const target = (sessionId: string): HostedRuntimeTarget => ({
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  installationId: "icfg_fixture",
  projectId: "prj_fixture",
  scopeId: "team_fixture",
  scopeType: "team",
  sessionId,
});
const plan = (
  selection: ReturnType<typeof target>,
  overrides: {
    appDatabaseName?: string;
    appResourceId?: string;
    authDatabaseName?: string;
    authResourceId?: string;
    connectionRef?: string;
  } = {},
) => ({
  access: [{ actorId: "actor_fixture", organizationId: "org_fixture", roles: ["reviewer"] }],
  action: "prepare" as const,
  appDatabase: {
    database: overrides.appDatabaseName ?? "spend",
    migratorRole: "spend_owner",
    resourceId: overrides.appResourceId ?? "app_resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: overrides.authDatabaseName ?? "auth",
    migratorRole: "auth_owner",
    resourceId: overrides.authResourceId ?? "auth_resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context_fixture",
  cost: {
    class: "shared-recovery-group" as const,
    description: "Approved disposable compute",
    owner: "fixture owner",
  },
  effects: [
    { description: "Prepare resources", id: "resources", kind: "resources" as const },
    { description: "Install release", id: "install", kind: "install" as const },
    { description: "Grant access", id: "access", kind: "access" as const },
    { description: "Bind runtime", id: "bindings", kind: "bindings" as const },
  ],
  installer: { reference: "fixture_installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch_fixture",
    connectionRef: overrides.connectionRef ?? "connection_fixture",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon_fixture",
    source: "synthetic-only" as const,
  },
  release: { artifactRef: "artifact_fixture", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: new Date(Date.now() + 86_400_000).toISOString(),
    policy: "fixture retention",
  },
  selection: {
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    projectId: selection.projectId,
    sessionId: selection.sessionId,
  },
  version: 1 as const,
});
const reserve = async (
  sessionId: string,
  overrides: {
    appDatabaseName?: string;
    appResourceId?: string;
    authDatabaseName?: string;
    authResourceId?: string;
    connectionRef?: string;
  } = {},
) => {
  const selected = target(sessionId);
  const selectedPlan = plan(selected, overrides);
  const operationRef = randomUUID();
  const record = await storeA.reserve({
    approvedByCallId: `approval-${sessionId}`,
    authority,
    now,
    operator: {
      mode: "protected-operator-v1",
      operationRef,
      plan: selectedPlan,
      planDigest: operatorPlanDigest(selectedPlan),
      receipts: [],
    },
    target: selected,
  });
  const leaseId = randomUUID();
  const claimed = await storeA.compareAndSet({
    authority,
    expectedRevision: record.revision,
    now,
    record: {
      ...record.record,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      leaseId,
    },
    target: selected,
  });
  assert.ok(claimed);
  return { leaseId, operationRef, row: claimed, target: selected };
};
const waitForAdvisoryLockWaiter = async () => {
  /* oxlint-disable eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Polls actual PostgreSQL lock-queue state with a bounded deadline. */
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const [row] = await clientB`
      select exists(
        select 1 from pg_locks where locktype = 'advisory' and not granted
      ) as waiting
    `;
    if (row?.waiting === true) {
      return;
    }
    await delay(10);
  }
  throw new Error("A competing resource operation did not wait for the advisory lock.");
};

try {
  await migrate(databaseA, { migrationsFolder: path.resolve("drizzle") });
  const first = await reserve("session-a");
  const reserveInput = {
    authority,
    expectedRevision: first.row.revision,
    leaseId: first.leaseId,
    now,
    operationRef: first.operationRef,
    target: first.target,
  };
  const concurrent = await Promise.all([
    storeA.reserveFenceGeneration(reserveInput),
    storeB.reserveFenceGeneration(reserveInput),
  ]);
  assert.equal(concurrent.filter(Boolean).length, 1, "CAS permits one generation write");
  const afterRestart = await storeB.read({ authority, target: first.target });
  const generation = afterRestart?.record.operator?.fenceGeneration;
  assert.ok(Number.isSafeInteger(generation) && generation > 0);
  assert.equal(afterRestart?.record.operator?.operationRef, first.operationRef);
  const repeated = await storeA.reserveFenceGeneration({
    ...reserveInput,
    expectedRevision: afterRestart?.revision ?? -1,
  });
  assert.equal(repeated, undefined, "an existing operation generation cannot be replaced");
  const finalRead = await storeA.read({ authority, target: first.target });
  assert.equal(finalRead?.record.operator?.fenceGeneration, generation);

  const second = await reserve("session-b", {
    appResourceId: "rotated_app_resource",
    authResourceId: "rotated_auth_resource",
    connectionRef: "rotated_connection_fixture",
  });
  const secondGeneration = await storeA.reserveFenceGeneration({
    authority,
    expectedRevision: second.row.revision,
    leaseId: second.leaseId,
    now,
    operationRef: second.operationRef,
    target: second.target,
  });
  assert.ok(secondGeneration);
  assert.ok(secondGeneration.record.operator);
  const secondFenceGeneration = secondGeneration.record.operator.fenceGeneration;
  assert.ok(
    secondFenceGeneration !== undefined && secondFenceGeneration > generation,
    "shared targets get globally increasing operation generations across sessions",
  );
  const independent = await reserve("session-independent", {
    appDatabaseName: "spend_independent",
    appResourceId: "app_resource_independent",
    authDatabaseName: "auth_independent",
    authResourceId: "auth_resource_independent",
  });
  const independentGeneration = await storeA.reserveFenceGeneration({
    authority,
    expectedRevision: independent.row.revision,
    leaseId: independent.leaseId,
    now,
    operationRef: independent.operationRef,
    target: independent.target,
  });
  assert.ok(independentGeneration);

  const resourceLeaseA = createPostgresHostedOperatorResourceLease({
    openLockClient: openLockClientA,
    store: storeA,
  });
  const resourceLeaseB = createPostgresHostedOperatorResourceLease({
    openLockClient: openLockClientB,
    store: storeA,
  });
  const resourceLeaseC = createPostgresHostedOperatorResourceLease({
    openLockClient: openLockClientC,
    store: storeA,
  });
  const resourceLeaseD = createPostgresHostedOperatorResourceLease({
    openLockClient: openLockClientD,
    store: storeA,
  });
  const resourceLeaseE = createPostgresHostedOperatorResourceLease({
    openLockClient: openLockClientE,
    store: storeA,
  });
  const firstJournal = await storeA.read({ authority, target: first.target });
  const firstPlan = firstJournal?.record.operator?.plan;
  assert.ok(firstPlan);
  assert.equal(firstJournal?.record.leaseId, first.leaseId);
  assert.ok(Date.parse(firstJournal?.record.leaseExpiresAt ?? "") > Date.now());
  assert.equal(firstJournal?.record.operator?.operationRef, first.operationRef);
  assert.ok((firstJournal?.record.operator?.fenceGeneration ?? 0) > 0);
  assert.equal(firstJournal?.record.operator?.planDigest, operatorPlanDigest(firstPlan));
  const authLockKey = JSON.stringify([
    "hosted_protected_operator_database_v1",
    firstPlan.neon.projectId,
    firstPlan.neon.branchId,
    firstPlan.authDatabase.database,
  ]);
  let releaseFirst: (() => void) | undefined;
  let markHeld: (() => void) | undefined;
  const firstHeld = new Promise<void>((resolve) => {
    markHeld = resolve;
  });
  const firstRelease = new Promise<void>((resolve) => {
    releaseFirst = resolve;
  });
  let secondEntered = false;
  let releaseSecond: (() => void) | undefined;
  let markSecondEntered: (() => void) | undefined;
  const secondEnteredPromise = new Promise<void>((resolve) => {
    markSecondEntered = resolve;
  });
  const secondRelease = new Promise<void>((resolve) => {
    releaseSecond = resolve;
  });
  const secondPlan = secondGeneration?.record.operator?.plan;
  assert.notEqual(secondPlan, undefined);
  let independentEntered = false;
  const independentPlan = independentGeneration.record.operator?.plan;
  assert.notEqual(independentPlan, undefined);
  const holdingLease = resourceLeaseA(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async (assertFence) => {
      await assertFence();
      markHeld?.();
      await firstRelease;
      await assertFence();
    },
  );
  await firstHeld;
  const waitingLease = resourceLeaseB(
    { authority, operationRef: second.operationRef, plan: secondPlan, target: second.target },
    async (assertFence) => {
      await assertFence();
      secondEntered = true;
      markSecondEntered?.();
      await secondRelease;
    },
  );
  const independentLease = resourceLeaseC(
    {
      authority,
      operationRef: independent.operationRef,
      plan: independentPlan,
      target: independent.target,
    },
    async (assertFence) => {
      await assertFence();
      independentEntered = true;
    },
  );
  await waitForAdvisoryLockWaiter();
  assert.equal(
    secondEntered,
    false,
    "a different journal operation waits for the shared physical databases",
  );
  await independentLease;
  assert.equal(
    independentEntered,
    true,
    "disjoint Auth and app databases can proceed concurrently",
  );
  const [rawLockProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  const lockProbe = booleanReadbackSchema.parse(rawLockProbe);
  assert.equal(
    lockProbe.acquired,
    false,
    "another session cannot acquire a shared Auth resource lock",
  );
  releaseFirst?.();
  await holdingLease;
  await secondEnteredPromise;
  releaseSecond?.();
  await waitingLease;
  const [rawReleasedProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  const releasedProbe = booleanReadbackSchema.parse(rawReleasedProbe);
  assert.equal(releasedProbe.acquired, true, "resource locks release after the operation callback");
  await clientB`select pg_advisory_unlock(hashtextextended(${authLockKey}, 0))`;

  let markCallbackErrorEntered: (() => void) | undefined;
  let resumeCallbackError: (() => void) | undefined;
  const callbackErrorEntered = new Promise<void>((resolve) => {
    markCallbackErrorEntered = resolve;
  });
  const callbackErrorContinue = new Promise<void>((resolve) => {
    resumeCallbackError = resolve;
  });
  const callbackErrorOperation = resourceLeaseE(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async () => {
      markCallbackErrorEntered?.();
      await callbackErrorContinue;
      throw new Error("fixture callback failed after connection loss");
    },
  );
  const callbackErrorRejected = assert.rejects(
    callbackErrorOperation,
    /fixture callback failed after connection loss/u,
  );
  await callbackErrorEntered;
  const [rawCallbackErrorSession] = await clientB`
    select activity.pid
    from pg_stat_activity as activity
    join pg_locks as locks using (pid)
    where activity.application_name = ${lockClientEApplicationName}
      and locks.locktype = 'advisory'
      and locks.granted
    limit 1
  `;
  const callbackErrorSession = z
    .strictObject({ pid: z.number().int().positive() })
    .parse(rawCallbackErrorSession);
  const [rawCallbackErrorTermination] = await clientB`
    select pg_terminate_backend(${callbackErrorSession.pid}) as terminated
  `;
  assert.equal(terminationReadbackSchema.parse(rawCallbackErrorTermination).terminated, true);
  await lockClientEClosed;
  let markCallbackErrorReplacement: (() => void) | undefined;
  const callbackErrorReplacementEntered = new Promise<void>((resolve) => {
    markCallbackErrorReplacement = resolve;
  });
  let releaseCallbackErrorReplacement: (() => void) | undefined;
  const callbackErrorReplacementRelease = new Promise<void>((resolve) => {
    releaseCallbackErrorReplacement = resolve;
  });
  const callbackErrorReplacement = resourceLeaseD(
    { authority, operationRef: second.operationRef, plan: secondPlan, target: second.target },
    async () => {
      markCallbackErrorReplacement?.();
      await callbackErrorReplacementRelease;
    },
  );
  await callbackErrorReplacementEntered;
  resumeCallbackError?.();
  await callbackErrorRejected;
  const [rawCallbackErrorLockProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  assert.equal(
    booleanReadbackSchema.parse(rawCallbackErrorLockProbe).acquired,
    false,
    "a callback error after connection loss cannot unlock the replacement lease",
  );
  releaseCallbackErrorReplacement?.();
  await callbackErrorReplacement;

  const stale = await reserve("session-stale");
  const staleGeneration = await storeA.reserveFenceGeneration({
    authority,
    expectedRevision: stale.row.revision,
    leaseId: stale.leaseId,
    now,
    operationRef: stale.operationRef,
    target: stale.target,
  });
  assert.ok(staleGeneration);
  const stalePlan = staleGeneration.record.operator?.plan;
  assert.ok(stalePlan);
  let releaseBlocker: (() => void) | undefined;
  let markBlockerHeld: (() => void) | undefined;
  const blockerHeld = new Promise<void>((resolve) => {
    markBlockerHeld = resolve;
  });
  const blockerRelease = new Promise<void>((resolve) => {
    releaseBlocker = resolve;
  });
  const blocker = resourceLeaseA(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async () => {
      markBlockerHeld?.();
      await blockerRelease;
    },
  );
  await blockerHeld;
  let staleCallbackRan = false;
  const staleWaiter = resourceLeaseB(
    { authority, operationRef: stale.operationRef, plan: stalePlan, target: stale.target },
    // oxlint-disable-next-line eslint/require-await -- The test callback must be async to match the production lease callback contract.
    async () => {
      staleCallbackRan = true;
      throw new Error("Stale callback unexpectedly ran.");
    },
  );
  await waitForAdvisoryLockWaiter();
  const changed = await storeA.compareAndSet({
    authority,
    expectedRevision: staleGeneration.revision,
    now: new Date(),
    record: { ...staleGeneration.record, leaseId: randomUUID() },
    target: stale.target,
  });
  assert.ok(changed);
  releaseBlocker?.();
  await blocker;
  await assert.rejects(staleWaiter, /authority|fence/u);
  assert.equal(staleCallbackRan, false, "revoked authority is rechecked after waiting for a lock");

  await assert.rejects(
    resourceLeaseA(
      { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
      // oxlint-disable-next-line eslint/require-await -- Throwing callback exercises cleanup on rejected effect execution.
      async () => {
        throw new Error("fixture callback failure");
      },
    ),
    /fixture callback failure/u,
  );
  const [rawThrowReleaseProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  const throwReleaseProbe = booleanReadbackSchema.parse(rawThrowReleaseProbe);
  assert.equal(
    throwReleaseProbe.acquired,
    true,
    "locks release when the operation callback throws",
  );
  await clientB`select pg_advisory_unlock(hashtextextended(${authLockKey}, 0))`;

  let releaseLostSession: (() => void) | undefined;
  let markLostSessionCallback: (() => void) | undefined;
  const lostSessionCallback = new Promise<void>((resolve) => {
    markLostSessionCallback = resolve;
  });
  const lostSessionContinue = new Promise<void>((resolve) => {
    releaseLostSession = resolve;
  });
  let effectContinued = false;
  const lostSessionOperation = resourceLeaseA(
    { authority, operationRef: second.operationRef, plan: secondPlan, target: second.target },
    async (assertFence) => {
      markLostSessionCallback?.();
      await lostSessionContinue;
      await assertFence();
      effectContinued = true;
    },
  );
  await lostSessionCallback;
  const [rawLockSession] = await clientB`
    select activity.pid, activity.backend_start
    from pg_locks as locks
    join pg_stat_activity as activity using (pid)
    where activity.application_name = ${lockClientAApplicationName}
      and locks.locktype = 'advisory'
      and locks.granted
    limit 1
  `;
  const lockSession = lockSessionSchema.parse(rawLockSession);
  const [rawStillOurLockSession] = await clientB`
    select exists(
      select 1
      from pg_stat_activity as activity
      join pg_locks as locks using (pid)
      where activity.pid = ${lockSession.pid}
        and activity.backend_start = ${lockSession.backend_start}
        and activity.application_name = ${lockClientAApplicationName}
        and locks.locktype = 'advisory'
        and locks.granted
    ) as current
  `;
  const stillOurLockSession = currentReadbackSchema.parse(rawStillOurLockSession);
  assert.equal(stillOurLockSession.current, true);
  const [rawTerminated] = await clientB`
    select pg_terminate_backend(${lockSession.pid}) as terminated
  `;
  const terminated = terminationReadbackSchema.parse(rawTerminated);
  assert.equal(terminated.terminated, true);
  releaseLostSession?.();
  await assert.rejects(lostSessionOperation);
  assert.equal(effectContinued, false, "a lost lock session cannot continue an effect");

  let markLostDCallback: (() => void) | undefined;
  let resumeLostDCallback: (() => void) | undefined;
  const lostDCallbackEntered = new Promise<void>((resolve) => {
    markLostDCallback = resolve;
  });
  const lostDCallbackContinue = new Promise<void>((resolve) => {
    resumeLostDCallback = resolve;
  });
  const lostDOperation = resourceLeaseD(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async (assertFence) => {
      markLostDCallback?.();
      await lostDCallbackContinue;
      await assertFence();
    },
  );
  await lostDCallbackEntered;
  const [rawLostDSession] = await clientB`
    select activity.pid, activity.backend_start
    from pg_stat_activity as activity
    join pg_locks as locks using (pid)
    where activity.application_name = ${lockClientDApplicationName}
      and locks.locktype = 'advisory'
      and locks.granted
    limit 1
  `;
  const lostDSession = lockSessionSchema.parse(rawLostDSession);
  const [rawLostDTermination] = await clientB`
    select pg_terminate_backend(${lostDSession.pid}) as terminated
  `;
  assert.equal(terminationReadbackSchema.parse(rawLostDTermination).terminated, true);

  let markReplacementEntered: (() => void) | undefined;
  const replacementEntered = new Promise<void>((resolve) => {
    markReplacementEntered = resolve;
  });
  let releaseReplacement: (() => void) | undefined;
  const replacementRelease = new Promise<void>((resolve) => {
    releaseReplacement = resolve;
  });
  let replacementEffectCompleted = false;
  const replacementLease = resourceLeaseD(
    { authority, operationRef: second.operationRef, plan: secondPlan, target: second.target },
    async (assertFence) => {
      await assertFence();
      markReplacementEntered?.();
      await replacementRelease;
      replacementEffectCompleted = true;
    },
  );
  await replacementEntered;
  resumeLostDCallback?.();
  await assert.rejects(lostDOperation);
  const [rawReplacementLockProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  assert.equal(
    booleanReadbackSchema.parse(rawReplacementLockProbe).acquired,
    false,
    "a lost held-lock check cannot release the replacement operation's session",
  );
  releaseReplacement?.();
  await replacementLease;
  assert.equal(replacementEffectCompleted, true);
  const [rawReplacementReleasedProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  assert.equal(
    booleanReadbackSchema.parse(rawReplacementReleasedProbe).acquired,
    true,
    "replacement lease releases its lock after stale cleanup finishes",
  );
  await clientB`select pg_advisory_unlock(hashtextextended(${authLockKey}, 0))`;

  let markAcquireBlocker: (() => void) | undefined;
  let releaseAcquireBlocker: (() => void) | undefined;
  const acquireBlockerEntered = new Promise<void>((resolve) => {
    markAcquireBlocker = resolve;
  });
  const acquireBlockerRelease = new Promise<void>((resolve) => {
    releaseAcquireBlocker = resolve;
  });
  const acquisitionBlocker = resourceLeaseC(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async () => {
      markAcquireBlocker?.();
      await acquireBlockerRelease;
    },
  );
  await acquireBlockerEntered;
  const acquisitionWaiter = resourceLeaseB(
    { authority, operationRef: second.operationRef, plan: secondPlan, target: second.target },
    // oxlint-disable-next-line eslint/require-await -- A killed acquisition must not reach the effect callback.
    async () => {
      throw new Error("Terminated acquisition unexpectedly entered the callback.");
    },
  );
  const acquisitionWaiterRejected = assert.rejects(acquisitionWaiter);
  await waitForAdvisoryLockWaiter();
  const [rawAcquisitionSession] = await clientB`
    select activity.pid, activity.backend_start
    from pg_stat_activity as activity
    join pg_locks as locks using (pid)
    where activity.application_name = ${lockClientBApplicationName}
      and locks.locktype = 'advisory'
      and not locks.granted
    limit 1
  `;
  const acquisitionSession = lockSessionSchema.parse(rawAcquisitionSession);
  const [rawAcquisitionTermination] = await clientB`
    select pg_terminate_backend(${acquisitionSession.pid}) as terminated
  `;
  assert.equal(terminationReadbackSchema.parse(rawAcquisitionTermination).terminated, true);

  let markAcquisitionReplacement: (() => void) | undefined;
  const acquisitionReplacementEntered = new Promise<void>((resolve) => {
    markAcquisitionReplacement = resolve;
  });
  let releaseAcquisitionReplacement: (() => void) | undefined;
  const acquisitionReplacementRelease = new Promise<void>((resolve) => {
    releaseAcquisitionReplacement = resolve;
  });
  const acquisitionReplacement = resourceLeaseB(
    { authority, operationRef: first.operationRef, plan: firstPlan, target: first.target },
    async (assertFence) => {
      await assertFence();
      markAcquisitionReplacement?.();
      await acquisitionReplacementRelease;
    },
  );
  await waitForAdvisoryLockWaiter();
  releaseAcquireBlocker?.();
  await acquisitionBlocker;
  await acquisitionWaiterRejected;
  await acquisitionReplacementEntered;
  const [rawAcquisitionReplacementProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  assert.equal(
    booleanReadbackSchema.parse(rawAcquisitionReplacementProbe).acquired,
    false,
    "failed acquisition cleanup cannot unlock a later lease on the reused pool",
  );
  releaseAcquisitionReplacement?.();
  await acquisitionReplacement;
  const [rawAcquisitionReleasedProbe] = await clientB`
    select pg_try_advisory_lock(hashtextextended(${authLockKey}, 0)) as acquired
  `;
  assert.equal(booleanReadbackSchema.parse(rawAcquisitionReleasedProbe).acquired, true);
  await clientB`select pg_advisory_unlock(hashtextextended(${authLockKey}, 0))`;
  console.log(
    "Protected access resource locking, ordering, independent overlap, stale authority, and lost-session fencing passed.",
  );
} finally {
  await Promise.all([clientA.end(), clientB.end()]);
}
