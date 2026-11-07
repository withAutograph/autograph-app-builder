import { expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { OperatorDeploymentCandidate } from "./hosted-operator-contract";
import {
  createPostgresNativeTargetAuthOnlyDeliveryStore,
  nativeTargetAuthOnlyDeliveryAllowsReadyBinding,
  prepareNativeTargetAuthOnlyDelivery,
  withNativeTargetAuthOnlyFinalRoutingLease,
} from "./native-target-auth-only-delivery-runtime";
import { nativeTargetAuthOnlyFinalRoutingPlanDigest } from "./native-target-auth-only-final-routing";
import { nativeTargetAuthOnlyDeliveryPlanDigest } from "./native-target-auth-only-delivery-plan";
import type { NativeTargetAuthOnlyPreviewDeliveryInput } from "./native-target-auth-only-preview-delivery";

const key = {
  appId: "pilot",
  authority: {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  },
  operationRef: "11111111-1111-4111-a111-111111111111",
  sessionId: "session",
};
const bytes = Buffer.from(
  JSON.stringify({
    authOnlyPlanDigest: "a".repeat(64),
    delivery: {
      action: "prepare",
      delivery: {
        branch: "pilot",
        gitSha: "c".repeat(40),
        projectId: "app",
        projectSettings: { framework: "nextjs", rootDirectory: "apps/pilot" },
        repoId: "repo",
      },
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      gatewayDelivery: {
        branch: "gateway-pilot",
        gitRef: "gateway-pilot",
        gitSha: "d".repeat(40),
        projectId: "gateway",
        repoId: "repo",
      },
      publicGateway: {
        authBrowserOrigin: "https://auth-browser.example.test",
        branch: "gateway-pilot",
        gatewayOrigin: "https://gateway.example.test",
        origin: "https://pilot.example",
        projectId: "gateway",
      },
      stage: "app",
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    kind: "native-target-auth-only-delivery",
    resourcePlanDigest: "b".repeat(64),
    source: { branch: "pilot", gitSha: "c".repeat(40), repositoryId: "repo" },
    target: {
      appId: key.appId,
      branch: "pilot",
      environment: "preview",
      installationId: "install",
      projectId: "app",
      scopeId: "team",
      scopeType: "team",
      sessionId: key.sessionId,
    },
    version: 1,
  }),
);
const deliveryPlanDigest = nativeTargetAuthOnlyDeliveryPlanDigest(bytes);
const approval = {
  callId: "original-call",
  observedAt: "2026-11-06T12:00:00.000Z",
  outcome: "approved" as const,
  planDigest: deliveryPlanDigest,
  publicSessionId: "session",
  requestId: "approval",
  responderPrincipalId: "owner",
  sourceDigest: deliveryPlanDigest,
};
const candidate = (
  target: "gateway" | "app",
): OperatorDeploymentCandidate & { readyState: "READY" } => ({
  branch: target === "gateway" ? "gateway-pilot" : "pilot",
  deploymentId: `dpl-${target}`,
  operationRef: key.operationRef,
  origin: `https://${target}.example`,
  projectId: target,
  readyState: "READY" as const,
  repoId: "repo",
});
const applied = (target: "gateway" | "app") => ({
  candidates: [candidate(target)],
  selected: candidate(target),
  status: "applied" as const,
});
const retryable = { candidates: [], resourceVersion: "e".repeat(64), status: "retryable" as const };

it("keeps callback and running-lease readiness modes separate and fenced", () => {
  const gateway = candidate("gateway");
  const running = {
    app: { attempted: false, candidates: [] },
    approval,
    deliveryPlanDigest,
    fenceGeneration: 7,
    gateway: { attempted: true, candidates: [gateway], receipt: gateway },
    kind: "native-target-auth-only-delivery" as const,
    lease: {
      expiresAt: "2026-11-06T12:01:00.000Z",
      id: "22222222-2222-4222-a222-222222222222",
    },
    operationRef: key.operationRef,
    phase: "running" as const,
    planBase64: bytes.toString("base64"),
    version: 1 as const,
  };
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: running,
      runningLease: { fenceGeneration: 7 },
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: running,
      runningLease: { fenceGeneration: 6 },
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway,
      now: Date.parse("2026-11-06T12:02:00.000Z"),
      record: running,
      runningLease: { fenceGeneration: 7 },
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway: candidate("app"),
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: running,
      runningLease: { fenceGeneration: 7 },
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: {
        ...running,
        app: { attempted: true, candidates: [candidate("app")], receipt: candidate("app") },
      },
      runningLease: { fenceGeneration: 7 },
    }),
  ).toBe(true);
  expect(nativeTargetAuthOnlyDeliveryAllowsReadyBinding({ gateway, record: running })).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      gateway,
      record: { ...running, lease: undefined, phase: "pending-owner" },
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      entryMode: { fenceGeneration: 7, mode: "fenced" },
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: {
        ...running,
        app: { attempted: true, candidates: [candidate("app")], receipt: candidate("app") },
        phase: "prepared",
      },
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      entryMode: { fenceGeneration: 7, mode: "retained" },
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: { ...running, lease: undefined, phase: "prepared" },
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      entryMode: { fenceGeneration: 7, mode: "fenced" },
      gateway,
      now: Date.parse("2026-11-06T12:00:00.000Z"),
      record: { ...running, app: { attempted: true, candidates: [] }, phase: "unknown" },
    }),
  ).toBe(false);
});

const routingOperationRef = "33333333-3333-4333-a333-333333333333";
const routingBytes = Buffer.from(
  JSON.stringify({
    app: candidate("app"),
    bootstrap: candidate("gateway"),
    deliveryOperationRef: key.operationRef,
    deliveryPlanDigest,
    gateway: {
      branch: "gateway-pilot",
      gitRef: "gateway-pilot",
      gitSha: "d".repeat(40),
      projectId: "gateway",
      publicOrigin: "https://pilot.example",
      repoId: "repo",
    },
    kind: "native-target-auth-only-final-routing",
    operationRef: routingOperationRef,
    projection: {
      appDeploymentId: "dpl-app",
      deliveryPlanDigest,
      gatewayProjectId: "gateway",
      nextSha256: "2".repeat(64),
      operationRef: key.operationRef,
      physicalBranch: "gateway-pilot",
      priorSha256: "1".repeat(64),
      rowId: "env-projection",
    },
    source: {
      audience: "https://vercel.com/team",
      environment: "preview",
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "gateway",
      publicOrigin: "https://pilot.example",
      subject: "gateway",
    },
    target: JSON.parse(bytes.toString()).target,
    version: 1,
  }),
);
const routingProposal = {
  appId: key.appId,
  deliveryPlanDigest,
  operationRef: key.operationRef,
  routingOperationRef,
  routingPlanDigest: nativeTargetAuthOnlyFinalRoutingPlanDigest(routingBytes),
};

const fixture = async () => {
  interface Row {
    requestId: string;
    requestDigest: string;
    revision: number;
    record: unknown;
    state: string;
  }
  const rows = new Map<string, Row>();
  const parameters = (where: SQL) => new PgDialect().sqlToQuery(where).params;
  const validate = (row: Row) => {
    expect(row.requestId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    expect(row.requestDigest).toMatch(/^[0-9a-f]{64}$/u);
    expect(["pending", "settled"]).toContain(row.state);
    expect(row.revision).toBeGreaterThan(0);
  };
  const database = {
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoNothing: async () => {
          validate(row);
          if (!rows.has(row.requestId)) rows.set(row.requestId, structuredClone(row));
        },
      }),
    }),
    select: () => ({
      from: () => ({
        where: (where: SQL) => ({
          limit: async () => {
            const row = rows.get(String(parameters(where)[4]));
            return row === undefined ? [] : [structuredClone(row)];
          },
        }),
      }),
    }),
    update: () => ({
      set: (change: Partial<Row>) => ({
        where: (where: SQL) => ({
          returning: async () => {
            const params = parameters(where);
            const row = rows.get(String(params[4]));
            if (row === undefined || row.revision !== params[5] || row.requestDigest !== params[6])
              return [];
            const next = { ...row, ...change };
            validate(next);
            rows.set(row.requestId, structuredClone(next));
            return [structuredClone(next)];
          },
        }),
      }),
    }),
  };
  const store = createPostgresNativeTargetAuthOnlyDeliveryStore(database);
  await store.retain(key, bytes);
  const reconcile = {
    app: vi.fn(
      async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) =>
        retryable as Awaited<
          ReturnType<
            ReturnType<
              typeof import("./native-target-auth-only-preview-delivery").createNativeTargetAuthOnlyPreviewDelivery
            >["reconcile"]
          >
        >,
    ),
    gateway: vi.fn(
      async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) =>
        retryable as Awaited<
          ReturnType<
            ReturnType<
              typeof import("./native-target-auth-only-preview-delivery").createNativeTargetAuthOnlyPreviewDelivery
            >["reconcile"]
          >
        >,
    ),
  };
  const deliver = {
    app: vi.fn(async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) => applied("app")),
    gateway: vi.fn(async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) =>
      applied("gateway"),
    ),
  };
  const afterGatewayReady = vi.fn(async () => ({
    organizationId: "pilot-org",
    signupPolicyDigest: "f".repeat(64),
    status: "ready" as const,
  }));
  const assertCurrent = vi.fn(async () => {});
  const run = async (
    gate: Parameters<
      typeof prepareNativeTargetAuthOnlyDelivery
    >[0]["afterGatewayReady"] = afterGatewayReady,
  ) =>
    prepareNativeTargetAuthOnlyDelivery({
      adapter: (target) => ({ reconcile: reconcile[target], deliver: deliver[target] }),
      afterGatewayReady: gate,
      approval,
      assertCurrent,
      key,
      prepareFinalRoutingPlan: async () => routingBytes,
      store,
    });
  return { afterGatewayReady, assertCurrent, deliver, reconcile, rows, run, store };
};

it("persists valid UUID/pending-settled journal rows and exact bytes; stale CAS and other owner/session cannot replace them", async () => {
  const f = await fixture();
  const saved = (await f.store.read(key))!;
  expect(await f.store.retain(key, bytes)).toEqual(saved);
  await expect(
    f.store.retain(key, Buffer.from(`${bytes.toString().replace('"pilot-org"', '"other"')} `)),
  ).rejects.toThrow("resource_mismatch");
  expect(
    await f.store.read({ ...key, authority: { ...key.authority, ownerUserId: "other" } }),
  ).toBeUndefined();
  expect(await f.store.read({ ...key, sessionId: "other" })).toBeUndefined();
  expect(await f.store.compareAndSet(key, 0, saved.record)).toBeUndefined();
  const result = await f.run();
  expect(result).toMatchObject({
    app: candidate("app"),
    gateway: candidate("gateway"),
    status: "routing-required",
  });
  expect([...f.rows.values()][0].state).toBe("pending");
});

it("retains the verified Gateway receipt and yields only the owner link before app deployment", async () => {
  const f = await fixture();
  const pending = {
    authIdentityLink: "https://gateway.example/auth/link",
    authIdentityLinkExpiresAt: new Date(Date.now() + 60000).toISOString(),
    status: "pending-owner" as const,
  };
  expect(
    await f.run(async (input) => {
      expect(input.gateway).toEqual(candidate("gateway"));
      return pending;
    }),
  ).toEqual({ ...pending, deliveryPlanDigest });
  const row = (await f.store.read(key))!;
  expect(row.record.gateway.receipt).toEqual(candidate("gateway"));
  expect(row.record.phase).toBe("pending-owner");
  expect(f.reconcile.app).not.toHaveBeenCalled();
  expect(f.deliver.app).not.toHaveBeenCalled();
  f.reconcile.gateway.mockResolvedValue(applied("gateway"));
  await expect(f.run()).resolves.toMatchObject({ status: "routing-required" });
  expect(f.deliver.gateway).toHaveBeenCalledTimes(1);
});

it("reconciles a lost create response without creating another deployment", async () => {
  const f = await fixture();
  f.deliver.gateway.mockRejectedValueOnce(new Error("lost response"));
  await expect(f.run()).rejects.toThrow("lost response");
  expect((await f.store.read(key))!.record.gateway.attempted).toBe(true);
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.deliver.gateway).toHaveBeenCalledTimes(1);
  f.reconcile.gateway.mockResolvedValue(applied("gateway"));
  await expect(f.run()).resolves.toMatchObject({ status: "routing-required" });
  expect(f.deliver.gateway).toHaveBeenCalledTimes(1);
});

it("does not acquire an active lease and rejects source/project mismatch in provider receipts", async () => {
  const f = await fixture();
  const row = (await f.store.read(key))!;
  await f.store.compareAndSet(key, row.revision, {
    ...row.record,
    lease: {
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      id: "22222222-2222-4222-a222-222222222222",
    },
  });
  await expect(f.run()).rejects.toThrow("reconciliation_required");
  expect(f.reconcile.gateway).not.toHaveBeenCalled();
  const g = await fixture();
  g.deliver.gateway.mockResolvedValue({
    ...applied("gateway"),
    selected: { ...candidate("gateway"), projectId: "unrelated" },
  });
  await expect(g.run()).rejects.toThrow("resource_mismatch");
  expect(g.deliver.app).not.toHaveBeenCalled();
});

it("holds prepared settlement behind a separate Gateway routing lease", async () => {
  const f = await fixture();
  const routePlan = routingProposal;
  const result = await prepareNativeTargetAuthOnlyDelivery({
    adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
    afterGatewayReady: f.afterGatewayReady,
    approval,
    assertCurrent: f.assertCurrent,
    key,
    prepareFinalRoutingPlan: vi.fn(async () => routingBytes),
    store: f.store,
  });
  expect(result).toMatchObject({
    app: candidate("app"),
    finalRoutingPlan: routePlan,
    gateway: candidate("gateway"),
    status: "routing-required",
  });
  const pending = (await f.store.read(key))!;
  expect(pending.record.phase).toBe("routing-pending");
  const routed = await withNativeTargetAuthOnlyFinalRoutingLease({
    app: candidate("app"),
    approval,
    deliveryPlanDigest,
    gateway: candidate("gateway"),
    key,
    run: async ({ fenceGeneration, assertCurrent }) => {
      expect(fenceGeneration).toBe(pending.record.fenceGeneration + 1);
      await assertCurrent();
      return { status: "routed" };
    },
    store: f.store,
  });
  expect(routed).toEqual({ status: "routed" });
  expect((await f.store.read(key))?.record.phase).toBe("prepared");
});

it("does not publish prepared when the separately approved Gateway route is uncertain", async () => {
  const f = await fixture();
  await prepareNativeTargetAuthOnlyDelivery({
    adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
    afterGatewayReady: f.afterGatewayReady,
    approval,
    assertCurrent: f.assertCurrent,
    key,
    prepareFinalRoutingPlan: async () => routingBytes,
    store: f.store,
  });
  await expect(
    withNativeTargetAuthOnlyFinalRoutingLease({
      app: candidate("app"),
      approval,
      deliveryPlanDigest,
      gateway: candidate("gateway"),
      key,
      run: async () => {
        throw new Error("reconciliation_required");
      },
      store: f.store,
    }),
  ).rejects.toThrow("reconciliation_required");
  expect((await f.store.read(key))?.record.phase).toBe("unknown-final");
});

it("rechecks entry readiness before app provider work and rejects revocation", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    f.run(async () => {
      if (++checks > 1) {
        return {
          status: "pending-owner",
          authIdentityLink: "https://gateway.example/auth/link",
          authIdentityLinkExpiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      }
      return { organizationId: "pilot-org", signupPolicyDigest: "f".repeat(64), status: "ready" };
    }),
  ).rejects.toThrow("auth_identity_required");
  expect(f.reconcile.app).not.toHaveBeenCalled();
});

it("a routing retry preserves bootstrap and fails closed when current approval is denied", async () => {
  const f = await fixture();
  await f.run();
  f.reconcile.gateway.mockResolvedValue(applied("gateway"));
  f.reconcile.app.mockResolvedValue(applied("app"));
  await f.run();
  expect(f.deliver.gateway).toHaveBeenCalledTimes(1);
  expect(f.deliver.app).toHaveBeenCalledTimes(1);
  f.assertCurrent.mockRejectedValue(new Error("owner revoked"));
  await expect(f.run()).rejects.toThrow("owner revoked");
  expect(f.reconcile.gateway).toHaveBeenCalledTimes(1);
});

it.each(["routing-pending", "unknown-final", "running-final", "prepared"] as const)(
  "replays %s through retained routing without bootstrap, app or plan effects",
  async (phase) => {
    const f = await fixture();
    await f.run();
    const retained = (await f.store.read(key))!;
    await f.store.compareAndSet(key, retained.revision, {
      ...retained.record,
      lease: undefined,
      phase,
    });
    f.reconcile.gateway.mockClear();
    f.reconcile.app.mockClear();
    f.deliver.gateway.mockClear();
    f.deliver.app.mockClear();
    const builder = vi.fn(async () => {
      throw new Error("must reuse retained plan");
    });
    const replay = await prepareNativeTargetAuthOnlyDelivery({
      adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
      afterGatewayReady: f.afterGatewayReady,
      approval,
      assertCurrent: f.assertCurrent,
      key,
      prepareFinalRoutingPlan: builder,
      store: f.store,
    });
    expect(replay).toMatchObject({ finalRoutingPlan: routingProposal, status: "routing-required" });
    expect(builder).not.toHaveBeenCalled();
    expect(f.reconcile.gateway).not.toHaveBeenCalled();
    expect(f.reconcile.app).not.toHaveBeenCalled();
    expect(f.deliver.gateway).not.toHaveBeenCalled();
    expect(f.deliver.app).not.toHaveBeenCalled();
    expect((await f.store.read(key))!.record.gateway.receipt).toEqual(candidate("gateway"));
  },
);

it("does not settle parent after the held physical Gateway fence is lost", async () => {
  const f = await fixture();
  await f.run();
  await expect(
    withNativeTargetAuthOnlyFinalRoutingLease({
      app: candidate("app"),
      approval,
      deliveryPlanDigest,
      gateway: candidate("gateway"),
      key,
      run: async () => ({ status: "prepared" }),
      store: f.store,
      withExecutionLease: async (_, complete) =>
        await complete(async () => {
          throw new Error("physical fence lost");
        }),
    }),
  ).rejects.toThrow("physical fence lost");
  expect((await f.store.read(key))!.record.phase).toBe("unknown-final");
  expect([...f.rows.values()][0].state).toBe("pending");
});
