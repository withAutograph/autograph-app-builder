/* oxlint-disable sonarjs/publicly-writable-directories -- The fixture owns a private temporary cluster and Unix socket; no existing database is accessed. */
/* oxlint-disable eslint/no-await-in-loop -- Table setup and state transitions are intentionally sequential. */
import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import { getTableConfig, PgDialect } from "drizzle-orm/pg-core";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Production stores require the complete Drizzle schema generic.
import * as databaseSchema from "../db/schema";
import {
  createNativeTargetAuthOnlyDispatch,
  createPostgresNativeTargetAuthOnlyDispatchStore,
} from "./native-target-auth-only-dispatch";
import { createPostgresNativeTargetAuthOnlyRuntimeStore } from "./hosted-operator-auth-only-runtime";
import type { NativeTargetAuthOnlyRuntimeStore } from "./hosted-operator-auth-only-runtime";
import { createNativeTargetAuthOnlyResourcePlanStore } from "./native-target-auth-only-resource-plan-store";
import { createPostgresNativeTargetAuthOnlyCredentialStore } from "./native-target-auth-only-credential-store";
import {
  createHostedOperatorAuthOnlyCredentials,
  authOnlyCredentialContextSchema,
} from "./hosted-operator-auth-only-credentials";
import { createNativeTargetAuthOnlyPlanStore } from "./native-target-auth-only-plan-store";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlyPlanSchema,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";

const pgTools = [
  "/Applications/Postgres.app/Contents/Versions/18/bin",
  "/Applications/Postgres.app/Contents/Versions/17/bin",
  "/opt/homebrew/opt/postgresql@18/bin",
  "/opt/homebrew/opt/postgresql@17/bin",
  "/usr/lib/postgresql/18/bin",
  "/usr/lib/postgresql/17/bin",
].find((candidate) => {
  try {
    return /PostgreSQL\) (17|18)\./u.test(
      execFileSync(path.join(candidate, "postgres"), ["--version"], {
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  } catch {
    return false;
  }
});
const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace",
  ownerUserId: "owner",
};
const source = {
  branch: "pilot",
  changeSetDigest: "c".repeat(64),
  gitSha: "d".repeat(40),
  gitTree: "e".repeat(40),
  repositoryId: "repo-fixture",
  reviewDigest: "f".repeat(64),
};
const plan = nativeTargetAuthOnlyPlanSchema.parse({
  version: 1,
  kind: "native-target-auth-only",
  appId: "signup-pilot",
  origin: {
    authority,
    publicSessionId: "saved-session",
    adapterSessionId: "native-session",
    adapterGeneration: 1,
    appSpecDigest: "a".repeat(64),
    capturedDescription: { appId: "signup-pilot", kind: "static", sha256: "b".repeat(64) },
  },
  project: {
    name: "signup-pilot",
    teamId: "team-owner",
    installationId: "icfg-owner",
    projectSettings: { framework: "nextjs", rootDirectory: "apps/signup-pilot" },
    protection: nativeTargetRequiredProjectProtection,
  },
  branch: "pilot",
  publishedSource: source,
  authResource: {
    profileId: "pilot-auth",
    authorityDigest: "b".repeat(64),
    resourceId: "isolated-auth",
    database: "pilot_auth",
    endpointId: "ep-pilot",
    hostname: "ep-pilot.neon.tech",
  },
  authSchema: {
    artifactRef: "auth-artifact",
    planDigest: "1".repeat(64),
    targetDigest: "2".repeat(64),
    installer: { reference: "auth-worker", sha256: "3".repeat(64) },
  },
  appRole: "pilot_user",
  signupPolicy: { eligibility: "approved-email-list", requireVerifiedEmail: true },
  cost: { ownership: "current-owner", description: "Auth only" },
  retention: { policy: "Explicit cleanup" },
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const approval = {
  requestId: "approval",
  callId: "call",
  planDigest,
  sourceDigest: nativeTargetAuthOnlySchemaEffectDigest(plan, source),
  responderPrincipalId: authority.ownerUserId,
  publicSessionId: plan.origin.publicSessionId,
  outcome: "approved" as const,
  observedAt: "2026-11-06T12:00:00.000Z",
};
const artifactContext = {
  authority,
  target: { appId: plan.appId, sessionId: plan.origin.publicSessionId },
};
const resource = {
  resourceId: "isolated-auth",
  database: "pilot_auth",
  migratorRole: "pilot_migrator",
  runtimeRole: "pilot_runtime",
};
const resourceBytes = Buffer.from(
  JSON.stringify({
    version: 1,
    action: "prepare",
    authOnlyPlanDigest: planDigest,
    target: {
      ...artifactContext.target,
      branch: "pilot",
      environment: "preview",
      installationId: "icfg-owner",
      projectId: "prj-pilot",
      scopeId: "team-owner",
      scopeType: "team",
    },
    nativeNeonConfiguration: {
      connector: "neon-owned",
      nativeStore: {
        configurationId: "icfg-neon",
        resourceId: "neon-store",
        sourceProjectId: "prj-anchor",
      },
      operator: {
        ownerId: "team-owner",
        projectId: "prj-operator",
        environment: "preview",
        issuer: "https://oidc.vercel.com/owner",
        audience: "https://vercel.com/owner",
      },
    },
    authDatabase: resource,
    bootstrap: { endpointId: "ep-pilot", maintenanceDatabase: "neondb", role: "bootstrap_owner" },
    neon: { endpoint: "ep-pilot.neon.tech", projectId: "pilot-project", branchId: "pilot-branch" },
    resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "b".repeat(64) },
    effects: [{ id: "auth-resources", kind: "resources", resourceId: resource.resourceId }],
  }),
);
const quote = (name: string) => `"${name.replaceAll('"', '""')}"`;
let root: string | undefined;
let started = false;
let client: ReturnType<typeof postgres>;
let database: ReturnType<typeof drizzle<typeof databaseSchema>>;
const assertCurrentOwner = async () => {};

describe.skipIf(pgTools === undefined)(
  "Auth-only journals against actual PostgreSQL constraints",
  () => {
    beforeAll(async () => {
      if (pgTools === undefined) throw new Error("Local PostgreSQL tools unavailable");
      root = await mkdtemp(path.join(tmpdir(), "auth-only-journal-pg-"));
      const data = path.join(root, "data");
      execFileSync(
        path.join(pgTools, "initdb"),
        ["-D", data, "--auth-local=trust", "--auth-host=reject", "--no-locale", "-E", "utf-8"],
        { stdio: "pipe" },
      );
      execFileSync(
        path.join(pgTools, "pg_ctl"),
        [
          "-D",
          data,
          "-l",
          path.join(root, "postgres.log"),
          "-o",
          `-h '' -k ${root} -p 54329`,
          "-w",
          "start",
        ],
        { stdio: "pipe" },
      );
      started = true;
      client = postgres({
        host: root,
        port: 54329,
        database: "postgres",
        username: userInfo().username,
        max: 3,
        ssl: false,
      });
      database = drizzle(client, { schema: databaseSchema });
      const dialect = new PgDialect();
      for (const table of [
        databaseSchema.builderProvisioningJournals,
        databaseSchema.prototypeArtifactChunks,
      ]) {
        const config = getTableConfig(table);
        const definitions = config.columns.map(
          (column) =>
            `${quote(column.name)} ${column.getSQLType()}${column.notNull ? " NOT NULL" : ""}`,
        );
        definitions.push(
          ...config.primaryKeys.map(
            (key) =>
              `CONSTRAINT ${quote(key.getName())} PRIMARY KEY (${key.columns.map((column) => quote(column.name)).join(",")})`,
          ),
          ...config.checks.map(
            (check) =>
              `CONSTRAINT ${quote(check.name)} CHECK (${dialect.sqlToQuery(check.value).sql})`,
          ),
        );
        await client.unsafe(`CREATE TABLE ${quote(config.name)} (${definitions.join(",")})`);
      }
    }, 30_000);
    afterAll(async () => {
      await client?.end({ timeout: 5 });
      if (started && root !== undefined && pgTools !== undefined)
        execFileSync(
          path.join(pgTools, "pg_ctl"),
          ["-D", path.join(root, "data"), "-m", "immediate", "-w", "stop"],
          { stdio: "pipe" },
        );
      if (root !== undefined) await rm(root, { recursive: true, force: true });
    });
    beforeEach(async () => {
      await client`TRUNCATE builder_provisioning_journal, prototype_artifact_chunk`;
    });

    it("enforces the real UUID and pending/settled constraints", async () => {
      const insert = (requestId: string, state: string) =>
        client`insert into builder_provisioning_journal (issuer,audience,workspace_id,owner_user_id,request_id,request_digest,state,revision,record,created_at,updated_at) values ('issuer','audience','workspace','owner',${requestId},${"a".repeat(64)},${state},1,'{}',now(),now())`;
      await expect(insert("b".repeat(64), "pending")).rejects.toMatchObject({
        constraint_name: "builder_provisioning_journal_request_id_check",
      });
      for (const stage of ["planned", "unknown", "retained", "sealed"])
        await expect(insert("11111111-1111-4111-a111-111111111111", stage)).rejects.toMatchObject({
          constraint_name: "builder_provisioning_journal_state_check",
        });
    });

    it("retains an unknown project write and reconciles it without a second creation", async () => {
      const store = createPostgresNativeTargetAuthOnlyDispatchStore(database);
      let creates = 0;
      const service = createNativeTargetAuthOnlyDispatch({
        store,
        authorize: async () => ({
          authority,
          ownerUserId: authority.ownerUserId,
          publicSessionId: plan.origin.publicSessionId,
        }),
        readApproval: async () => approval,
        revalidate: assertCurrentOwner,
        observeProject: async ({ projectId }) => ({ status: "verified", projectId }),
        createProject: async ({ authorizeAttempt, acceptProjectId }) => {
          await authorizeAttempt();
          creates++;
          await acceptProjectId("prj-pilot");
          return { status: "uncertain", projectId: "prj-pilot" };
        },
      });
      await service.approve("request", plan);
      await expect(service.dispatch("request", plan)).resolves.toMatchObject({ status: "unknown" });
      const key = { authority, appId: plan.appId };
      const unknown = await createPostgresNativeTargetAuthOnlyDispatchStore(database).read(key);
      expect(unknown?.state.stage).toBe("unknown");
      expect(
        (
          await client`select state, record->>'stage' as stage from builder_provisioning_journal`
        )[0],
      ).toMatchObject({ state: "pending", stage: "unknown" });
      await expect(
        store.read({ ...key, authority: { ...authority, ownerUserId: "another-owner" } }),
      ).resolves.toBeUndefined();
      if (unknown === undefined) throw new Error("Unknown project write was lost");
      await expect(
        store.compareAndSet(key, unknown.revision - 1, unknown.state),
      ).resolves.toBeUndefined();
      await expect(service.dispatch("request", plan)).resolves.toEqual({
        status: "created",
        projectId: "prj-pilot",
      });
      await expect(service.dispatch("request", plan)).resolves.toEqual({
        status: "created",
        projectId: "prj-pilot",
      });
      expect(creates).toBe(1);
      expect(
        (
          await client`select state, record->>'stage' as stage from builder_provisioning_journal`
        )[0],
      ).toMatchObject({ state: "settled", stage: "created" });
    });

    it("round-trips Auth runtime stages with UUID identity, CAS and session isolation", async () => {
      const store = createPostgresNativeTargetAuthOnlyRuntimeStore(database);
      const key = { authority, appId: plan.appId, sessionId: plan.origin.publicSessionId };
      const initial = {
        kind: "native-target-auth-only-runtime" as const,
        version: 1 as const,
        stage: "planned" as const,
        plan,
        planDigest,
        source,
      };
      let saved = await store.write(key, undefined, initial);
      expect(
        await createPostgresNativeTargetAuthOnlyRuntimeStore(database).write(
          key,
          undefined,
          initial,
        ),
      ).toEqual(saved);
      await expect(store.read({ ...key, sessionId: "another-session" })).resolves.toBeUndefined();
      const approved = {
        ...initial,
        stage: "approved" as const,
        approval,
        effectDigest: approval.sourceDigest,
      };
      const attempt = {
        ...approved,
        attemptId: "11111111-1111-4111-a111-111111111111",
        leaseId: "22222222-2222-4222-a222-222222222222",
        leaseExpiresAt: "2026-11-06T13:00:00.000Z",
      };
      const states: Parameters<NativeTargetAuthOnlyRuntimeStore["write"]>[2][] = [
        approved,
        { ...attempt, stage: "dispatching" },
        { ...attempt, stage: "unknown" },
        {
          ...attempt,
          stage: "prepared",
          authSchema: {
            artifactRef: plan.authSchema.artifactRef,
            planDigest: plan.authSchema.planDigest,
            targetDigest: plan.authSchema.targetDigest,
          },
          readiness: "ready",
        },
      ];
      for (const next of states) {
        await expect(store.compareAndSet(key, saved.revision - 1, next)).resolves.toBeUndefined();
        saved = await store.write(key, saved.revision, next);
        const [row] =
          await client`select state, record->>'stage' as stage from builder_provisioning_journal`;
        expect(row).toMatchObject({
          state: next.stage === "prepared" ? "settled" : "pending",
          stage: next.stage,
        });
      }
      expect(await store.read(key)).toEqual(saved);
      expect(
        await store.read({
          ...key,
          authority: {
            ownerUserId: authority.ownerUserId,
            workspaceId: authority.workspaceId,
            audience: authority.audience,
            issuer: authority.issuer,
          },
        }),
      ).toEqual(saved);
      await client`update builder_provisioning_journal set state='pending'`;
      await expect(store.read(key)).rejects.toThrow("runtime_mismatch");
    });

    it("retains resource plan bytes and independently binds both worker contexts", async () => {
      const store = createNativeTargetAuthOnlyResourcePlanStore({ database, assertCurrentOwner });
      const first = await store.writeIfAbsent(artifactContext, planDigest, resourceBytes);
      expect(await store.writeIfAbsent(artifactContext, planDigest, resourceBytes)).toEqual(first);
      await store.bindWorkerContext(
        artifactContext,
        planDigest,
        first.resourcePlanDigest,
        "resources",
        "4".repeat(64),
      );
      await store.bindWorkerContext(
        artifactContext,
        planDigest,
        first.resourcePlanDigest,
        "auth",
        "5".repeat(64),
      );
      expect(
        (await store.read(artifactContext, planDigest, first.resourcePlanDigest))?.workerContexts,
      ).toEqual({ resources: "4".repeat(64), auth: "5".repeat(64) });
      await expect(
        store.bindWorkerContext(
          artifactContext,
          planDigest,
          first.resourcePlanDigest,
          "auth",
          "6".repeat(64),
        ),
      ).rejects.toThrow("worker_context_conflict");
      await expect(
        store.read(
          {
            ...artifactContext,
            target: { ...artifactContext.target, sessionId: "another-session" },
          },
          planDigest,
          first.resourcePlanDigest,
        ),
      ).rejects.toThrow("resource_plan_mismatch");
      expect(
        (
          await client`select state, record->>'stage' as stage from builder_provisioning_journal`
        )[0],
      ).toMatchObject({ state: "settled", stage: "retained" });
    });

    it("preserves encrypted credential custody and retry identity with a settled row", async () => {
      const context = authOnlyCredentialContextSchema.parse({
        authority,
        appId: plan.appId,
        sessionId: plan.origin.publicSessionId,
        operationRef: "33333333-3333-4333-a333-333333333333",
        profile: { id: "pilot-auth", authorityDigest: "a".repeat(64) },
        resource: {
          ...resource,
          environment: "preview",
          neon: {
            projectId: "pilot-project",
            branchId: "pilot-branch",
            endpointId: "ep-pilot",
            hostname: "ep-pilot.neon.tech",
          },
        },
      });
      const keyring = { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture" };
      const makeCustody = () =>
        createHostedOperatorAuthOnlyCredentials({
          keyring,
          store: createPostgresNativeTargetAuthOnlyCredentialStore(database),
        });
      const assertCurrent = async () => ({
        authorityDigest: context.profile.authorityDigest,
        resource: context.resource,
      });
      const access = { context, assertCurrent };
      const credentials = { migratorPassword: "m".repeat(32), runtimePassword: "r".repeat(32) };
      const reference = await makeCustody().seal({ ...access, credentials });
      expect(await makeCustody().seal({ ...access, credentials })).toEqual(reference);
      expect(await makeCustody().readSecrets({ ...access, reference })).toEqual(credentials);
      const rows = await client`select state, record from builder_provisioning_journal`;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.state).toBe("settled");
      expect(rows[0]?.record.stage).toBe("sealed");
      for (const secret of Object.values(credentials))
        expect(JSON.stringify(rows)).not.toContain(secret);
      await expect(
        makeCustody().findReference({
          ...access,
          context: { ...context, sessionId: "another-session" },
        }),
      ).resolves.toBeNull();
    });

    it("keeps native plan artifacts in their existing session-scoped artifact table", async () => {
      const store = createNativeTargetAuthOnlyPlanStore({ database, assertCurrentOwner });
      expect(await store.record(artifactContext, plan)).toEqual(plan);
      expect(await store.read(artifactContext, plan.origin.appSpecDigest, planDigest)).toEqual(
        plan,
      );
      await expect(
        store.read(
          {
            ...artifactContext,
            target: { ...artifactContext.target, sessionId: "another-session" },
          },
          plan.origin.appSpecDigest,
          planDigest,
        ),
      ).resolves.toBeUndefined();
      expect(
        (await client`select count(*)::int as count from builder_provisioning_journal`)[0]?.count,
      ).toBe(0);
    });
  },
);
