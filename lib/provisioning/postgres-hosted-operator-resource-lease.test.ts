/* oxlint-disable eslint/require-await -- Synthetic database and journal adapters expose asynchronous production interfaces. */
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import {
  createPostgresHostedOperatorResourceLease,
  hostedOperatorVercelProjectLockKeys,
} from "./postgres-hosted-operator-resource-lease";

const now = Date.parse("2026-10-09T12:00:00.000Z");
const operationRef = "11111111-1111-4111-8111-111111111111";
const leaseId = "22222222-2222-4222-8222-222222222222";
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "reviewer", organizationId: "fixture-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
  contextId: "fixture-context",
  cost: { class: "shared-recovery-group", description: "Synthetic compute", owner: "Fixture" },
  effects: [
    {
      description: "Auth resource",
      id: "auth-resource",
      kind: "resources",
      resourceId: "auth-resource",
    },
    {
      description: "App resource",
      id: "app-resource",
      kind: "resources",
      resourceId: "app-resource",
    },
    { description: "Install", id: "install", kind: "install" },
    { description: "Grant", id: "access", kind: "access" },
    { description: "Bind", id: "bind", kind: "bindings" },
  ],
  installer: { reference: "fixture-installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_fixture",
    connectionRef: "fixture-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "fixture-neon",
    source: "synthetic-only",
  },
  release: { artifactRef: "fixture-artifact", id: "fixture-release", sha256: "b".repeat(64) },
  resourcesInstaller: { reference: "fixture-resources", sha256: "c".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "Synthetic retention" },
  selection,
  version: 1,
});
const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter_fixture",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:send"] },
    sessionId: selection.sessionId,
  },
  target: {
    ...selection,
    installationId: "icfg_fixture",
    scopeId: "team_fixture",
    scopeType: "team",
  },
};
const keyFor = (input: HostedOperatorContext) =>
  JSON.stringify([input.authority, input.target.appId, input.target.sessionId]);
const rowFor = (
  contextInput: HostedOperatorContext,
  selectedPlan: HostedOperatorPlan,
): HostedRuntimeJournalRow => ({
  record: {
    approvedByCallId: "approved",
    kind: "app-runtime",
    leaseExpiresAt: new Date(now + 60_000).toISOString(),
    leaseId,
    operator: {
      fenceGeneration: 1,
      mode: "protected-operator-v1",
      operationRef,
      plan: selectedPlan,
      planDigest: operatorPlanDigest(selectedPlan),
      receipts: [],
    },
    request: contextInput.target,
    status: "pending",
    step: "reserved",
    version: 1,
  },
  revision: 1,
});

const fixture = (selectedPlan = plan, afterLockWait?: () => Promise<void> | void) => {
  const events: string[] = [];
  const rows = new Map([[keyFor(context), rowFor(context, selectedPlan)]]);
  const store: HostedRuntimeJournalStore = {
    compareAndSet: vi.fn(),
    read: vi.fn(async (input: HostedOperatorContext) => rows.get(keyFor(input))),
    reserve: vi.fn(),
    reserveFenceGeneration: vi.fn(),
  };
  const backend = { backend_pid: 101, backend_start: "2026-10-09 11:00:00+00" };
  const acquired: string[] = [];
  const held = new Set<string>();
  const idsByKey = new Map<string, number>();
  let active = true;
  let close = vi.fn<() => void>();
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!active) throw new Error("session closed");
    const sql = strings.join("?").replaceAll(/\s+/gu, " ").trim();
    events.push(sql);
    if (sql.includes("pg_advisory_lock")) {
      const key = String(values[0]);
      acquired.push(key);
      await afterLockWait?.();
      idsByKey.set(key, acquired.length);
      held.add(`1:${acquired.length}`);
      return [];
    }
    if (sql.includes("as class_id")) {
      return [{ class_id: "1", object_id: `${idsByKey.get(String(values[0]))}` }];
    }
    if (sql.includes("from pg_stat_activity")) return [{ ...backend }];
    if (sql.includes("from pg_locks")) {
      return [
        {
          held:
            values[0] === backend.backend_pid &&
            held.has(`${String(values[1])}:${String(values[2])}`),
        },
      ];
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const end = vi.fn(async () => {
    active = false;
    held.clear();
    events.push("end");
  });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: This fixture implements the tagged-query and cleanup ports consumed by the operator lock.
  const client = Object.assign(query, { end }) as unknown as postgres.Sql;
  const lease = createPostgresHostedOperatorResourceLease({
    now: () => now,
    openLockClient: (onConnectionClosed) => {
      close = vi.fn(onConnectionClosed);
      return client;
    },
    store,
  });
  return {
    acquired,
    backend,
    disconnect() {
      active = false;
      held.clear();
      close();
    },
    end,
    events,
    held,
    input: { ...context, operationRef, plan: selectedPlan },
    lease,
    query,
    rows,
    store,
  };
};

describe("dedicated-session protected resource lease", () => {
  const gatewayPlan = () =>
    hostedOperatorPlanSchema.parse({
      ...plan,
      publicGateway: {
        projectId: "shared-gateway",
        branch: "gateway",
        origin: "https://apps.example.test",
      },
      gatewayDelivery: {
        projectId: "shared-gateway",
        branch: "gateway",
        repoId: "shared-repo",
        gitSha: "d".repeat(40),
      },
      deploymentBoundary: {
        authority,
        teamId: context.target.scopeId,
        app: {
          projectId: plan.selection.projectId,
          branch: plan.selection.branch,
          environment: "preview",
        },
        gateway: { projectId: "shared-gateway", branch: "gateway", environment: "preview" },
        operator: {
          projectId: "operator",
          deploymentId: "operator-deployment",
          environment: "preview",
        },
        verification: {
          gatewayOrigin: "https://gateway.example.test",
          jwksUrl: "https://gateway.example.test/_platform/jwks.json",
          publicOrigin: "https://apps.example.test",
        },
      },
      effects: [
        ...plan.effects,
        {
          id: "gateway-delivery",
          kind: "gateway-delivery",
          description: "Deliver the shared Gateway",
        },
      ],
    });
  it("uses the same shared Gateway fence across legacy and externally managed policy modes", () => {
    const legacy = gatewayPlan();
    const external = hostedOperatorPlanSchema.parse({
      ...legacy,
      hostProtection: {
        mode: "externally-managed-trusted-sources",
        teamId: context.target.scopeId,
        appPreview: {
          sourceProjectId: "shared-gateway",
          targetProjectId: legacy.selection.projectId,
          from: "preview",
          to: "preview",
        },
        gatewayPreview: {
          sourceProjectId: legacy.selection.projectId,
          targetProjectId: "shared-gateway",
          from: "preview",
          to: "preview",
        },
        observedAt: "2026-10-19T12:00:00Z",
        provenance: {
          kind: "administrator-provider-readback",
          reference: "synthetic-independent-readback",
        },
      },
    });
    expect(hostedOperatorVercelProjectLockKeys(external, context.target.scopeId)).toEqual(
      hostedOperatorVercelProjectLockKeys(legacy, context.target.scopeId),
    );
    const otherApp = hostedOperatorPlanSchema.parse({
      ...legacy,
      selection: { ...legacy.selection, projectId: "other-app" },
      deploymentBoundary: {
        ...legacy.deploymentBoundary,
        app: { ...legacy.deploymentBoundary!.app, projectId: "other-app" },
      },
    });
    const shared = hostedOperatorVercelProjectLockKeys(legacy, context.target.scopeId).filter(
      (key) => hostedOperatorVercelProjectLockKeys(otherApp, context.target.scopeId).includes(key),
    );
    expect(shared).toEqual([
      JSON.stringify([
        "hosted_protected_operator_vercel_project_v1",
        context.target.scopeId,
        "shared-gateway",
      ]),
    ]);
  });
  it("keeps unrelated provider projects independent of another target's lease", () => {
    const left = hostedOperatorVercelProjectLockKeys(plan, context.target.scopeId);
    const right = hostedOperatorVercelProjectLockKeys(
      hostedOperatorPlanSchema.parse({
        ...plan,
        selection: { ...plan.selection, projectId: "independent-app" },
      }),
      context.target.scopeId,
    );
    expect(left.some((key) => right.includes(key))).toBe(false);
  });
  it("keeps session advisory locks through provider work without opening a transaction", async () => {
    const test = fixture();
    let retainedFence: (() => Promise<void>) | undefined;
    const result = await test.lease(test.input, async (assertFence) => {
      retainedFence = assertFence;
      expect(test.held.size).toBe(
        6 + hostedOperatorVercelProjectLockKeys(test.input.plan, context.target.scopeId).length,
      );
      expect(test.events.some((event) => event === "begin")).toBe(false);
      expect(test.events.some((event) => event.includes("pg_advisory_lock("))).toBe(true);
      await assertFence();
      return ["first", "second"];
    });
    expect(result).toEqual(["first", "second"]);
    expect(test.events.at(-1)).toBe("end");
    expect(test.held.size).toBe(0);
    expect(
      test.query.mock.calls.some(([strings]) => strings.join("").includes("pg_advisory_unlock")),
    ).toBe(false);
    const queries = test.query.mock.calls.length;
    await expect(retainedFence?.()).rejects.toThrow("session was lost");
    expect(test.query.mock.calls.length).toBe(queries);
  });

  it("closes the lock session on callback failure while preserving separate journal state", async () => {
    const test = fixture();
    const failure = new Error("provider outcome unknown");
    await expect(
      test.lease(test.input, async (assertFence) => {
        const row = test.rows.get(keyFor(context));
        if (row?.record.operator === undefined) throw new Error("fixture row missing");
        row.record.operator.pendingEffectId = "install";
        row.record.operator.pendingEffectAttempt = { id: "33333333-3333-4333-8333-333333333333" };
        await assertFence();
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(test.events.at(-1)).toBe("end");
    expect(test.rows.get(keyFor(context))?.record.operator?.pendingEffectId).toBe("install");
  });

  it("fails closed on disconnect and rejects a callback that resumes afterward", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<() => Promise<void>>();
    const resumed = Promise.withResolvers<null>();
    const pending = test.lease(test.input, async (assertFence) => {
      entered.resolve(assertFence);
      await resumed.promise;
      await assertFence();
      return "late result";
    });
    const assertFence = await entered.promise;
    const rejected = expect(pending).rejects.toThrow("session was lost");
    test.disconnect();
    await rejected;
    await expect(assertFence()).rejects.toThrow("session was lost");
    resumed.resolve(null);
  });

  it("denies an assertion whose journal read completes after the session closes", async () => {
    const test = fixture();
    const readStarted = Promise.withResolvers<null>();
    const resumeRead = Promise.withResolvers<null>();
    let pendingAssertion: Promise<void> | undefined;
    await test.lease(test.input, async (assertFence) => {
      vi.mocked(test.store.read).mockImplementationOnce(async (input) => {
        readStarted.resolve(null);
        await resumeRead.promise;
        return test.rows.get(keyFor(input));
      });
      pendingAssertion = assertFence();
      await readStarted.promise;
      return "callback finished";
    });
    const denied = expect(pendingAssertion).rejects.toThrow("session was lost");
    resumeRead.resolve(null);
    await denied;
  });

  it("uses stable physical keys and deduplicates repeated database or role identities", async () => {
    const test = fixture();
    await test.lease(test.input, async (assertFence) => await assertFence());
    const expected = [
      ["hosted_protected_operator_database_v1", "fixture-neon", "br_fixture", "shared_auth"],
      ["hosted_protected_operator_database_v1", "fixture-neon", "br_fixture", "spend"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "shared_auth_owner"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "shared_auth_runtime"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "spend_owner"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "spend_runtime"],
      ["hosted_protected_operator_vercel_project_v1", "team_fixture", "prj_fixture"],
    ]
      .map((parts) => JSON.stringify(parts))
      .toSorted();
    expect(test.acquired).toEqual(expected);
  });

  it("compares the same physical locks across owners, apps and operation references", async () => {
    const first = fixture();
    await first.lease(first.input, async () => "first");

    const anotherContext: HostedOperatorContext = {
      ...context,
      authority: { ...authority, ownerUserId: "another-owner", workspaceId: "another-workspace" },
      target: { ...context.target, appId: "another-app", sessionId: "another-session" },
    };
    const anotherPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      neon: { ...plan.neon, connectionRef: "another-opaque-reference" },
      selection: { ...selection, appId: "another-app", sessionId: "another-session" },
    });
    const anotherOperation = "44444444-4444-4444-8444-444444444444";
    const second = fixture(anotherPlan);
    const anotherRow = rowFor(anotherContext, anotherPlan);
    if (anotherRow.record.operator === undefined) throw new Error("fixture operator missing");
    anotherRow.record.operator.operationRef = anotherOperation;
    second.rows.set(keyFor(anotherContext), anotherRow);
    await second.lease(
      { ...anotherContext, operationRef: anotherOperation, plan: anotherPlan },
      async () => "second",
    );

    expect(second.acquired).toEqual(first.acquired);
  });

  it("rechecks the journal after lock acquisition and denies a changed lease", async () => {
    const waiting = Promise.withResolvers<null>();
    const release = Promise.withResolvers<null>();
    const test = fixture(plan, async () => {
      waiting.resolve(null);
      await release.promise;
    });
    const callback = vi.fn(async () => "must not run");
    const pending = test.lease(test.input, callback);
    await waiting.promise;
    const row = test.rows.get(keyFor(context));
    if (row === undefined) throw new Error("fixture row missing");
    row.record.leaseId = "55555555-5555-4555-8555-555555555555";
    release.resolve(null);
    await expect(pending).rejects.toThrow("fence is stale");
    expect(callback).not.toHaveBeenCalled();
    expect(test.acquired).toHaveLength(6 + hostedOperatorVercelProjectLockKeys(test.input.plan, context.target.scopeId).length);
    expect(test.events.at(-1)).toBe("end");
  });

  it("retains database and provider project locks without creating bootstrap role locks", async () => {
    const existing = structuredClone(plan);
    delete existing.bootstrap;
    delete existing.resourcesInstaller;
    const existingPlan = hostedOperatorPlanSchema.parse({
      ...existing,
      effects: [
        { description: "Verify resources", id: "resources", kind: "resources" },
        ...plan.effects.filter((effect) => effect.kind !== "resources"),
      ],
    });
    const test = fixture(existingPlan);
    await test.lease(test.input, async () => "done");
    expect(
      test.acquired.filter((key) => key.startsWith('["hosted_protected_operator_database_v1",')),
    ).toHaveLength(2);
    expect(
      test.acquired.some((key) => key.startsWith('["hosted_protected_operator_role_v1",')),
    ).toBe(false);
    expect(test.acquired).toContain(
      JSON.stringify([
        "hosted_protected_operator_vercel_project_v1",
        "team_fixture",
        "prj_fixture",
      ]),
    );
  });

  it.each(["lease", "fence", "operation", "expiry"])(
    "rejects changed journal %s before a further effect",
    async (change) => {
      const test = fixture();
      const effect = vi.fn();
      await expect(
        test.lease(test.input, async (assertFence) => {
          const row = test.rows.get(keyFor(context));
          if (row?.record.operator === undefined) throw new Error("fixture row missing");
          if (change === "lease") row.record.leaseId = "55555555-5555-4555-8555-555555555555";
          if (change === "fence") row.record.operator.fenceGeneration = 2;
          if (change === "operation")
            row.record.operator.operationRef = "55555555-5555-4555-8555-555555555555";
          if (change === "expiry") row.record.leaseExpiresAt = new Date(now).toISOString();
          await assertFence();
          effect();
        }),
      ).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      expect(test.events.at(-1)).toBe("end");
    },
  );

  it.each(["backend", "lock"])("rejects lost %s authority", async (change) => {
    const test = fixture();
    const effect = vi.fn();
    await expect(
      test.lease(test.input, async (assertFence) => {
        if (change === "backend") test.backend.backend_pid += 1;
        if (change === "lock") test.held.clear();
        await assertFence();
        effect();
      }),
    ).rejects.toThrow();
    expect(effect).not.toHaveBeenCalled();
  });

  it("does not borrow another application's journal fence", async () => {
    const test = fixture();
    const callback = vi.fn();
    const anotherContext = { ...context, target: { ...context.target, appId: "other-app" } };
    await expect(test.lease({ ...anotherContext, operationRef, plan }, callback)).rejects.toThrow(
      "authority is unavailable",
    );
    expect(callback).not.toHaveBeenCalled();
    expect(test.acquired).toHaveLength(0);
  });
});
