import { proveOwnedAppResourceCustody } from "./resource-custody.mts";
/* oxlint-disable eslint/no-await-in-loop, promise/avoid-new -- This test owns one disposable cluster and verifies ordered durable journal transitions. */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Drizzle uses the existing complete database schema.
import * as schema from "../../../../../lib/db/schema";
import { createPostgresPublicReleaseStore } from "../../../../../lib/provisioning/public-release-store";
import { plan, authority } from "../../../../../lib/provisioning/public-release-test-fixture";

import { createPublicReleaseApprovalCheckpoint } from "../../../../../lib/provisioning/public-release-approval-authority";

import {
  publicReleasePlanDigest,
  publicReleaseOperationRef,
} from "../../../../../lib/provisioning/public-release-contract";

import {
  createPublicReleaseRuntimeConfigurationStore,
  createFreshPublicAuthValues,
} from "../../../../../lib/provisioning/public-release-runtime-configuration";

import { reservePublicReleaseAuthSeed } from "../../../../../lib/provisioning/public-release-auth-seed";
import { createPublicReleaseTargetLease } from "../../../../../lib/provisioning/public-release-target-lease";

import {
  resolvePublicRealmEnrollment,
  readPublicRealmLinkConfiguration,
} from "../../../../../lib/provisioning/public-realm-link-configuration";
import type { PublicRealmLinkSourceConfiguration } from "../../../../../lib/provisioning/public-realm-link-configuration";
import {
  captureFixture,
  context as runtimeFixtureContext,
  requiredFixture,
} from "../../../../../lib/provisioning/hosted-operator-unapproved-app-successor.test-support";
import {
  operatorOwnerContextSchema,
  hostedOperatorPlanSchema,
  retainedOperatorAuthSchema,
  operatorPlanDigest,
} from "../../../../../lib/provisioning/hosted-operator-contract";

const postgresFlag = process.argv.indexOf("--postgres-bin");
const postgresBin = postgresFlag === -1 ? undefined : process.argv[postgresFlag + 1];
if (postgresBin === undefined || !path.isAbsolute(postgresBin)) {
  throw new Error("An explicit local PostgreSQL binary directory is required");
}
// oxlint-disable-next-line sonarjs/publicly-writable-directories -- mkdtemp creates an exclusively owned test directory.
const scratch = await mkdtemp(path.join(tmpdir(), "a469-public-release-pg-"));
const pgdata = path.join(scratch, "data");
const passwordFile = path.join(scratch, "password");
const password = randomBytes(24).toString("hex");
const run = (binary: string, args: string[]) => {
  const result = spawnSync(path.join(postgresBin, binary), args, { encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(`Local PostgreSQL ${binary} failed`);
  }
};
const listener = createServer();
await new Promise<void>((resolve, reject) => {
  listener.once("error", reject);
  listener.listen(0, "127.0.0.1", resolve);
});
const address = z.object({ port: z.number().int().positive() }).parse(listener.address());
const { port } = address;
await new Promise<void>((resolve, reject) => {
  listener.close((error) => {
    if (error !== undefined) {
      reject(error);
      return;
    }
    resolve();
  });
});
let started = false;
let admin: ReturnType<typeof postgres> | undefined;
let writer: ReturnType<typeof postgres> | undefined;
try {
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
  const dsn = new URL(`postgres://127.0.0.1:${port}/postgres?sslmode=disable`);
  dsn.username = "fixture_admin";
  dsn.password = password;
  admin = postgres(dsn.toString(), {
    max: 2,
    onnotice: () => {
      /* Schema notices are intentionally omitted from the payload-free proof output. */
    },
  });
  await migrate(drizzle(admin), { migrationsFolder: path.resolve("drizzle") });
  await admin.unsafe(`CREATE ROLE public_release_writer LOGIN PASSWORD '${password}'`);
  await admin.unsafe(
    "GRANT SELECT, INSERT ON public.builder_provisioning_journal TO public_release_writer",
  );
  await admin.unsafe(
    "GRANT UPDATE(record, revision, state, updated_at) ON public.builder_provisioning_journal TO public_release_writer",
  );
  await admin.unsafe(
    "GRANT SELECT ON public.hosted_vercel_installation,public.hosted_github_installation,public.hosted_github_installation_binding TO public_release_writer",
  );
  dsn.username = "public_release_writer";
  writer = postgres(dsn.toString(), {
    max: 2,
    onnotice: () => {
      /* Schema notices are intentionally omitted from the payload-free proof output. */
    },
  });
  const store = createPostgresPublicReleaseStore(drizzle(writer, { schema }));
  const initial = await store.reserve(plan);
  assert.equal(initial.revision, 1);
  const resumed = await store.reserve(plan);
  assert.equal(resumed.revision, 1);
  assert.equal(
    await store.read({ ...authority, ownerUserId: "foreign" }, initial.operationRef),
    undefined,
  );
  const pending = await store.compareAndSet(initial, {
    ...initial.record,
    effects: { ...initial.record.effects, "bind-production-runtime": "pending" },
    bindings: { INVOICE_APP_DATABASE_URL: { state: "pending" } },
  });
  assert.ok(pending);
  assert.equal(await store.compareAndSet(initial, initial.record), undefined);
  const accepted = await store.compareAndSet(pending, {
    ...pending.record,
    bindings: { INVOICE_APP_DATABASE_URL: { state: "pending", acceptedEnvId: "env-observed" } },
  });
  assert.ok(accepted);
  await assert.rejects(
    store.compareAndSet(accepted, {
      ...accepted.record,
      bindings: { INVOICE_APP_DATABASE_URL: { state: "pending", acceptedEnvId: "foreign-env" } },
    }),
  );
  await assert.rejects(
    store.compareAndSet(accepted, {
      ...accepted.record,
      plan: { ...accepted.record.plan, publicOrigin: "https://foreign.example" },
    }),
  );
  const verified = await store.compareAndSet(accepted, {
    ...accepted.record,
    bindings: { INVOICE_APP_DATABASE_URL: { state: "applied", acceptedEnvId: "env-observed" } },
  });
  assert.ok(verified);
  await assert.rejects(
    store.compareAndSet(verified, {
      ...verified.record,
      bindings: { INVOICE_APP_DATABASE_URL: { state: "pending", acceptedEnvId: "env-observed" } },
    }),
  );
  const owner = operatorOwnerContextSchema.parse({
    kind: "direct",
    authority,
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: plan.selection.sessionId,
    adapterSessionId: "native",
    adapterGeneration: 1,
  });
  const checkpointInput = {
    database: drizzle(writer, { schema }),
    plan,
    owner,
    assertCurrentOwner: async () => {
      await Promise.resolve();
    },
  };
  const checkpoint = createPublicReleaseApprovalCheckpoint(checkpointInput);
  assert.equal(await checkpoint.read(), undefined);
  const observation = {
    adapterSessionId: "native",
    adapterGeneration: 1,
    nextNativeIndex: 5,
    capture: {
      request: {
        action: "public-release" as const,
        planRef: publicReleaseOperationRef(plan),
        planDigest: publicReleasePlanDigest(plan),
        idempotencyKey: plan.selection.appId,
      },
      ownerUserId: authority.ownerUserId,
      entries: [
        {
          requestId: "approval",
          callId: "call",
          approved: false,
          cancelled: true,
          completedApproved: false,
          completedCancelled: true,
        },
      ],
    },
  };
  await checkpoint.save(observation);
  const resumedCheckpoint = createPublicReleaseApprovalCheckpoint(checkpointInput);
  assert.deepEqual(await resumedCheckpoint.read(), observation);
  await assert.rejects(resumedCheckpoint.save({ ...observation, nextNativeIndex: 4 }));
  await assert.rejects(
    resumedCheckpoint.save({
      ...observation,
      nextNativeIndex: 6,
      capture: { ...observation.capture, entries: [] },
    }),
  );
  await assert.rejects(resumedCheckpoint.save({ ...observation, adapterSessionId: "foreign" }));
  await checkpoint.save({ ...observation, nextNativeIndex: 7 });
  await assert.rejects(resumedCheckpoint.save({ ...observation, nextNativeIndex: 8 }));
  const privateTarget = {
    authority,
    appId: plan.selection.appId,
    sessionId: plan.selection.sessionId,
    projectId: plan.project.projectId,
  };
  const privateStore = createPublicReleaseRuntimeConfigurationStore({
    target: privateTarget,

    database: drizzle(writer, { schema }),
    keyring: { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture-v1" },
    assertCurrentOwner: checkpointInput.assertCurrentOwner,
  });
  const privateScope = {
    authority,
    appId: plan.selection.appId,
    sessionId: plan.selection.sessionId,
    projectId: plan.project.projectId,
    runtimeOperationRef: plan.runtime.operationRef,
    runtimePlanDigest: plan.runtime.planDigest,
    releaseId: plan.runtime.releaseId,
    publicOrigin: plan.publicOrigin,
  };
  const prepared = await privateStore.reserve(privateScope, () =>
    createFreshPublicAuthValues({
      appId: plan.selection.appId,
      publicOrigin: plan.publicOrigin,
      authResource: {
        hostname: "ep-synthetic.aws.neon.tech",
        port: 5432,
        database: "isolated_auth",
        schema: "public",
        runtimeRole: "app_auth_runtime",
        migratorRole: "auth_migrator",
        neon: { projectId: "synthetic", branchId: "non-default" },
      },
      authRuntimeUrl:
        "postgresql://app_auth_runtime:private-fixture-password@ep-synthetic.aws.neon.tech/isolated_auth?sslmode=verify-full",
      productionDatabaseIdentity: "ep-production.aws.neon.tech/neondb",
    }),
  );
  const privateValues = await privateStore.read(privateScope);
  assert.ok(privateValues);
  assert.equal(privateValues.BETTER_AUTH_URL, plan.publicOrigin);
  assert.equal(privateValues.PLATFORM_AUTH_DEPLOYMENT_PROFILE, "isolated-development");
  const repeated = await privateStore.reserve(privateScope, () => {
    throw new Error("A retry must not rotate the private Auth seed");
  });
  assert.deepEqual(repeated, prepared);
  const [privateRow] =
    await admin`select record from public.builder_provisioning_journal where request_id=${prepared.configurationRef}`;
  assert.equal(JSON.stringify(privateRow.record).includes(privateValues.BETTER_AUTH_SECRET), false);
  assert.equal(
    JSON.stringify(privateRow.record).includes(privateValues.PLATFORM_AUTH_DATABASE_URL),
    false,
  );
  await assert.rejects(privateStore.read({ ...privateScope, projectId: "foreign" }));
  await assert.rejects(
    createPublicReleaseRuntimeConfigurationStore({
      database: drizzle(writer, { schema }),
      keyring: { tokenKey: Buffer.alloc(32, 8), tokenKeyVersion: "fixture-v1" },
      target: privateTarget,

      assertCurrentOwner: checkpointInput.assertCurrentOwner,
    }).read(privateScope),
  );
  const seedInput = {
    database: drizzle(writer, { schema }),
    keyring: { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture-v1" },
    assertCurrentOwner: checkpointInput.assertCurrentOwner,
    scope: {
      ...privateTarget,
      publicOrigin: plan.publicOrigin,
      authResourceIdentity: "e".repeat(64),
    },
  };
  const seed = await reservePublicReleaseAuthSeed(seedInput);
  assert.deepEqual(await reservePublicReleaseAuthSeed(seedInput), seed);
  assert.deepEqual(
    await reservePublicReleaseAuthSeed({
      ...seedInput,
      scope: { ...seedInput.scope, sessionId: "normal-existing-app-revision" },
    }),
    seed,
  );
  const otherSeed = await reservePublicReleaseAuthSeed({
    ...seedInput,
    scope: { ...seedInput.scope, publicOrigin: "https://other.example" },
  });
  assert.notEqual(otherSeed.BETTER_AUTH_SECRET, seed.BETTER_AUTH_SECRET);
  let fence: (() => Promise<void>) | undefined;
  const targetLease = createPublicReleaseTargetLease({
    databaseUrl: dsn.toString(),
    store,
    assertCurrent: async () => {
      await Promise.resolve();
    },
    lockKeys: () => ["owned-project-fixture"],
    bindFence: (current) => {
      fence = current;
    },
  });
  await targetLease(
    {
      authority,
      sessionId: plan.selection.sessionId,
      callId: "call",
      signal: new AbortController().signal,
    },
    plan,
    async () => {
      assert.ok(fence);
      await fence();
      const claimed = await store.read(authority, initial.operationRef);
      assert.ok(claimed);
      assert.equal(claimed.record.executionLease?.fenceGeneration, 1);
      const approvalRecorded = await store.compareAndSet(claimed, {
        ...claimed.record,
        approvalReceipts: [{ approvalId: "actual-approval", approvedByCallId: "actual-call" }],
      });
      assert.ok(approvalRecorded);
      await assert.rejects(
        store.compareAndSet(approvalRecorded, { ...approvalRecorded.record, approvalReceipts: [] }),
      );
      const advanced = await store.compareAndSet(approvalRecorded, {
        ...approvalRecorded.record,
        executionLease: { leaseId: randomUUID(), fenceGeneration: 2 },
      });
      assert.ok(advanced);
      await assert.rejects(fence());
    },
  );
  assert.equal(fence, undefined);
  // A fresh test-only normal resource plan is parsed independently; no live or frozen plan is rewritten.
  const retainedFixture = requiredFixture(captureFixture().record.retainedAuth);
  const fixtureBoundary = requiredFixture(retainedFixture.plan.deploymentBoundary);
  const fixtureTarget = retainedFixture.plan.selection;
  const freshNormalPlan = hostedOperatorPlanSchema.parse({
    ...retainedFixture.plan,
    gatewayBindings: undefined,
    gatewayDelivery: undefined,
    effects: retainedFixture.plan.effects.filter(
      (effect) => !["gateway-bindings", "gateway-delivery"].includes(effect.kind),
    ),
    publicGateway: { ...retainedFixture.plan.publicGateway, projectId: fixtureTarget.projectId },
    deploymentBoundary: {
      ...fixtureBoundary,
      composition: "single-project-services",
      gateway: { ...fixtureBoundary.gateway, projectId: fixtureTarget.projectId },
    },
  });
  const freshNormalSetup = retainedOperatorAuthSchema.parse({
    ...retainedFixture,
    operationRef: randomUUID(),
    plan: freshNormalPlan,
    planDigest: operatorPlanDigest(freshNormalPlan),
    gatewayEnvironment: undefined,
    receipts: retainedFixture.receipts.filter((receipt) =>
      freshNormalPlan.effects.some((effect) => effect.id === receipt.effectId),
    ),
  });
  const issuer = "https://oidc.vercel.com/team";
  const audience = "https://vercel.com/team";
  const realmConfiguration: PublicRealmLinkSourceConfiguration = {
    teamId: fixtureBoundary.teamId,
    gateway: { projectId: fixtureTarget.projectId },
    builderCallbackOrigin: "https://builder.example",
    operator: { origin: "https://operator.example" },
    workloadPolicy: {
      issuer,
      audience,
      projectId: "builder",
      ownerId: fixtureBoundary.teamId,
      environment: "production",
      subject: "explicit-reviewed-builder-production",
    },
    nativeNeon: {
      configuration: {
        operator: {
          issuer,
          audience,
          projectId: "operator",
          ownerId: fixtureBoundary.teamId,
          environment: "preview",
        },
      },
    },
    standardRuntime: {
      publicRealmWorkload: {
        issuer,
        audience,
        projectId: fixtureTarget.projectId,
        ownerId: fixtureBoundary.teamId,
        environment: "production",
        subject: "explicit-reviewed-app-production",
      },
    },
  };
  const enrollmentInput = {
    database: drizzle(writer, { schema }),
    keyring: seedInput.keyring,
    configuration: realmConfiguration,
    owner: { authority, appId: fixtureTarget.appId, sessionId: fixtureTarget.sessionId },
    originalSetup: freshNormalSetup,
    publicOrigin: requiredFixture(freshNormalPlan.publicGateway).origin,
    authResource: {
      version: 1 as const,
      environment: "preview" as const,
      hostname: freshNormalPlan.neon.endpoint,
      port: 5432 as const,
      database: freshNormalPlan.authDatabase.database,
      schema: "public" as const,
      runtimeRole: freshNormalPlan.authDatabase.runtimeRole,
      migratorRole: freshNormalPlan.authDatabase.migratorRole,
      neon: { projectId: freshNormalPlan.neon.projectId, branchId: freshNormalPlan.neon.branchId },
    },
    assertCurrentOwner: checkpointInput.assertCurrentOwner,
  };
  const enrollment = await resolvePublicRealmEnrollment(enrollmentInput);
  assert.deepEqual(await resolvePublicRealmEnrollment(enrollmentInput), enrollment);
  assert.equal(enrollment.linkConfiguration.publicEnrollment.resource.environment, "preview");
  assert.equal(enrollment.linkConfiguration.identityHandoff.sender.environment, "production");
  await assert.rejects(
    readPublicRealmLinkConfiguration({
      database: enrollmentInput.database,
      keyring: enrollmentInput.keyring,
      authority: { ...authority, ownerUserId: "foreign" },
      enrollmentRef: enrollment.enrollmentRef,
      assertCurrentOwner: checkpointInput.assertCurrentOwner,
    }),
  );
  const [sealedEnrollment] =
    await admin`select record from public.builder_provisioning_journal where record->'enrollment'->>'enrollmentRef'=${enrollment.enrollmentRef}`;
  assert.equal(
    JSON.stringify(sealedEnrollment.record).includes("explicit-reviewed-app-production"),
    false,
  );
  await proveOwnedAppResourceCustody({
    database: drizzle(writer, { schema }),
    keyring: seedInput.keyring,
    context: runtimeFixtureContext,
    setup: freshNormalSetup,
  });
  const otherRef = randomUUID();
  await admin`INSERT INTO public.builder_provisioning_journal (issuer,audience,workspace_id,owner_user_id,request_id,request_digest,revision,state,record,created_at,updated_at) VALUES (${authority.issuer},${authority.audience},${authority.workspaceId},${authority.ownerUserId},${otherRef},${"f".repeat(64)},1,'pending',${JSON.stringify({ kind: "native-target-onboarding" })}::jsonb,now(),now())`;
  assert.equal(await store.read(authority, otherRef), undefined);
  const restarted = createPostgresPublicReleaseStore(drizzle(writer, { schema }));
  const observed = await restarted.read(authority, initial.operationRef);
  assert.equal(observed?.record.bindings.INVOICE_APP_DATABASE_URL.acceptedEnvId, "env-observed");
  console.log(
    "Public release PostgreSQL proof passed: restricted writer, restart readback, stale CAS, immutable target/row receipt, foreign owner and record-kind isolation, revision credential reuse with new AAD and revoked current/original approval denial.",
  );
} finally {
  await writer?.end();
  await admin?.end();
  if (started) {
    run("pg_ctl", ["-D", pgdata, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { recursive: true, force: true });
}
