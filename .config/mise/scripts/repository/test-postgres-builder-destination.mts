/* oxlint-disable eslint/no-await-in-loop, promise/avoid-new, promise/prefer-await-to-callbacks, unicorn/no-await-expression-member -- Owned loopback setup uses callback I/O and ordered real-store assertions. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createServer } from "node:net";
import path from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle requires the actual application schema namespace.
import * as schema from "../../../../lib/db/schema";
import { createPostgresHostedEveStore } from "../../../../lib/eve/postgres-hosted-store";
import {
  toDurableHostedSessionRecord,
  hostedOperationRecordSchema,
} from "../../../../lib/eve/hosted-store";
import {
  createPostgresNativeTargetOnboardingStore,
  createNativeTargetOnboardingRegistry,
} from "../../../../lib/provisioning/native-target-onboarding-store";
import {
  nativeTargetOnboardingPlanSchema,
  nativeTargetOnboardingPlanDigest,
  nativeTargetRequiredProjectProtection,
} from "../../../../lib/provisioning/native-target-onboarding-contract";
import type { BuilderDestinationEpoch } from "../../../../lib/provisioning/builder-session-destination-contract";

// An owned loopback cluster only. Never consumes DATABASE_URL or provider credentials.
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const [, , postgresBin] = process.argv;
assert.ok(
  postgresBin && path.isAbsolute(postgresBin),
  "Supply an absolute installed PostgreSQL bin directory",
);
const scratch = await mkdtemp(path.join(tmpdir(), "builder-destination-pg-"));
const data = path.join(scratch, "postgres");
const password = randomBytes(24).toString("hex");
const passwordFile = path.join(scratch, "password");
const port = await new Promise<number>((resolve, reject) => {
  const server = createServer();
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => {
    const address = z.object({ port: z.number().int().positive() }).parse(server.address());
    server.close((error) => {
      if (error === undefined) {
        resolve(address.port);
      } else {
        reject(error);
      }
    });
  });
});
const command = (name: string, args: string[]) => {
  const result = spawnSync(path.join(postgresBin, name), args, {
    encoding: "utf-8",
    env: { PATH: process.env.PATH, LANG: "C", LC_ALL: "C" },
  });
  assert.equal(result.status, 0, `Owned PostgreSQL ${name} failed`);
};
const principal = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
  scopes: ["autograph:send"],
};
const destination = { appId: "saved-app", requestId: randomUUID(), requestDigest: "d".repeat(64) };
const expected: BuilderDestinationEpoch = {
  adapterSessionId: "",
  adapterGeneration: 1,
  cancellationRevision: 0,
};
const cases: string[] = [];
let started = false;
let client: ReturnType<typeof postgres> | undefined;
try {
  await writeFile(passwordFile, password, { mode: 0o600 });
  command("initdb", [
    "-D",
    data,
    "--username=fixture_admin",
    "--auth=scram-sha-256",
    `--pwfile=${passwordFile}`,
    "--no-locale",
  ]);
  command("pg_ctl", [
    "-D",
    data,
    "-l",
    path.join(scratch, "postgres.log"),
    "-o",
    `-h 127.0.0.1 -p ${port} -k ${scratch}`,
    "-w",
    "start",
  ]);
  started = true;
  client = postgres({
    host: "127.0.0.1",
    port,
    database: "postgres",
    username: "fixture_admin",
    password,
    max: 5,
    onnotice: (notice) => {
      assert.ok(notice.message !== undefined);
    },
  });
  const database = drizzle(client, { schema });
  await migrate(database, { migrationsFolder: path.join(repositoryRoot, "drizzle") });
  const store = createPostgresHostedEveStore(database);
  const attach = store.attachBuilderDestination;
  assert.ok(attach, "The real PostgreSQL attach implementation must be present");
  const operation = (label: string, extra = {}) =>
    hostedOperationRecordSchema.parse({
      version: 1,
      principal,
      operationId: randomUUID(),
      clientRequestId: label,
      kind: "start",
      state: "reserved",
      requestDigest: `sha256:${"a".repeat(64)}`,
      createdAtEpochMs: 1000,
      updatedAtEpochMs: 1000,
      ...extra,
    });
  const seed = async (label: string) => {
    const sessionId = `session-${label}`;
    const start = operation(`start-${label}`);
    assert.equal((await store.reserveOperation(principal, start)).disposition, "reserved");
    const session = {
      ...toDurableHostedSessionRecord({
        version: 1,
        principal,
        sessionId,
        adapterSessionId: `adapter-${label}`,
        status: "waiting",
        createdAtEpochMs: 1000,
        updatedAtEpochMs: 1000,
      }),
      appId: destination.appId,
    };
    await store.settleSucceeded({
      principal,
      operationId: start.operationId,
      requestDigest: start.requestDigest,
      nowEpochMs: 1000,
      session,
      result: { sessionId, status: "waiting", events: [], cursor: 0 },
    });
    return {
      principal,
      sessionId,
      destination,
      expected: { ...expected, adapterSessionId: session.adapterSessionId },
      nowEpochMs: 2000,
    };
  };
  const selected = await seed("selected");
  const first = await attach(selected);
  assert.deepEqual(toDurableHostedSessionRecord(first).builderDestination, destination);
  cases.push("real SQL attaches reference and independently reads it back");
  assert.deepEqual(
    toDurableHostedSessionRecord(
      (await store.getSession(principal, selected.sessionId)) ?? assert.fail("missing session"),
    ).builderDestination,
    destination,
  );
  await attach(selected);
  cases.push("same-reference retry is idempotent");
  await assert.rejects(
    attach({ ...selected, destination: { ...destination, requestId: randomUUID() } }),
    /already selected/u,
  );
  cases.push("different destination cannot replace selected reference");
  for (const change of [
    { adapterSessionId: "foreign-adapter" },
    { adapterGeneration: 2 },
    { cancellationRevision: 1 },
    { checkpointDigest: `sha256:${"b".repeat(64)}` },
  ]) {
    await assert.rejects(
      attach({ ...selected, expected: { ...selected.expected, ...change } }),
      /stale or unavailable/u,
    );
  }
  cases.push("adapter, generation, cancellation and checkpoint fences reject stale requests");
  await assert.rejects(
    attach({ ...selected, principal: { ...principal, ownerUserId: "foreign-owner" } }),
    /not found/u,
  );
  cases.push("owner scope is enforced by actual SQL lookup");
  for (const state of ["reserved", "submission_unknown"] as const) {
    const blocked = await seed(`response-${state}`);
    const response = operation(`do-not-replay-${state}`, {
      kind: "respond",
      sessionId: blocked.sessionId,
    });
    await store.reserveOperation(principal, response);
    if (state === "submission_unknown") {
      await store.settleUnsuccessful({
        principal,
        operationId: response.operationId,
        requestDigest: response.requestDigest,
        state,
        safeErrorCode: "submission_unknown",
        nowEpochMs: 1500,
      });
    }
    const before = await store.getPrivateOperation?.(principal, response.operationId);
    await assert.rejects(attach(blocked), /settled session operations/u);
    assert.deepEqual(await store.getPrivateOperation?.(principal, response.operationId), before);
    assert.equal(
      toDurableHostedSessionRecord(
        (await store.getSession(principal, blocked.sessionId)) ?? assert.fail("missing session"),
      ).builderDestination,
      undefined,
    );
    cases.push(`pending response ${state} denied without modifying its operation or session`);
  }
  for (const state of ["reserved", "submission_unknown"] as const) {
    const blocked = await seed(`resume-${state}`);
    const resume = operation(`resume-do-not-replay-${state}`, {
      resumeSessionId: blocked.sessionId,
    });
    assert.equal((await store.reserveOperation(principal, resume)).disposition, "reserved");
    if (state === "submission_unknown") {
      await store.settleUnsuccessful({
        principal,
        operationId: resume.operationId,
        requestDigest: resume.requestDigest,
        state,
        safeErrorCode: "submission_unknown",
        nowEpochMs: 1500,
      });
    }
    const before = await store.getPrivateOperation?.(principal, resume.operationId);
    await assert.rejects(attach(blocked), /settled session operations/u);
    assert.deepEqual(await store.getPrivateOperation?.(principal, resume.operationId), before);
    cases.push(`pending resume ${state} with null session_id denied and preserved`);
  }
  const legacySource = await seed("native-legacy");
  const legacyAuthority = {
    issuer: principal.issuer,
    audience: principal.audience,
    workspaceId: principal.workspaceId,
    ownerUserId: principal.ownerUserId,
  };
  const legacyOwner = {
    authority: legacyAuthority,
    publicSessionId: legacySource.sessionId,
    adapterSessionId: legacySource.expected.adapterSessionId,
    adapterGeneration: 1,
  };
  const legacyPlan = nativeTargetOnboardingPlanSchema.parse({
    version: 1,
    appId: destination.appId,
    origin: {
      publicSessionId: legacySource.sessionId,
      adapterSessionId: legacySource.expected.adapterSessionId,
      adapterGeneration: 1,
      appSpecDigest: "a".repeat(64),
      release: {
        artifactRef: "artifact-original",
        id: "release-original",
        manifestSha256: "b".repeat(64),
        schemaSha256: "c".repeat(64),
      },
    },
    project: {
      name: destination.appId,
      teamId: "team_fixture",
      installationId: "install_fixture",
      projectSettings: {
        framework: "nextjs",
        rootDirectory: "apps/requests",
        sourceFilesOutsideRootDirectory: true,
      },
      protection: nativeTargetRequiredProjectProtection,
    },
    branch: "main",
    appDatabase: {
      database: "requests_data",
      migratorRole: "requests_migrator",
      resourceId: "requests-resource",
      runtimeRole: "requests_runtime",
    },
    productRoles: [],
    nativeNeon: {
      approvalReference: "native-scope-approval",
      nativeStore: {
        configurationId: "store-config",
        resourceId: "store-resource",
        sourceProjectId: "source-project",
      },
      scope: {
        branchId: "neon-branch",
        endpointId: "neon-endpoint",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "maintenance",
        maintenanceRole: "installer",
        projectId: "neon-project",
      },
    },
    worker: {
      executablePath: "/trusted/generic-worker",
      id: "generic-installer",
      operationScope: "generated-app-release-install-v1",
      sha256: "d".repeat(64),
      subcommand: "protected-generated-app-install",
    },
    cost: { description: "Separate app target", ownership: "current-owner" },
    retention: { policy: "Until approved cleanup" },
    conflictPolicy: "stop-on-conflict",
  });
  const nativeStore = createPostgresNativeTargetOnboardingStore(drizzle(client, { schema }));
  const legacyNow = new Date("2026-10-21T15:00:00.000Z");
  const nativeRegistry = createNativeTargetOnboardingRegistry({
    store: nativeStore,
    authorize: () => Promise.resolve(legacyOwner),
    now: () => legacyNow,
    assertPlanOrigin: (owner, plan) => {
      assert.deepEqual(owner, legacyOwner);
      assert.deepEqual(plan, legacyPlan);
      return Promise.resolve();
    },
    readApproval: () =>
      Promise.resolve({
        requestId: "legacy-approval",
        callId: "legacy-call",
        planDigest: nativeTargetOnboardingPlanDigest(legacyPlan),
        responderPrincipalId: principal.ownerUserId,
        publicSessionId: legacySource.sessionId,
        outcome: "approved",
        observedAt: legacyNow.toISOString(),
      }),
  });
  await nativeRegistry.reservePlan({}, legacyPlan);
  await nativeRegistry.recordApproval({}, destination.appId);
  const legacyAttempt = {
    attemptId: randomUUID(),
    candidateName: destination.appId,
    leaseId: randomUUID(),
    startedAt: legacyNow.toISOString(),
    leaseExpiresAt: "2026-10-21T15:10:00.000Z",
  };
  await nativeRegistry.claimAttempt({}, destination.appId, legacyAttempt);
  const key = { authority: legacyAuthority, appId: destination.appId };
  const creating = await nativeStore.read(key);
  await assert.rejects(attach(legacySource), /Reconcile/u);
  assert.deepEqual(await nativeStore.read(key), creating);
  cases.push("active native project creation prevents attachment without journal mutation");
  await nativeRegistry.authorizeAttempt(
    {},
    destination.appId,
    legacyAttempt.attemptId,
    legacyAttempt.leaseId,
  );
  await nativeRegistry.recordUnknown({}, destination.appId, legacyAttempt.attemptId);
  const uncertain = await nativeStore.read(key);
  await assert.rejects(attach(legacySource), /Reconcile/u);
  assert.deepEqual(await nativeStore.read(key), uncertain);
  cases.push("unknown native project creation prevents attachment and stays unknown");
  await nativeRegistry.acceptProjectId({}, destination.appId, legacyAttempt.leaseId, {
    attemptId: legacyAttempt.attemptId,
    projectId: "project-accepted",
    acceptedAt: legacyNow.toISOString(),
  });
  const accepted = await nativeStore.read(key);
  await assert.rejects(attach(legacySource), /Reconcile/u);
  assert.deepEqual(await nativeStore.read(key), accepted);
  cases.push("accepted native project identity prevents attachment and remains preserved");
  console.log(
    JSON.stringify({
      result: "passed",
      evidence: "owned loopback PostgreSQL; real createPostgresHostedEveStore",
      checks: cases,
      hostedAcceptance: "unassessed",
    }),
  );
} finally {
  await client?.end({ timeout: 5 });
  if (started) {
    command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { force: true, recursive: true });
}
