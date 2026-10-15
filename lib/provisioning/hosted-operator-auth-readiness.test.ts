import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostedOperatorAuthReadiness } from "./hosted-operator-auth-readiness";
import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import { hostedRuntimeTargetSchema } from "./hosted-runtime-journal";

const assetSql = "source-owned readiness asset";
const assetHash = createHash("sha256").update(assetSql).digest("hex");
const plan = hostedOperatorPlanSchema.parse({
  access: [],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_migrator",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  authSchema: {
    artifactRef: "auth-frame",
    installer: { reference: "auth-installer", sha256: "f".repeat(64) },
    planDigest: "a".repeat(64),
    targetDigest: "b".repeat(64),
  },
  contextId: "fixture-context",
  cost: { class: "independent-service", description: "fixture", owner: "fixture" },
  effects: [
    { description: "resource", id: "resource", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bindings", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "app-installer", sha256: "e".repeat(64) },
  neon: {
    branchId: "branch",
    connectionRef: "private",
    endpoint: "ep-fixture.neon.tech",
    projectId: "project",
    source: "synthetic-only",
  },
  release: { artifactRef: "release", id: "v19", sha256: "d".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "fixture" },
  selection: {
    appId: "spend-review",
    branch: "feature",
    environment: "preview",
    projectId: "prj_app",
    sessionId: "session",
  },
  version: 1,
});
const context = {
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  target: hostedRuntimeTargetSchema.parse({
    ...plan.selection,
    installationId: "icfg_1",
    scopeId: "team_1",
    scopeType: "team",
  }),
};
const fixture = () => {
  const snapshot = {
    database: "auth_db",
    login: "auth_runtime",
    readiness: {
      algorithm: "pg-jsonb-catalog-sha256-v1",
      assetSha256: assetHash,
      database: "auth_db",
      observedFingerprint: "c".repeat(64),
      publishedFingerprint: "c".repeat(64),
      status: "verified",
      targetDigest: "b".repeat(64),
      version: 1,
    },
    role: "auth_runtime",
  };
  const assertAuthorized = vi.fn(async () => {
    await Promise.resolve();
  });
  const assertCurrent = vi.fn(async () => {
    await Promise.resolve();
  });
  const readSnapshot = vi.fn(async () => await Promise.resolve(snapshot));
  const readRuntimeUrl = vi.fn(
    async () =>
      await Promise.resolve(
        "postgresql://auth_runtime:fixture@ep-fixture.neon.tech/auth_db?sslmode=verify-full",
      ),
  );
  const readAuthPlan = vi.fn(
    async () =>
      await Promise.resolve(
        Buffer.from(
          JSON.stringify({
            schemaPlan: {
              effects: [{ owner: "readiness", sha256: assetHash, sql: assetSql }],
              planDigest: "a".repeat(64),
              targetDigest: "b".repeat(64),
            },
          }),
        ),
      ),
  );
  const reader = createHostedOperatorAuthReadiness({
    assertAuthorized,
    readAuthPlan,
    readRuntimeUrl,
    readSnapshot,
  });
  return {
    assertAuthorized,
    input: { ...context, assertCurrent, plan: structuredClone(plan) },
    readAuthPlan,
    readRuntimeUrl,
    readSnapshot,
    reader,
    snapshot,
  };
};

const upgradeFixture = () => {
  const f = fixture();
  const resource = {
    version: 1,
    environment: "preview",
    hostname: f.input.plan.neon.endpoint,
    port: 5432,
    database: f.input.plan.authDatabase.database,
    schema: "public",
    runtimeRole: f.input.plan.authDatabase.runtimeRole,
    migratorRole: f.input.plan.authDatabase.migratorRole,
    neon: { branchId: f.input.plan.neon.branchId, projectId: f.input.plan.neon.projectId },
  };
  const frame = {
    version: 1,
    resource,
    schemaPlan: {
      version: 1,
      resource,
      toolchain: "better-auth@1.7.3",
      history: { version: 1, schema: "_auth_schema_history", tables: ["plan", "attempt"] },
      catalogAppIds: [f.input.plan.selection.appId],
      planDigest: "a".repeat(64),
      targetDigest: "b".repeat(64),
      beforeSchemaHash: "d".repeat(64),
      effects: [
        { owner: "readiness", sha256: assetHash, sql: assetSql },
        {
          owner: "platform",
          sha256: "f".repeat(64),
          sql: "create table app_signup_policy(id text);",
        },
      ],
    },
  };
  f.readAuthPlan.mockResolvedValue(Buffer.from(JSON.stringify(frame)));
  f.snapshot.readiness.targetDigest = "e".repeat(64);
  f.snapshot.readiness.assetSha256 = "f".repeat(64);
  const repropose = vi.fn<Parameters<typeof f.reader.reconcileMigration>[1]>(
    async () => await Promise.resolve(Buffer.from(JSON.stringify(frame))),
  );
  return { ...f, frame, repropose };
};

describe("restricted Auth schema publication readiness", () => {
  it("allows the approved eight-to-nine table upgrade from a live verified base without retained journal history", async () => {
    const f = upgradeFixture();
    const result = await f.reader.reconcileMigration(f.input, f.repropose);
    expect(result.status).toBe("retryable");
    if (result.status !== "retryable") {
      throw new Error("Expected a retryable approved migration.");
    }
    expect(result.resourceVersion).toMatch(/^[a-f0-9]{64}$/u);
    expect(f.repropose).toHaveBeenCalledOnce();
    expect(f.repropose.mock.calls[0]?.[0].plan).toEqual(f.input.plan);
    expect(result).not.toHaveProperty("observed");
  });
  it("reports the actual prior publication without claiming the approved target is installed", async () => {
    const f = upgradeFixture();
    expect(await f.reader.verifyPublication(f.input)).toMatchObject({
      targetDigest: "e".repeat(64),
      assetSha256: "f".repeat(64),
    });
    await expect(f.reader.verify(f.input)).rejects.toMatchObject({ code: "operator_unavailable" });
  });
  it("returns applied on repeated reads once the newly approved target is installed", async () => {
    const f = upgradeFixture();
    f.snapshot.readiness.targetDigest = "b".repeat(64);
    f.snapshot.readiness.assetSha256 = assetHash;
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toMatchObject({
      status: "applied",
    });
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toMatchObject({
      status: "applied",
    });
    expect(f.repropose).not.toHaveBeenCalled();
  });
  it.each(["beforeSchemaHash", "targetDigest", "planDigest"] as const)(
    "keeps an upgrade unknown when fresh proposal %s differs from the frozen approval",
    async (field) => {
      const f = upgradeFixture();
      const proposed = structuredClone(f.frame);
      proposed.schemaPlan[field] = "0".repeat(64);
      f.repropose.mockResolvedValue(Buffer.from(JSON.stringify(proposed)));
      expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({
        status: "unknown",
      });
    },
  );
  it("compares the complete frozen migration effects as well as the reported digests", async () => {
    const f = upgradeFixture();
    const proposed = structuredClone(f.frame);
    proposed.schemaPlan.effects = [
      {
        owner: "platform",
        sha256: "0".repeat(64),
        sql: "alter table user add column unexpected text;",
      },
    ];
    f.repropose.mockResolvedValue(Buffer.from(JSON.stringify(proposed)));
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
  });
  it.each(["migration_in_progress", "unverified", "catalog_drift"])(
    "never retries a partial or unverified publication (%s)",
    async (status) => {
      const f = upgradeFixture();
      f.snapshot.readiness.status = status;
      expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({
        status: "unknown",
      });
      expect(f.repropose).not.toHaveBeenCalled();
    },
  );
  it("keeps an adopted target mismatch closed without reproposal", async () => {
    const f = upgradeFixture();
    f.input.plan.authAdoption = {
      kind: "owned-journal-auth-v1",
      resource: {
        authDatabase: f.input.plan.authDatabase,
        branchId: f.input.plan.neon.branchId,
        endpoint: f.input.plan.neon.endpoint,
        endpointId: "ep-fixture",
        projectId: f.input.plan.neon.projectId,
      },
      source: {
        checkpointSha256: "1".repeat(64),
        journalDigest: "2".repeat(64),
        operationRef: "00000000-0000-4000-8000-000000000001",
        planDigest: "3".repeat(64),
        selection: f.input.plan.selection,
      },
    };
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
    expect(f.repropose).not.toHaveBeenCalled();
  });
  it("keeps a fresh proposal for another physical resource unknown", async () => {
    const f = upgradeFixture();
    const proposed = structuredClone(f.frame);
    proposed.resource.database = "another_auth";
    f.repropose.mockResolvedValue(Buffer.from(JSON.stringify(proposed)));
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
  });
  it("keeps an unreadable publication unknown without invoking the proposal producer", async () => {
    const f = upgradeFixture();
    f.readSnapshot.mockRejectedValue(new Error("private connection failure"));
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
    expect(f.repropose).not.toHaveBeenCalled();
  });
  it("keeps an unreadable or failing reproposal unknown", async () => {
    const f = upgradeFixture();
    f.repropose.mockRejectedValue(new Error("private provider failure"));
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
  });
  it("rechecks the publication after the read-only reproposal", async () => {
    const f = upgradeFixture();
    f.repropose.mockImplementation(async () => {
      f.snapshot.readiness.observedFingerprint = "0".repeat(64);
      f.snapshot.readiness.publishedFingerprint = "0".repeat(64);
      return await Promise.resolve(Buffer.from(JSON.stringify(f.frame)));
    });
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
  });
  it("does not substitute a genesis proposal for an approved populated migration", async () => {
    const f = upgradeFixture();
    f.readAuthPlan.mockResolvedValue(
      Buffer.from(JSON.stringify({ ...f.frame, proposal: "new-empty" })),
    );
    expect(await f.reader.reconcileMigration(f.input, f.repropose)).toEqual({ status: "unknown" });
    expect(f.repropose).not.toHaveBeenCalled();
  });
  it("compares only the native catalog algorithm to its own publication", async () => {
    const f = fixture();
    expect(await f.reader.verify(f.input)).toMatchObject({
      assetSha256: assetHash,
      catalogFingerprint: "c".repeat(64),
      database: "auth_db",
      runtimeRole: "auth_runtime",
      targetDigest: "b".repeat(64),
    });
    expect(f.readSnapshot).toHaveBeenCalledTimes(1);
    expect(f.assertAuthorized).toHaveBeenCalledTimes(5);
  });
  it.each(["role", "login", "database"] as const)(
    "denies foreign runtime identity %s",
    async (field) => {
      const f = fixture();
      f.snapshot[field] = "foreign";
      await expect(f.reader.verify(f.input)).rejects.toMatchObject({
        code: "operator_unavailable",
      });
    },
  );
  it.each(["algorithm", "assetSha256", "targetDigest", "publishedFingerprint", "status"] as const)(
    "rejects unverified/drifting publication %s",
    async (field) => {
      const f = fixture();
      f.snapshot.readiness[field] = "foreign";
      await expect(f.reader.verify(f.input)).rejects.toMatchObject({
        code: "operator_unavailable",
      });
    },
  );
  it("never borrows a migrator URL or weak TLS to read metadata", async () => {
    const f = fixture();
    f.readRuntimeUrl.mockResolvedValue(
      "postgresql://auth_migrator:fixture@ep-fixture.neon.tech/auth_db?sslmode=require",
    );
    await expect(f.reader.verify(f.input)).rejects.toThrow();
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });
  it("captures the approved target before callers mutate it across artifact awaits", async () => {
    const f = fixture();
    const artifact = await f.readAuthPlan();
    f.readAuthPlan.mockImplementationOnce(async () => {
      f.input.plan.authDatabase.database = "foreign";
      f.input.plan.authDatabase.runtimeRole = "foreign";
      f.input.plan.neon.endpoint = "foreign.neon.tech";
      return await Promise.resolve(artifact);
    });
    expect(await f.reader.verify(f.input)).toMatchObject({
      database: "auth_db",
      runtimeRole: "auth_runtime",
      targetDigest: "b".repeat(64),
    });
  });
  it("rechecks current authority after artifact reads before obtaining runtime credentials", async () => {
    const f = fixture();
    const artifact = await f.readAuthPlan();
    f.readAuthPlan.mockImplementationOnce(async () => {
      f.input.assertCurrent.mockRejectedValue(new Error("changed checkpoint"));
      return await Promise.resolve(artifact);
    });
    await expect(f.reader.verify(f.input)).rejects.toMatchObject({ code: "operator_unavailable" });
    expect(f.readRuntimeUrl).not.toHaveBeenCalled();
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });
  it("preserves owner authorization denial before any SQL", async () => {
    const f = fixture();
    f.assertAuthorized.mockRejectedValue(new Error("revoked"));
    await expect(f.reader.verify(f.input)).rejects.toThrow();
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });
});
