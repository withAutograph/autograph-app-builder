/* oxlint-disable eslint/sort-keys, eslint/no-await-in-loop, unicorn/no-await-expression-member, typescript/no-non-null-assertion, promise/avoid-new, promise/prefer-await-to-callbacks -- Ordered native state transitions and assertions operate on resources whose creation is checked; callback adapters exercise the real owner resolver and never replace journal or artifact stores. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";

import postgres from "postgres";
import { z } from "zod";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Actual Drizzle composition uses the complete owned schema namespace.
import * as schema from "../../../../lib/db/schema";
import { createHostedOperatorControlPlane } from "../../../../lib/provisioning/hosted-operator-deployment";
import { createPostgresHostedEveStore } from "../../../../lib/eve/postgres-hosted-store";
import { durableHostedSessionRecordSchema } from "../../../../lib/eve/hosted-store";
import { hostedRuntimeTargetSchema } from "../../../../lib/provisioning/hosted-runtime-journal";
import { createPostgresHostedRuntimeJournalStore } from "../../../../lib/provisioning/postgres-hosted-runtime-journal";
import { createPostgresOperatorArtifactStore } from "../../../../lib/provisioning/hosted-operator-artifact-store";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../../../../lib/provisioning/hosted-operator-contract";
import { createRealmIdentityCallbackHandler } from "../../../../lib/provisioning/hosted-operator-realm-callback";
import {
  encryptVercelToken,
  readVercelTokenKeyringEnvironment,
} from "../../../../lib/integrations/vercel-installation";
import { openOwnedRealmSource } from "./owned-hosted-operator-realm-source.mjs";

// This diagnostic owns every database/process/key. Provider metadata, HTTP routing and the browser owner-auth selector are modeled;
// canonical SQL/CAS, source cookie/proof issuance, source session readback, and callback logic are real.
// It never reads configured DATABASE_URL/provider credentials and is not hosted Preview qualification.
const [arrustedRoot] = process.argv.slice(2);
if (!arrustedRoot || !path.isAbsolute(arrustedRoot)) {
  throw new Error("Expected absolute Arrusted source root");
}
const repositoryRoot = path.resolve(import.meta.dirname, "../../../..");
const scratch = await mkdtemp(path.join(tmpdir(), "hosted-operator-realm-cas-"));
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
  const result = spawnSync(name, args, {
    encoding: "utf-8",
    env: { LANG: "C", LC_ALL: "C", PATH: process.env.PATH },
  });
  if (result.status !== 0) {
    throw new Error(`Owned PostgreSQL ${name} failed`);
  }
};
const connection = (role: string, database: string) =>
  `postgres://${role}:${password}@127.0.0.1:${port}/${database}?sslmode=disable`;
const digest = (value: string) => createHash("sha256").update(value).digest("hex");
const builderOrigin = "https://builder.example.test";
const authority = {
  audience: `${builderOrigin}/mcp`,
  issuer: `${builderOrigin}/api/auth`,
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const principal = { ...authority, scopes: ["autograph:send"] };
const selection = {
  appId: "spend-review",
  branch: "feature",
  environment: "preview" as const,
  projectId: "prj_app",
  sessionId: "canonical-public-session",
};
const target = hostedRuntimeTargetSchema.parse({
  ...selection,
  installationId: "icfg_owned",
  scopeId: "team_owned",
  scopeType: "team",
});
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-owned",
  authority,
  kind: "direct" as const,
  principal,
  sessionId: selection.sessionId,
};
const context = { authority, ownerContext, target };
const workloadPolicy = {
  audience: "https://vercel.com/owned-fixture",
  environment: "production" as const,
  issuer: "https://oidc.vercel.com/owned-fixture",
  ownerId: "team_owned",
  projectId: "prj_builder",
  subject: "owner:owned-fixture:project:builder:environment:production",
};
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-owned",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "realm_db",
    migratorRole: "realm_migrator",
    resourceId: "auth-owned",
    runtimeRole: "realm_runtime",
  },
  authSchema: {
    artifactRef: "auth-source-fixture",
    installer: { reference: "auth-protected-installer-v1", sha256: "c".repeat(64) },
    planDigest: "d".repeat(64),
    targetDigest: "e".repeat(64),
  },
  bootstrap: { endpointId: "ep_modeled", maintenanceDatabase: "neondb", role: "neondb_owner" },
  contextId: "owned-local-cas",
  cost: {
    class: "shared-recovery-group",
    description: "Owned disposable acceptance",
    owner: "Fixture",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
      deploymentId: "dpl_gateway",
      environment: "preview",
      projectId: "prj_gateway",
    },
    operator: {
      deploymentId: "dpl_operator",
      environment: "production",
      projectId: "prj_operator",
    },
    teamId: target.scopeId,
    verification: {
      gatewayOrigin: "https://realm-endpoint.example.test",
      jwksUrl: "https://realm-endpoint.example.test/_platform/jwks.json",
      publicOrigin: "https://realm-public.example.test",
    },
  },
  effects: [
    {
      description: "Modeled Auth bootstrap observation",
      id: "resources:auth",
      kind: "resources",
      resourceId: "auth-owned",
    },
    {
      description: "Modeled AppDB bootstrap observation",
      id: "resources:app",
      kind: "resources",
      resourceId: "app-owned",
    },
    { description: "Modeled source schema observation", id: "install:auth", kind: "install" },
    {
      description: "Modeled Gateway binding observation",
      id: "gateway-bindings",
      kind: "gateway-bindings",
    },
  ],
  gatewayBindings: {
    authBrowserOrigin: "https://realm-browser.example.test",
    builderCallbackOrigin: builderOrigin,
    catalogAppIds: [selection.appId],
    operatorOrigin: "https://operator.example.test",
    sourceWorkload: { ...workloadPolicy, environment: "preview", projectId: "prj_gateway" },
  },
  installer: { reference: "generated-app-protected-installer-v1", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_modeled",
    connectionRef: "fixture-private",
    endpoint: "ep-modeled.neon.tech",
    projectId: "neon_modeled",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://realm-public.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "source-fixture-release", id: "schema-fixture", sha256: "b".repeat(64) },
  resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "f".repeat(64) },
  retention: {
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    policy: "Owned fixture lifetime",
  },
  selection,
  stage: "auth-bootstrap",
  version: 1,
});
const planDigest = operatorPlanDigest(plan);
const now = Date.now();
let started = false;
let sql: ReturnType<typeof postgres> | undefined;
let cp: Awaited<ReturnType<typeof createHostedOperatorControlPlane>> | undefined;
let realm: Awaited<ReturnType<typeof openOwnedRealmSource>> | undefined;
let checks = 0;
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
  sql = postgres(connection("fixture_admin", "postgres"));
  await sql.unsafe(
    `create role builder_cp login password '${password}'; create role realm_migrator login password '${password}'; create role realm_runtime login password '${password}'`,
  );
  await sql.unsafe("create database builder_cp owner builder_cp");
  await sql.unsafe("create database realm_db owner realm_migrator");
  await sql.end();
  sql = postgres(connection("builder_cp", "builder_cp"), {
    onnotice: (notice) => {
      assert.ok(notice.message !== undefined);
    },
  });
  const database = drizzle(sql, { schema });
  await migrate(database, { migrationsFolder: path.join(repositoryRoot, "drizzle") });
  await database.insert(schema.user).values({
    createdAt: new Date(now),
    email: "owner@example.test",
    emailVerified: true,
    id: authority.ownerUserId,
    name: "Owned Builder fixture",
    updatedAt: new Date(now),
  });
  await database.insert(schema.organization).values({
    id: "org_owned",
    name: "Owned workspace",
    slug: "owned-workspace",
    issuer: authority.issuer,
    audience: authority.audience,
    workspaceId: authority.workspaceId,
    createdAt: new Date(now),
  });
  await database.insert(schema.member).values({
    createdAt: new Date(now),
    id: "member_owned",
    organizationId: "org_owned",
    role: "owner",
    userId: authority.ownerUserId,
  });
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: ownerContext.adapterSessionId,
    appId: selection.appId,
    createdAtEpochMs: now,
    lastProgressAtEpochMs: now,
    originAdapterSessionId: ownerContext.adapterSessionId,
    principal,
    resumability: "live",
    sessionId: selection.sessionId,
    stage: "planning",
    status: "input_required",
    title: "Owned fixture",
    updatedAtEpochMs: now,
    version: 2,
  });
  await database.insert(schema.agentSessions).values({
    ...authority,
    adapterGeneration: 1,
    adapterSessionId: session.adapterSessionId,
    createdAt: new Date(now),
    lastProgressAt: new Date(now),
    record: session,
    resumabilityState: session.resumability,
    sessionId: session.sessionId,
    stage: session.stage,
    title: session.title,
    updatedAt: new Date(now),
  });
  const eve = createPostgresHostedEveStore(database);
  assert.deepEqual(await eve.getSession(principal, session.sessionId), session);
  checks += 1;
  const environment = {
    BETTER_AUTH_URL: authority.issuer,
    DATABASE_URL: connection("builder_cp", "builder_cp"),
    MCP_RESOURCE_URL: authority.audience,
    VERCEL_INTEGRATION_TOKEN_KEY: randomBytes(32).toString("base64"),
    VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "owned-v1",
  };
  const keyring = readVercelTokenKeyringEnvironment(environment);
  const fixtureGrant = randomUUID();
  const encrypted = encryptVercelToken({
    associatedData: JSON.stringify({ ...authority, installationId: target.installationId }),
    key: keyring.tokenKey,
    token: fixtureGrant,
  });
  await database.insert(schema.hostedVercelInstallations).values({
    ...authority,
    ...encrypted,
    active: true,
    displayName: "Modeled metadata only",
    installationId: target.installationId,
    plan: "fixture",
    scopeId: target.scopeId,
    scopeType: target.scopeType,
    slug: "owned",
    tokenKeyVersion: keyring.tokenKeyVersion,
    updatedAt: new Date(now),
  });
  let metadataReads = 0;
  const metadataFetch: typeof fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    assert.equal(url.origin, "https://api.vercel.com");
    assert.equal(url.pathname, `/v9/projects/${target.projectId}`);
    assert.equal(url.searchParams.get("teamId"), target.scopeId);
    assert.equal(init?.method, "GET");
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${fixtureGrant}`);
    metadataReads += 1;
    return await Promise.resolve(
      Response.json({
        accountId: target.scopeId,
        id: target.projectId,
        name: "owned-modeled-project",
      }),
    );
  };
  cp = await createHostedOperatorControlPlane({
    environment,
    fetch: metadataFetch,
    workloadPolicy,
  });
  await cp.assertPlanningAuthorized(context);
  assert.ok(metadataReads > 0);
  checks += 1;
  const journal = createPostgresHostedRuntimeJournalStore(database);
  const reserved = await journal.reserve({
    ...context,
    approvedByCallId: "modeled-auth-schema-approval",
    now: new Date(now),
    operator: {
      authPreparation: {
        assetSha256: "1".repeat(64),
        catalogFingerprint: "2".repeat(64),
        database: plan.authDatabase.database,
        observedAt: new Date(now).toISOString(),
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: plan.authSchema!.targetDigest,
      },
      mode: "protected-operator-v1",
      operationRef: randomUUID(),
      plan,
      planDigest,
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt: new Date(now).toISOString(),
        resourceVersion: "modeled-local-bootstrap",
      })),
    },
  });
  const prepared = await journal.compareAndSet({
    ...context,
    expectedRevision: reserved.revision,
    now: new Date(),
    record: { ...reserved.record, status: "prepared", step: "prepared" },
  });
  assert.ok(prepared);
  const linkInput = {
    audience: plan.gatewayBindings!.operatorOrigin,
    authResourceId: plan.authDatabase.resourceId,
    bootstrapPlanDigest: planDigest,
    browserOrigin: plan.gatewayBindings!.authBrowserOrigin,
    context,
    endpointOrigin: plan.deploymentBoundary!.verification.gatewayOrigin,
    expiresAt: new Date(Date.now() + 240_000).toISOString(),
    issuer: plan.deploymentBoundary!.verification.publicOrigin,
    organizationId: null,
  };
  const pending = await cp.prepareRealmIdentityLink(linkInput);
  assert.equal(digest(pending.nonce), pending.link.nonceSha256);
  assert.ok(pending.link.sealedNonce);
  assert.ok(!JSON.stringify((await journal.read(context))?.record).includes(pending.nonce));
  const reused = await cp.prepareRealmIdentityLink(linkInput);
  assert.equal(reused.nonce, pending.nonce);
  checks += 4;
  const selector = { nonceSha256: pending.link.nonceSha256, ownerSessionId: session.sessionId };
  assert.deepEqual(
    await cp.resolveRealmIdentityCallbackContext({ ...selector, authority }),
    context,
  );
  checks += 1;
  const foreignValues = {
    issuer: "https://foreign.example.test/api/auth",
    audience: "https://foreign.example.test/mcp",
    workspaceId: "foreign",
    ownerUserId: "foreign",
  };
  for (const field of ["issuer", "audience", "workspaceId", "ownerUserId"] as const) {
    await assert.rejects(
      cp.resolveRealmIdentityCallbackContext({
        ...selector,
        authority: {
          ...authority,
          [field]: foreignValues[field],
        },
      }),
    );
    checks += 1;
  }
  await database.delete(schema.member).where(eq(schema.member.id, "member_owned"));
  await assert.rejects(cp.prepareRealmIdentityLink(linkInput), /authorization_required/u);
  await assert.rejects(
    cp.resolveRealmIdentityCallbackContext({ ...selector, authority }),
    /authorization_required/u,
  );
  await database.insert(schema.member).values({
    createdAt: new Date(now),
    id: "member_owned",
    organizationId: "org_owned",
    role: "owner",
    userId: authority.ownerUserId,
  });
  checks += 2;
  await database
    .update(schema.hostedVercelInstallations)
    .set({ active: false })
    .where(eq(schema.hostedVercelInstallations.installationId, target.installationId));
  await assert.rejects(cp.prepareRealmIdentityLink(linkInput), /resource_mismatch/u);
  await database
    .update(schema.hostedVercelInstallations)
    .set({ active: true })
    .where(eq(schema.hostedVercelInstallations.installationId, target.installationId));
  checks += 1;
  const staging = await cp.readPendingRealmIdentityLinkForStaging(selector);
  realm = await openOwnedRealmSource({
    builderOrigin,
    nonce: pending.nonce,
    ownerConnection: connection("realm_migrator", "realm_db"),
    runtimeConnection: connection("realm_runtime", "realm_db"),
    sourceRoot: arrustedRoot,
    staging,
  });
  assert.equal(realm.identity.organizationId, null);
  checks += 1;
  const artifacts = createPostgresOperatorArtifactStore({
    assertCurrentOwner: async () => {
      await cp!.assertPlanningAuthorized(context);
    },
    database,
  });
  const artifactContext = {
    authority,
    target: { appId: target.appId, sessionId: target.sessionId },
  };
  const callback = createRealmIdentityCallbackHandler({
    assertCurrent: cp.assertPlanningAuthorized,
    authenticate: async (request, input) => {
      const ownerUserId = request.headers.get("x-owned-builder-user");
      return ownerUserId === null
        ? undefined
        : await cp!.resolveRealmIdentityCallbackContext({
            ...input,
            authority: { ...authority, ownerUserId },
          });
    },
    builderOrigin,
    consume: async (input) => {
      await cp!.consumeOwnerRealmIdentityCallback(input);
    },
    fetch: realm.fetch,
    keyring,
    publish: async (owned, proof) => {
      const proofSha256 = digest(proof);
      const proofRef = `_protected-operator/artifacts/realm-identity-proof/${owned.target.appId}/${proofSha256}`;
      await artifacts.put(artifactContext, {
        artifactRef: proofRef,
        chunkIndex: 0,
        content: Buffer.from(proof).toString("base64"),
      });
      return { proofRef, proofSha256 };
    },
    staging: async (input) => await cp!.readPendingRealmIdentityLinkForStaging(input),
  });
  const callbackUrl = `${builderOrigin}/api/hosted-operator/realm-identity`;
  const post = async (proof: string, nonce = pending.nonce) =>
    await callback(
      new Request(callbackUrl, {
        body: new URLSearchParams({ proof, nonce }),
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: pending.link.browserOrigin,
        },
        method: "POST",
      }),
    );
  assert.equal((await post(`${realm.proof}tampered`)).status, 401);
  assert.equal((await post(realm.proof, "0".repeat(64))).status, 401);
  assert.equal((await post(realm.foreignProof)).status, 401);
  checks += 3;
  const staged = await post(realm.proof);
  assert.equal(staged.status, 303);
  assert.equal(await cp.readCapturedRealmIdentity(context), null);
  const stagedCookie = staged.headers.get("set-cookie")?.split(";")[0];
  assert.ok(stagedCookie !== undefined && stagedCookie !== "");
  assert.ok(!stagedCookie.includes(realm.proof));
  checks += 3;
  const get = async (user = authority.ownerUserId) =>
    await callback(
      new Request(staged.headers.get("location")!, {
        headers: { cookie: stagedCookie, "x-owned-builder-user": user },
      }),
    );
  assert.equal((await get("wrong-normal-owner")).status, 401);
  assert.equal(await cp.readCapturedRealmIdentity(context), null);
  checks += 2;
  await database
    .update(schema.agentSessions)
    .set({ record: { ...session, status: "cancelled" } })
    .where(eq(schema.agentSessions.sessionId, session.sessionId));
  assert.equal((await get()).status, 401);
  await database
    .update(schema.agentSessions)
    .set({ record: session })
    .where(eq(schema.agentSessions.sessionId, session.sessionId));
  checks += 1;
  await realm.setSessionCurrent(false);
  assert.equal((await get()).status, 401);
  assert.equal(await cp.readCapturedRealmIdentity(context), null);
  await realm.setSessionCurrent(true);
  checks += 2;
  const captureResults = await Promise.all([get(), get()]);
  assert.equal(captureResults.filter((response) => response.status === 200).length, 1);
  assert.equal(captureResults.filter((response) => response.status === 401).length, 1);
  const captured = await cp.readCapturedRealmIdentity(context);
  assert.ok(captured !== null);
  assert.ok(captured.consumedAt !== undefined);
  assert.equal(captured.sealedNonce, undefined);
  assert.equal(captured.proofSha256, digest(realm.proof));
  const stored = await cp.readCapturedRealmIdentityProof(context);
  assert.equal(stored.proof, realm.proof);
  checks += 5;
  await assert.rejects(
    cp.consumeOwnerRealmIdentityCallback({
      context,
      nonceSha256: selector.nonceSha256,
      proofRef: captured.proofRef!,
      proofSha256: captured.proofSha256,
    }),
    /authorization_required/u,
  );
  assert.equal((await get()).status, 401);
  const current = await journal.read(context);
  assert.ok(current);
  assert.equal(
    await journal.compareAndSet({
      ...context,
      expectedRevision: current.revision - 1,
      now: new Date(),
      record: current.record,
    }),
    undefined,
  );
  assert.deepEqual((await journal.read(context))?.record, current.record);
  checks += 4;
  assert.equal(
    await journal.compareAndSet({
      ...context,
      authority: { ...authority, ownerUserId: "foreign" },
      record: current.record,
      expectedRevision: current.revision,
      now: new Date(),
    }),
    undefined,
  );
  await assert.rejects(
    cp.readCapturedRealmIdentityProof({
      ...context,
      authority: { ...authority, ownerUserId: "foreign" },
    }),
    /authorization_required/u,
  );
  await assert.rejects(
    artifacts.put(artifactContext, {
      artifactRef: captured.proofRef!,
      chunkIndex: 0,
      content: Buffer.from("foreign-content").toString("base64"),
    }),
    /artifact is unavailable/u,
  );
  assert.equal((await cp.readCapturedRealmIdentityProof(context)).proof, realm.proof);
  assert.deepEqual((await journal.read(context))?.record, current.record);
  checks += 5;
  await database.delete(schema.member).where(eq(schema.member.id, "member_owned"));
  await assert.rejects(cp.readCapturedRealmIdentityProof(context), /authorization_required/u);
  await assert.rejects(
    artifacts.read(artifactContext, captured.proofRef!, 0),
    /artifact is unavailable/u,
  );
  checks += 2;
  await realm.assertPreserved();
  console.log(
    `Owned PostgreSQL hosted operator Realm callback/CAS acceptance passed (${checks} checks; provider metadata modeled)`,
  );
} finally {
  await realm?.close();
  await cp?.close();
  await sql?.end({ timeout: 5 });
  if (started) {
    command("pg_ctl", ["-D", data, "-m", "immediate", "-w", "stop"]);
  }
  await rm(scratch, { force: true, recursive: true });
}
