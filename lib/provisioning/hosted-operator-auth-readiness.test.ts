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

describe("restricted Auth schema publication readiness", () => {
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
