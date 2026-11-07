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
  authority: {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    workspaceId: "workspace",
    ownerUserId: "owner",
  },
  appId: "pilot",
  sessionId: "session",
  operationRef: "11111111-1111-4111-a111-111111111111",
};
const bytes = Buffer.from(
  JSON.stringify({
    version: 1,
    kind: "native-target-auth-only-delivery",
    authOnlyPlanDigest: "a".repeat(64),
    resourcePlanDigest: "b".repeat(64),
    target: {
      appId: key.appId,
      sessionId: key.sessionId,
      environment: "preview",
      scopeType: "team",
      scopeId: "team",
      installationId: "install",
      projectId: "app",
      branch: "pilot",
    },
    source: { branch: "pilot", gitSha: "c".repeat(40), repositoryId: "repo" },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    delivery: {
      action: "prepare",
      stage: "app",
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      delivery: {
        branch: "pilot",
        gitSha: "c".repeat(40),
        projectId: "app",
        repoId: "repo",
        projectSettings: { framework: "nextjs", rootDirectory: "apps/pilot" },
      },
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
    },
  }),
);
const deliveryPlanDigest = nativeTargetAuthOnlyDeliveryPlanDigest(bytes);
const approval = {
  requestId: "approval",
  callId: "original-call",
  planDigest: deliveryPlanDigest,
  sourceDigest: deliveryPlanDigest,
  responderPrincipalId: "owner",
  publicSessionId: "session",
  outcome: "approved" as const,
  observedAt: "2026-11-06T12:00:00.000Z",
};
const candidate = (
  target: "gateway" | "app",
): OperatorDeploymentCandidate & { readyState: "READY" } => ({
  operationRef: key.operationRef,
  projectId: target,
  deploymentId: `dpl-${target}`,
  branch: target === "gateway" ? "gateway-pilot" : "pilot",
  repoId: "repo",
  origin: `https://${target}.example`,
  readyState: "READY" as const,
});
const applied = (target: "gateway" | "app") => ({
  status: "applied" as const,
  selected: candidate(target),
  candidates: [candidate(target)],
});
const retryable = { status: "retryable" as const, candidates: [], resourceVersion: "e".repeat(64) };

it("keeps callback and running-lease readiness modes separate and fenced", () => {
  const gateway = candidate("gateway");
  const running = {
    kind: "native-target-auth-only-delivery" as const,
    version: 1 as const,
    operationRef: key.operationRef,
    deliveryPlanDigest,
    planBase64: bytes.toString("base64"),
    phase: "running" as const,
    approval,
    fenceGeneration: 7,
    lease: {
      id: "22222222-2222-4222-a222-222222222222",
      expiresAt: "2026-11-06T12:01:00.000Z",
    },
    gateway: { attempted: true, candidates: [gateway], receipt: gateway },
    app: { attempted: false, candidates: [] },
  };
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: running,
      gateway,
      runningLease: { fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: running,
      gateway,
      runningLease: { fenceGeneration: 6 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: running,
      gateway,
      runningLease: { fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:02:00.000Z"),
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: running,
      gateway: candidate("app"),
      runningLease: { fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: {
        ...running,
        app: { attempted: true, candidates: [candidate("app")], receipt: candidate("app") },
      },
      gateway,
      runningLease: { fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(true);
  expect(nativeTargetAuthOnlyDeliveryAllowsReadyBinding({ record: running, gateway })).toBe(false);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: { ...running, phase: "pending-owner", lease: undefined },
      gateway,
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: {
        ...running,
        phase: "prepared",
        app: { attempted: true, candidates: [candidate("app")], receipt: candidate("app") },
      },
      gateway,
      entryMode: { mode: "fenced", fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: { ...running, phase: "prepared", lease: undefined },
      gateway,
      entryMode: { mode: "retained", fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(true);
  expect(
    nativeTargetAuthOnlyDeliveryAllowsReadyBinding({
      record: { ...running, phase: "unknown", app: { attempted: true, candidates: [] } },
      gateway,
      entryMode: { mode: "fenced", fenceGeneration: 7 },
      now: Date.parse("2026-11-06T12:00:00.000Z"),
    }),
  ).toBe(false);
});

const routingOperationRef = "33333333-3333-4333-a333-333333333333";
const routingBytes = Buffer.from(
  JSON.stringify({
    version: 1,
    kind: "native-target-auth-only-final-routing",
    operationRef: routingOperationRef,
    deliveryOperationRef: key.operationRef,
    deliveryPlanDigest,
    target: JSON.parse(bytes.toString()).target,
    gateway: {
      projectId: "gateway",
      repoId: "repo",
      branch: "gateway-pilot",
      gitRef: "gateway-pilot",
      gitSha: "d".repeat(40),
      publicOrigin: "https://pilot.example",
    },
    bootstrap: candidate("gateway"),
    app: candidate("app"),
    source: {
      environment: "preview",
      ownerId: "team",
      projectId: "gateway",
      audience: "https://vercel.com/team",
      issuer: "https://oidc.vercel.com/team",
      subject: "gateway",
      publicOrigin: "https://pilot.example",
    },
    projection: {
      operationRef: key.operationRef,
      deliveryPlanDigest,
      gatewayProjectId: "gateway",
      physicalBranch: "gateway-pilot",
      rowId: "env-projection",
      appDeploymentId: "dpl-app",
      priorSha256: "1".repeat(64),
      nextSha256: "2".repeat(64),
    },
  }),
);
const routingProposal = {
  appId: key.appId,
  operationRef: key.operationRef,
  deliveryPlanDigest,
  routingOperationRef,
  routingPlanDigest: nativeTargetAuthOnlyFinalRoutingPlanDigest(routingBytes),
};

const fixture = async () => {
  type Row = {
    requestId: string;
    requestDigest: string;
    revision: number;
    record: unknown;
    state: string;
  };
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
    insert: () => ({
      values: (row: Row) => ({
        onConflictDoNothing: async () => {
          validate(row);
          if (!rows.has(row.requestId)) rows.set(row.requestId, structuredClone(row));
        },
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
  const store = createPostgresNativeTargetAuthOnlyDeliveryStore(database as never);
  await store.retain(key, bytes);
  const reconcile = {
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
  };
  const deliver = {
    gateway: vi.fn(async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) =>
      applied("gateway"),
    ),
    app: vi.fn(async (_context: NativeTargetAuthOnlyPreviewDeliveryInput) => applied("app")),
  };
  const afterGatewayReady = vi.fn(async () => ({
    status: "ready" as const,
    organizationId: "pilot-org",
    signupPolicyDigest: "f".repeat(64),
  }));
  const assertCurrent = vi.fn(async () => {});
  const run = (
    gate: Parameters<
      typeof prepareNativeTargetAuthOnlyDelivery
    >[0]["afterGatewayReady"] = afterGatewayReady,
  ) =>
    prepareNativeTargetAuthOnlyDelivery({
      store,
      key,
      approval,
      assertCurrent,
      afterGatewayReady: gate,
      prepareFinalRoutingPlan: async () => routingBytes,
      adapter: (target) => ({ reconcile: reconcile[target], deliver: deliver[target] }),
    });
  return { store, rows, reconcile, deliver, afterGatewayReady, assertCurrent, run };
};

it("persists valid UUID/pending-settled journal rows and exact bytes; stale CAS and other owner/session cannot replace them", async () => {
  const f = await fixture();
  const saved = (await f.store.read(key))!;
  expect(await f.store.retain(key, bytes)).toEqual(saved);
  await expect(
    f.store.retain(key, Buffer.from(bytes.toString().replace('"pilot-org"', '"other"') + " ")),
  ).rejects.toThrow("resource_mismatch");
  expect(
    await f.store.read({ ...key, authority: { ...key.authority, ownerUserId: "other" } }),
  ).toBeUndefined();
  expect(await f.store.read({ ...key, sessionId: "other" })).toBeUndefined();
  expect(await f.store.compareAndSet(key, 0, saved.record)).toBeUndefined();
  const result = await f.run();
  expect(result).toMatchObject({
    status: "routing-required",
    gateway: candidate("gateway"),
    app: candidate("app"),
  });
  expect([...f.rows.values()][0].state).toBe("pending");
});

it("retains the verified Gateway receipt and yields only the owner link before app deployment", async () => {
  const f = await fixture();
  const pending = {
    status: "pending-owner" as const,
    authIdentityLink: "https://gateway.example/auth/link",
    authIdentityLinkExpiresAt: new Date(Date.now() + 60000).toISOString(),
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
      id: "22222222-2222-4222-a222-222222222222",
      expiresAt: new Date(Date.now() + 60000).toISOString(),
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
    store: f.store,
    key,
    approval,
    assertCurrent: f.assertCurrent,
    afterGatewayReady: f.afterGatewayReady,
    prepareFinalRoutingPlan: vi.fn(async () => routingBytes),
    adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
  });
  expect(result).toMatchObject({
    status: "routing-required",
    finalRoutingPlan: routePlan,
    gateway: candidate("gateway"),
    app: candidate("app"),
  });
  const pending = (await f.store.read(key))!;
  expect(pending.record.phase).toBe("routing-pending");
  const routed = await withNativeTargetAuthOnlyFinalRoutingLease({
    store: f.store,
    key,
    deliveryPlanDigest,
    approval,
    gateway: candidate("gateway"),
    app: candidate("app"),
    run: async ({ fenceGeneration, assertCurrent }) => {
      expect(fenceGeneration).toBe(pending.record.fenceGeneration + 1);
      await assertCurrent();
      return { status: "routed" };
    },
  });
  expect(routed).toEqual({ status: "routed" });
  expect((await f.store.read(key))?.record.phase).toBe("prepared");
});

it("does not publish prepared when the separately approved Gateway route is uncertain", async () => {
  const f = await fixture();
  await prepareNativeTargetAuthOnlyDelivery({
    store: f.store,
    key,
    approval,
    assertCurrent: f.assertCurrent,
    afterGatewayReady: f.afterGatewayReady,
    prepareFinalRoutingPlan: async () => routingBytes,
    adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
  });
  await expect(
    withNativeTargetAuthOnlyFinalRoutingLease({
      store: f.store,
      key,
      deliveryPlanDigest,
      approval,
      gateway: candidate("gateway"),
      app: candidate("app"),
      run: async () => {
        throw new Error("reconciliation_required");
      },
    }),
  ).rejects.toThrow("reconciliation_required");
  expect((await f.store.read(key))?.record.phase).toBe("unknown-final");
});

it("rechecks entry readiness before app provider work and rejects revocation", async () => {
  const f = await fixture();
  let checks = 0;
  await expect(
    f.run(async () => {
      if (++checks > 1)
        return {
          status: "pending-owner",
          authIdentityLink: "https://gateway.example/auth/link",
          authIdentityLinkExpiresAt: new Date(Date.now() + 60000).toISOString(),
        };
      return { status: "ready", organizationId: "pilot-org", signupPolicyDigest: "f".repeat(64) };
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
      phase,
      lease: undefined,
    });
    f.reconcile.gateway.mockClear();
    f.reconcile.app.mockClear();
    f.deliver.gateway.mockClear();
    f.deliver.app.mockClear();
    const builder = vi.fn(async () => {
      throw new Error("must reuse retained plan");
    });
    const replay = await prepareNativeTargetAuthOnlyDelivery({
      store: f.store,
      key,
      approval,
      assertCurrent: f.assertCurrent,
      afterGatewayReady: f.afterGatewayReady,
      prepareFinalRoutingPlan: builder,
      adapter: (target) => ({ reconcile: f.reconcile[target], deliver: f.deliver[target] }),
    });
    expect(replay).toMatchObject({ status: "routing-required", finalRoutingPlan: routingProposal });
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
      store: f.store,
      key,
      deliveryPlanDigest,
      approval,
      gateway: candidate("gateway"),
      app: candidate("app"),
      run: async () => ({ status: "prepared" }),
      withExecutionLease: async (_, complete) =>
        await complete(async () => {
          throw new Error("physical fence lost");
        }),
    }),
  ).rejects.toThrow("physical fence lost");
  expect((await f.store.read(key))!.record.phase).toBe("unknown-final");
  expect([...f.rows.values()][0].state).toBe("pending");
});
