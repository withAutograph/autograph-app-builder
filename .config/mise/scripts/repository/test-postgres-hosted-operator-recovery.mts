/* oxlint-disable eslint/no-await-in-loop, eslint/no-hardcoded-passwords, promise/avoid-new -- Owns the disposable cluster and runs isolated operator child processes. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// Drizzle's schema namespace is required as a whole for migration-bound database access.
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle schema registration requires the exported schema collection.
import * as schema from "../../../../lib/db/schema";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../../../../lib/provisioning/hosted-operator-contract";
import type {
  HostedOperatorPlan,
  OperatorSelection,
} from "../../../../lib/provisioning/hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "../../../../lib/provisioning/hosted-runtime-journal";
import type { BuilderProvisionAuthority } from "../../../../lib/provisioning/journal";
import type { HostedRuntimeTarget } from "../../../../lib/provisioning/hosted-runtime-journal";
import { z } from "zod";
import { proveJournalProcessRecovery } from "./hosted-operator-recovery-processes.mts";

const root = path.resolve(import.meta.dirname, "../../../..");
const fixtureDatabaseName = "builder_cp";
const fixtureCiphertext = "fixture-ciphertext";
const childResultPrefix = "A515_RESULT ";
const workerCheckpointAfterPrefix = "worker-checkpoint-after:";
const removeBindingsEffectId = "remove-bindings";
// oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates a unique fixture-owned cluster directory removed in finally.
const scratch = await mkdtemp(path.join(tmpdir(), "a515-operator-recovery-"));
const pgdata = path.join(scratch, "pgdata");
const password = randomBytes(24).toString("hex");
const passwordFile = path.join(scratch, "password");
const postgresFlag = process.argv.indexOf("--postgres-bin");
const postgresBin = postgresFlag === -1 ? undefined : process.argv[postgresFlag + 1];
const databaseFlag = process.argv.indexOf("--database-url");
const adminDatabaseUrl = databaseFlag === -1 ? undefined : process.argv[databaseFlag + 1];
if (databaseFlag !== -1 && adminDatabaseUrl === undefined) {
  throw new Error("--database-url requires an explicit local PostgreSQL admin URL");
}
if (adminDatabaseUrl !== undefined) {
  const adminUrl = new URL(adminDatabaseUrl);
  if (
    !/^postgres(?:ql)?:$/u.test(adminUrl.protocol) ||
    !["localhost", "127.0.0.1", "::1", "[::1]"].includes(adminUrl.hostname)
  ) {
    throw new Error("--database-url must target loopback PostgreSQL");
  }
}
if (postgresBin !== undefined && !path.isAbsolute(postgresBin)) {
  throw new Error("--postgres-bin must be absolute");
}
const port =
  adminDatabaseUrl === undefined
    ? await new Promise<number>((resolve, reject) => {
        const server = createServer();
        server.once("error", (error: Error) => {
          reject(error);
        });
        server.listen(0, "127.0.0.1", () => {
          const address = z.object({ port: z.number().int().min(1) }).parse(server.address());
          server.close((error) => {
            if (error === null || error === undefined) {
              resolve(address.port);
            } else {
              reject(new Error(error.message));
            }
          });
        });
      })
    : 0;
const run = (bin: string, args: string[]): void => {
  const result = spawnSync(path.join(postgresBin ?? "", bin), args, {
    encoding: "utf-8",
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(`Owned PostgreSQL ${bin} failed: ${result.stderr.slice(-500)}`);
  }
};
let dsn = "";
let ownedDatabase = fixtureDatabaseName;
let ownedRole = fixtureDatabaseName;
let externalAdmin: ReturnType<typeof postgres> | undefined;
interface WorkerInput {
  action: "plan" | "execute";
  authority: BuilderProvisionAuthority;
  failure?: string;
  operation?: "prepare" | "cleanup";
  operationRef?: string;
  plan: HostedOperatorPlan;
  planDigest?: string;
  selection: OperatorSelection;
  target: HostedRuntimeTarget;
}
const expectedCrashCode = (failure: string): number | undefined => {
  switch (failure) {
    case "lease-claim-after": {
      return 89;
    }
    case "fence-after": {
      return 90;
    }
    case "release-after": {
      return 91;
    }
    case "proof-after": {
      return 88;
    }
    case "verify-after": {
      return 87;
    }
    default: {
      if (failure.startsWith("pending-after:")) {
        return 92;
      }
      if (failure.startsWith("effect-crash:")) {
        return 86;
      }
      if (failure.startsWith("context-after:")) {
        return 93;
      }
      if (failure.startsWith(workerCheckpointAfterPrefix)) {
        return 94;
      }
      return undefined;
    }
  }
};
const workerPath = path.join(
  import.meta.dirname,
  "test-postgres-hosted-operator-recovery-worker.mts",
);
const worker = (config: WorkerInput) =>
  spawnSync(process.execPath, ["--import", "tsx", workerPath], {
    encoding: "utf-8",
    env: {
      A515_FIXTURE_CONFIG: JSON.stringify({ dsn, ...config }),
      LANG: "C",
      LC_ALL: "C",
      PATH: process.env.PATH ?? "",
    },
    maxBuffer: 1024 * 1024,
    timeout: 30_000,
  });
const childResultSchema = z
  .object({
    code: z.string().optional(),
    operationRef: z.uuid().optional(),
    planDigest: z.string().optional(),
    status: z.string(),
  })
  .loose();
const resourceIdentitySchema = z.strictObject({
  appResourceId: z.string(),
  authResourceId: z.string(),
  branchId: z.string(),
  endpoint: z.string(),
  projectId: z.string(),
});
interface SyntheticEffectRow {
  attempts: number;
  effect_id: string;
  receipt?: unknown;
  resource_identity: z.infer<typeof resourceIdentitySchema>;
}
const providerAppliedPrefixes = [
  "effect-after:",
  "effect-crash:",
  "worker-checkpoint-before:",
  workerCheckpointAfterPrefix,
  "receipt-before:",
  "receipt-after:",
];
const providerEffectWasApplied = (failure: string): boolean =>
  providerAppliedPrefixes.some((prefix) => failure.startsWith(prefix));
const assertInterruptedProviderState = (
  failure: string,
  effectId: string,
  frozenPlan: HostedOperatorPlan,
  providerRows: SyntheticEffectRow[],
) => {
  const providerEffect = providerRows.find((row) => row.effect_id === effectId);
  if (failure.startsWith("effect-before:")) {
    assert.equal(providerEffect, undefined);
  }
  if (providerEffectWasApplied(failure)) {
    assert.equal(providerEffect?.attempts, 1);
    assert.deepEqual(providerEffect?.resource_identity, {
      appResourceId: frozenPlan.appDatabase.resourceId,
      authResourceId: frozenPlan.authDatabase.resourceId,
      branchId: frozenPlan.neon.branchId,
      endpoint: frozenPlan.neon.endpoint,
      projectId: frozenPlan.neon.projectId,
    });
  }
};
const plannedResultSchema = childResultSchema.extend({
  operationRef: z.uuid(),
  planDigest: z.string().min(1),
  status: z.literal("planned"),
});
const resultOf = (output: string) => {
  const line = output.split("\n").find((item) => item.startsWith(childResultPrefix));
  if (line === undefined) {
    throw new Error(`Operator child omitted result: ${output.slice(-1000)}`);
  }
  return childResultSchema.parse(JSON.parse(line.slice(childResultPrefix.length)));
};
const plannedOf = (output: string) => plannedResultSchema.parse(resultOf(output));
const authority: BuilderProvisionAuthority = {
  audience: "https://builder.fixture.test/mcp",
  issuer: "https://builder.fixture.test/api/auth",
  ownerUserId: randomUUID(),
  workspaceId: randomUUID(),
};
const selectionFor = (): OperatorSelection => ({
  appId: "recovery-fixture",
  branch: "preview",
  environment: "preview",
  projectId: "prj_recovery_fixture",
  sessionId: randomUUID(),
});
const targetFor = (selection: OperatorSelection): HostedRuntimeTarget => ({
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
});
const makePlan = (
  selection: OperatorSelection,
  overrides: {
    releaseId?: string;
    releaseSha?: string;
    neonProjectId?: string;
    action?: "prepare" | "cleanup";
  } = {},
): HostedOperatorPlan =>
  hostedOperatorPlanSchema.parse({
    access: [{ actorId: "synthetic-actor", organizationId: "synthetic-org", roles: ["reviewer"] }],
    action: overrides.action ?? "prepare",
    appDatabase: {
      database: "fixture_app",
      migratorRole: "app_owner",
      resourceId: "app-fixture",
      runtimeRole: "app_runtime",
    },
    authDatabase: {
      database: "fixture_auth",
      migratorRole: "auth_owner",
      resourceId: "auth-fixture",
      runtimeRole: "auth_runtime",
    },
    contextId: "a515-local-recovery",
    cost: {
      class: "shared-recovery-group",
      description: "Disposable local acceptance",
      owner: "Fixture",
    },
    deploymentBoundary: {
      app: {
        branch: selection.branch,
        deploymentId: "dpl_app_fixture",
        environment: "preview",
        projectId: selection.projectId,
      },
      authority,
      gateway: {
        branch: selection.branch,
        deploymentId: "dpl_gateway_fixture",
        environment: "preview",
        projectId: "prj_gateway_fixture",
      },
      operator: {
        deploymentId: "dpl_operator_fixture",
        environment: "production",
        projectId: "prj_operator_fixture",
      },
      teamId: "team_fixture",
      verification: {
        gatewayOrigin: "https://gateway.fixture.test",
        jwksUrl: "https://gateway.fixture.test/_platform/jwks.json",
        publicOrigin: "https://app.fixture.test",
      },
    },
    effects:
      overrides.action === "cleanup"
        ? [
            { description: "Revoke synthetic actor", id: "revoke", kind: "revoke" },
            {
              description: "Remove synthetic bindings",
              id: removeBindingsEffectId,
              kind: removeBindingsEffectId,
            },
            { description: "Retire synthetic resources", id: "retire", kind: "retire" },
          ]
        : [
            { description: "Synthetic resource discovery", id: "resources", kind: "resources" },
            { description: "Synthetic release install", id: "install", kind: "install" },
            { description: "Synthetic actor grant", id: "access", kind: "access" },
            { description: "Synthetic credential binding", id: "bind", kind: "bindings" },
          ],
    installer: { reference: "fixture-installer-v1", sha256: "a".repeat(64) },
    neon: {
      branchId: "br_fixture",
      connectionRef: "synthetic-only",
      endpoint: "fixture.neon.tech",
      projectId: overrides.neonProjectId ?? "neon_fixture",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: selection.branch,
      origin: "https://app.fixture.test",
      projectId: "prj_gateway_fixture",
    },
    release: {
      artifactRef: "synthetic-release",
      id: overrides.releaseId ?? "release_fixture",
      sha256: overrides.releaseSha ?? "b".repeat(64),
    },
    retention: { expiresAt: new Date(Date.now() + 86_400_000).toISOString(), policy: "Fixture" },
    selection,
    version: 1,
  });
let started = false;
let sql: ReturnType<typeof postgres> | undefined;
const injectedCases: string[] = [];
try {
  if (adminDatabaseUrl === undefined) {
    await writeFile(passwordFile, password, { mode: 0o600 });
    run("initdb", [
      "-D",
      pgdata,
      "--username=fixture_admin",
      "--auth=scram-sha-256",
      `--pwfile=${passwordFile}`,
      "--no-locale",
    ]);
    run("pg_ctl", [
      "-D",
      pgdata,
      "-l",
      path.join(scratch, "postgres.log"),
      "-o",
      `-h 127.0.0.1 -p ${port} -k ${scratch}`,
      "-w",
      "start",
    ]);
    started = true;
    sql = postgres(
      `postgres://fixture_admin:${password}@127.0.0.1:${port}/postgres?sslmode=disable`,
    );
    await sql.unsafe(`create role ${fixtureDatabaseName} login password '${password}'`);
    await sql.unsafe(`create database ${fixtureDatabaseName} owner ${fixtureDatabaseName}`);
    await sql.end();
    dsn = `postgres://${fixtureDatabaseName}:${password}@127.0.0.1:${port}/${fixtureDatabaseName}?sslmode=disable`;
  } else {
    const suffix = randomUUID().replaceAll("-", "").slice(0, 16);
    ownedDatabase = `builder_cp_a515_${suffix}`;
    ownedRole = `builder_cp_a515_${suffix}`;
    externalAdmin = postgres(adminDatabaseUrl, { max: 1 });
    await externalAdmin.unsafe(`create role ${ownedRole} login password '${password}'`);
    await externalAdmin.unsafe(`create database ${ownedDatabase} owner ${ownedRole}`);
    const ownedUrl = new URL(adminDatabaseUrl);
    ownedUrl.username = ownedRole;
    ownedUrl.password = password;
    ownedUrl.pathname = `/${ownedDatabase}`;
    dsn = ownedUrl.toString();
  }
  sql = postgres(dsn, { max: 6 });
  const database = drizzle(sql, { schema });
  await migrate(database, { migrationsFolder: path.join(root, "drizzle") });
  await sql.unsafe(
    "create table a515_synthetic_effects (operation_ref text not null, effect_id text not null, resource_identity jsonb not null, receipt jsonb not null, attempts integer not null, primary key(operation_ref,effect_id))",
  );
  const fixtureSql = sql;
  const store = createPostgresHostedRuntimeJournalStore(database);
  type JournalRead = NonNullable<Awaited<ReturnType<typeof store.read>>>;

  const prepareForCleanup = (selection: OperatorSelection, target: HostedRuntimeTarget): void => {
    const preparePlan = makePlan(selection);
    const preparePlanChild = worker({
      authority,
      selection,
      target,
      plan: preparePlan,
      action: "plan",
    });
    const preparePlanned = plannedOf(preparePlanChild.stdout);
    const prepareExecution = worker({
      authority,
      selection,
      target,
      plan: preparePlan,
      action: "execute",
      operationRef: preparePlanned.operationRef,
      planDigest: preparePlanned.planDigest,
    });
    assert.equal(
      resultOf(prepareExecution.stdout).status,
      "prepared",
      "cleanup scenario must start from a completed prepared grant",
    );
  };

  // oxlint-disable-next-line eslint/complexity -- Assert every independently durable journal boundary from the single interrupted row.
  const assertInterruptedJournal = (
    failure: string,
    journalRow: JournalRead,
    frozenPlan: HostedOperatorPlan,
    effectId: string,
  ) => {
    const beforeState = journalRow.record.privateState;
    if (failure === "checkpoint-before:resources") {
      assert.equal(beforeState, undefined);
    }
    if (failure.startsWith("checkpoint-before:") && failure !== "checkpoint-before:resources") {
      assert.equal(beforeState?.encryptedToken, fixtureCiphertext);
    }
    if (failure.startsWith("checkpoint-after:")) {
      assert.equal(beforeState?.encryptedToken, fixtureCiphertext);
    }
    if (failure.startsWith("context-before:")) {
      assert.equal(journalRow.record.operator?.pendingEffectAttempt?.contextDigest, undefined);
    }
    if (failure.startsWith("context-after:")) {
      assert.equal(journalRow.record.operator?.pendingEffectAttempt?.contextDigest, "f".repeat(64));
    }
    if (failure.startsWith("worker-checkpoint-before:")) {
      assert.equal(
        (journalRow.record.operator?.workerCheckpoints ?? []).some(
          (checkpoint) => checkpoint.parentEffectId === effectId,
        ),
        false,
      );
    }
    if (failure.startsWith(workerCheckpointAfterPrefix)) {
      const frame = journalRow.record.operator?.workerCheckpoints?.find(
        (checkpoint) => checkpoint.parentEffectId === effectId,
      );
      assert.ok(frame, `${failure}: durable worker frame must survive child death`);
      assert.equal(frame.attemptId, journalRow.record.operator?.pendingEffectAttempt?.id);
      assert.equal(frame.fenceGeneration, journalRow.record.operator?.fenceGeneration);
      assert.equal(frame.operationRef, journalRow.record.operator?.operationRef);
      assert.equal(frame.resourceId, frozenPlan.appDatabase.resourceId);
      assert.equal(frame.tenantId, "synthetic-org");
    }
    if (journalRow.record.status === "prepared") {
      assert.ok(journalRow.record.proof, `${failure}: final proof must survive response loss`);
    }
  };

  const readSyntheticEffects = (operationRef: string) =>
    fixtureSql<SyntheticEffectRow[]>`
      select effect_id,resource_identity,receipt,attempts
      from a515_synthetic_effects where operation_ref=${operationRef} order by effect_id
    `;

  const assertFinalScenario = async (
    failure: string,
    action: "prepare" | "cleanup",
    target: HostedRuntimeTarget,
    operationRef: string,
    frozenPlan: HostedOperatorPlan,
    planDigest: string,
  ) => {
    const expectedIds =
      action === "prepare"
        ? ["access", "bind", "install", "resources"]
        : [removeBindingsEffectId, "retire", "revoke"];
    const finalEffects = await fixtureSql<
      {
        effect_id: string;
        attempts: number;
        resource_identity: z.infer<typeof resourceIdentitySchema>;
      }[]
    >`select effect_id,attempts,resource_identity from a515_synthetic_effects where operation_ref=${operationRef} order by effect_id`;
    assert.deepEqual(
      finalEffects.map((row) => row.effect_id),
      expectedIds,
    );
    assert.ok(
      finalEffects.every((row) => row.attempts === 1),
      "reconciliation must avoid replaying known effects",
    );
    assert.ok(
      finalEffects.every(
        (row) =>
          row.resource_identity.projectId === frozenPlan.neon.projectId &&
          row.resource_identity.branchId === frozenPlan.neon.branchId &&
          row.resource_identity.endpoint === frozenPlan.neon.endpoint,
      ),
    );
    const finalRead = await store.read({ authority, target });
    assert.ok(finalRead, `${failure}: final journal record must remain readable`);
    assert.equal(finalRead.record.status, action === "prepare" ? "prepared" : "cleaned");
    assert.equal(
      finalRead.record.leaseId,
      undefined,
      `${failure}: recovered outcome must release its lease`,
    );
    assert.equal(
      finalRead.record.leaseExpiresAt,
      undefined,
      `${failure}: recovered outcome must clear lease expiry`,
    );
    assert.deepEqual(
      finalRead.record.operator?.plan,
      frozenPlan,
      `${failure}: exact frozen plan must survive recovery`,
    );
    assert.equal(
      finalRead.record.operator?.planDigest,
      planDigest,
      `${failure}: exact frozen digest must survive recovery`,
    );
    return finalRead;
  };

  const runScenario = async (
    failure: string,
    expectedExit?: number,
    action: "prepare" | "cleanup" = "prepare",
  ) => {
    const selection = selectionFor();
    const target = targetFor(selection);
    const plan = makePlan(selection, { action });
    const base = { authority, selection, target, plan };
    if (action === "cleanup") {
      prepareForCleanup(selection, target);
    }
    const plannedProcess = worker({ ...base, action: "plan", operation: action });
    assert.equal(plannedProcess.status, 0, plannedProcess.stderr);
    const planned = plannedOf(plannedProcess.stdout);
    assert.equal(planned.status, "planned");
    const { operationRef, planDigest } = planned;
    const plannedRow = await store.read({ authority, target });
    assert.ok(plannedRow?.record.operator);
    const frozenPlan = hostedOperatorPlanSchema.parse(plannedRow.record.operator.plan);
    assert.equal(
      planDigest,
      operatorPlanDigest(frozenPlan),
      `${failure}: returned plan digest must match the frozen plan`,
    );
    assert.equal(plannedRow.record.operator.planDigest, planDigest);
    const executionConfig = { ...base, action: "execute" as const, operationRef, planDigest };
    const crashCode = expectedExit ?? expectedCrashCode(failure);
    const crashed = worker({ ...executionConfig, failure });
    if (crashCode === undefined) {
      assert.equal(crashed.status, 0, crashed.stderr);
      assert.equal(resultOf(crashed.stdout).status, "blocked");
    } else {
      assert.equal(crashed.status, crashCode, crashed.stderr);
    }
    let journalRow = await store.read({ authority, target });
    assert.ok(journalRow);
    assert.deepEqual(
      journalRow.record.operator?.plan,
      frozenPlan,
      `${failure}: journal must retain the exact frozen operator plan`,
    );
    assert.equal(
      journalRow.record.operator?.planDigest,
      planDigest,
      `${failure}: journal must retain the frozen plan digest`,
    );
    if (
      (crashCode !== undefined || failure === "release-before" || failure === "fence-before") &&
      journalRow.record.leaseId !== undefined
    ) {
      const crashedRecord = {
        ...journalRow.record,
        leaseExpiresAt: new Date(Date.now() - 10_000).toISOString(),
      };
      journalRow = await store.compareAndSet({
        authority,
        target,
        expectedRevision: journalRow.revision,
        now: new Date(),
        record: hostedRuntimeJournalRecordSchema.parse(crashedRecord),
      });
      assert.ok(journalRow, "stale child lease must be expired before replacement recovery");
    }
    const [, effectId = ""] = failure.split(":");
    assertInterruptedJournal(failure, journalRow, frozenPlan, effectId);
    assertInterruptedProviderState(
      failure,
      effectId,
      frozenPlan,
      await readSyntheticEffects(operationRef),
    );
    const resumed = worker({ ...executionConfig, action: "execute" });
    assert.equal(resumed.status, 0, `${failure}: ${resumed.stderr}`);
    assert.equal(
      resultOf(resumed.stdout).status,
      action === "prepare" ? "prepared" : "cleaned",
      `${failure}: ${resumed.stdout.slice(-700)}`,
    );
    injectedCases.push(failure);
    const finalRow = await assertFinalScenario(
      failure,
      action,
      target,
      operationRef,
      frozenPlan,
      planDigest,
    );
    return {
      selection,
      target,
      plan: frozenPlan,
      operationRef,
      planDigest,
      row: finalRow,
    };
  };

  const effects = ["resources", "install", "access", "bind"];
  for (const effectId of effects) {
    for (const stage of [
      "checkpoint-before",
      "checkpoint-after",
      "context-before",
      "context-after",
      "worker-checkpoint-before",
      "worker-checkpoint-after",
      "effect-before",
      "effect-after",
      "receipt-before",
      "receipt-after",
    ] as const) {
      await runScenario(`${stage}:${effectId}`);
    }
    await runScenario(`pending-before:${effectId}`);
    await runScenario(`pending-after:${effectId}`, 92);
    await runScenario(`effect-crash:${effectId}`, 86);
  }
  for (const effectId of ["revoke", removeBindingsEffectId, "retire"]) {
    for (const stage of [
      "checkpoint-before",
      "checkpoint-after",
      "context-before",
      "context-after",
      "worker-checkpoint-before",
      "worker-checkpoint-after",
      "effect-before",
      "effect-after",
      "receipt-before",
      "receipt-after",
    ] as const) {
      await runScenario(`${stage}:${effectId}`, undefined, "cleanup");
    }
    await runScenario(`pending-before:${effectId}`, undefined, "cleanup");
    await runScenario(`pending-after:${effectId}`, 92, "cleanup");
    await runScenario(`effect-crash:${effectId}`, 86, "cleanup");
  }
  await runScenario("lease-claim-before");
  await runScenario("lease-claim-after", 89);
  await runScenario("fence-before");
  await runScenario("fence-after", 90);
  await runScenario("verify-before");
  await runScenario("verify-after", 87);
  await runScenario("proof-before");
  const proofCrash = await runScenario("proof-after", 88);
  await runScenario("release-before");
  await runScenario("release-after", 91);
  const proofRow = await store.read({ authority, target: proofCrash.target });
  assert.equal(proofRow?.record.status, "prepared");
  assert.equal(proofRow?.record.proof?.releaseId, proofCrash.plan.release.id);
  assert.equal(proofRow?.record.proof?.manifestSha256, proofCrash.plan.release.sha256);

  const unknownSelection = selectionFor();
  const unknownTarget = targetFor(unknownSelection);
  const unknownPlan = makePlan(unknownSelection);
  const unknownBase = {
    authority,
    selection: unknownSelection,
    target: unknownTarget,
    plan: unknownPlan,
  };
  const unknownPlanWorker = worker({ ...unknownBase, action: "plan" });
  const unknownPlanned = plannedOf(unknownPlanWorker.stdout);
  const unknownExecute = worker({
    ...unknownBase,
    action: "execute",
    operationRef: unknownPlanned.operationRef,
    planDigest: unknownPlanned.planDigest,
    failure: "unknown",
  });
  assert.equal(resultOf(unknownExecute.stdout).status, "blocked");
  const noEffects = await fixtureSql<
    { count: number }[]
  >`select count(*)::int as count from a515_synthetic_effects where operation_ref=${unknownPlanned.operationRef}`;
  assert.equal(noEffects[0]?.count, 0);
  const unknownResume = worker({
    ...unknownBase,
    action: "execute",
    operationRef: unknownPlanned.operationRef,
    planDigest: unknownPlanned.planDigest,
  });
  assert.equal(resultOf(unknownResume.stdout).status, "prepared");
  injectedCases.push("unknown");

  const replanSelection = selectionFor();
  const replanTarget = targetFor(replanSelection);
  const originalPlan = makePlan(replanSelection);
  const originalBase = {
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: originalPlan,
  };
  const initialPlanWorker = worker({ ...originalBase, action: "plan" });
  const originalPlanned = plannedOf(initialPlanWorker.stdout);
  const originalExecution = worker({
    ...originalBase,
    action: "execute",
    operationRef: originalPlanned.operationRef,
    planDigest: originalPlanned.planDigest,
  });
  assert.equal(resultOf(originalExecution.stdout).status, "prepared");
  const replacementPlan = makePlan(replanSelection, {
    releaseId: "release_replanned",
    releaseSha: "d".repeat(64),
  });
  const replacementWorker = worker({
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: replacementPlan,
    action: "plan",
  });
  const replacementResult = plannedOf(replacementWorker.stdout);
  assert.equal(replacementResult.status, "planned");
  const retained = await store.read({ authority, target: replanTarget });
  assert.equal(retained?.record.privateState?.encryptedToken, fixtureCiphertext);
  assert.equal(retained?.record.proof, undefined);
  const mismatchedPlan = makePlan(replanSelection, {
    releaseId: "release_other_resource",
    releaseSha: "e".repeat(64),
    neonProjectId: "neon_different",
  });
  const mismatchWorker = worker({
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: mismatchedPlan,
    action: "plan",
  });
  const mismatchResult = resultOf(mismatchWorker.stdout);
  assert.equal(mismatchResult.status, "blocked");
  assert.equal(mismatchResult.code, "resource_mismatch");
  const cleanupPlan = makePlan(replanSelection, { action: "cleanup" });
  const cleanupPlannedWorker = worker({
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: cleanupPlan,
    action: "plan",
    operation: "cleanup",
  });
  const cleanupPlanned = plannedOf(cleanupPlannedWorker.stdout);
  assert.equal(cleanupPlanned.status, "planned");
  const cleanupExec = worker({
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: cleanupPlan,
    action: "execute",
    operationRef: cleanupPlanned.operationRef,
    planDigest: cleanupPlanned.planDigest,
  });
  assert.equal(resultOf(cleanupExec.stdout).status, "cleaned");
  const afterCleanup = worker({
    authority,
    selection: replanSelection,
    target: replanTarget,
    plan: mismatchedPlan,
    action: "plan",
  });
  assert.equal(resultOf(afterCleanup.stdout).status, "planned");

  const fenceSelection = selectionFor();
  const fenceTarget = targetFor(fenceSelection);
  const fencePlan = makePlan(fenceSelection);
  const fenceOperationRef = randomUUID();
  const fencePlanDigest = operatorPlanDigest(fencePlan);
  const fenceRow = await store.reserve({
    authority,
    target: fenceTarget,
    approvedByCallId: "fixture-approved-call",
    now: new Date(),
    operator: {
      mode: "protected-operator-v1",
      operationRef: fenceOperationRef,
      plan: fencePlan,
      planDigest: fencePlanDigest,
      receipts: [],
    },
  });
  const expiredLeaseId = randomUUID();
  const expiredAt = new Date(Date.now() - 10_000);
  const leased = await store.compareAndSet({
    authority,
    target: fenceTarget,
    expectedRevision: fenceRow.revision,
    now: new Date(),
    record: hostedRuntimeJournalRecordSchema.parse({
      ...fenceRow.record,
      leaseId: expiredLeaseId,
      leaseExpiresAt: expiredAt.toISOString(),
    }),
  });
  assert.ok(leased);
  const deniedGeneration = await store.reserveFenceGeneration({
    authority,
    target: fenceTarget,
    expectedRevision: leased.revision,
    leaseId: expiredLeaseId,
    operationRef: fenceOperationRef,
    now: new Date(),
  });
  assert.equal(deniedGeneration, undefined, "expired lease must not allocate a fence generation");
  const afterExpiredAttempt = await store.read({ authority, target: fenceTarget });
  assert.equal(
    afterExpiredAttempt?.revision,
    leased.revision,
    "expired allocation attempt must not advance journal revision",
  );
  const renewed = await store.compareAndSet({
    authority,
    target: fenceTarget,
    expectedRevision: leased.revision,
    now: new Date(),
    record: hostedRuntimeJournalRecordSchema.parse({
      ...leased.record,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    }),
  });
  assert.ok(renewed);
  const grantedGeneration = await store.reserveFenceGeneration({
    authority,
    target: fenceTarget,
    expectedRevision: renewed.revision,
    leaseId: expiredLeaseId,
    operationRef: fenceOperationRef,
    now: new Date(),
  });
  assert.ok(grantedGeneration, "renewed lease must allocate a generation");
  const reservedGeneration = grantedGeneration.record.operator?.fenceGeneration;
  assert.ok(reservedGeneration !== undefined && reservedGeneration > 0);
  const duplicateGeneration = await store.reserveFenceGeneration({
    authority,
    target: fenceTarget,
    expectedRevision: grantedGeneration.revision,
    leaseId: expiredLeaseId,
    operationRef: fenceOperationRef,
    now: new Date(),
  });
  assert.equal(duplicateGeneration, undefined);
  const processSelection = selectionFor();
  const processProof = await proveJournalProcessRecovery({
    databaseUrl: dsn,
    authority,
    target: targetFor(processSelection),
    plan: makePlan(processSelection),
  });
  console.log(
    JSON.stringify({
      failureCases: injectedCases,
      childProcessRestarts: true,
      unknownNeverAbsent: true,
      replanningAndCleanup: true,
      expiredFenceAllocationDenied: true,
      processProof,
      fixture: "owned local PostgreSQL plus SQL-persisted synthetic provider effects",
      hostedPreview: "not assessed",
    }),
  );
} finally {
  if (sql !== undefined) {
    try {
      await sql.end({ timeout: 5 });
    } catch (error) {
      process.stderr.write(`Fixture database shutdown failed: ${String(error)}\n`);
    }
  }
  if (started) {
    spawnSync(
      path.join(postgresBin ?? "", "pg_ctl"),
      ["-D", pgdata, "-m", "immediate", "-w", "stop"],
      { stdio: "ignore" },
    );
  }
  if (externalAdmin !== undefined) {
    try {
      await externalAdmin.unsafe(`drop database if exists ${ownedDatabase} with (force)`);
    } catch (error) {
      process.stderr.write(`Fixture database cleanup failed: ${String(error)}\n`);
    }
    try {
      await externalAdmin.unsafe(`drop role if exists ${ownedRole}`);
    } catch (error) {
      process.stderr.write(`Fixture role cleanup failed: ${String(error)}\n`);
    }
    try {
      await externalAdmin.end({ timeout: 3 });
    } catch (error) {
      process.stderr.write(`Fixture admin shutdown failed: ${String(error)}\n`);
    }
  }
  await rm(scratch, { recursive: true, force: true });
}
