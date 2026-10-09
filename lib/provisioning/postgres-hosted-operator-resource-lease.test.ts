/* oxlint-disable eslint/require-await -- Synthetic database and journal adapters expose asynchronous production interfaces. */
import type postgres from "postgres";
import { describe, expect, it, vi } from "vitest";

import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { createPostgresHostedOperatorResourceLease } from "./postgres-hosted-operator-resource-lease";

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

const fixture = (selectedPlan = plan) => {
  const events: string[] = [];
  const rows = new Map([[keyFor(context), rowFor(context, selectedPlan)]]);
  const store: HostedRuntimeJournalStore = {
    compareAndSet: vi.fn(),
    read: vi.fn(async (input: HostedOperatorContext) => rows.get(keyFor(input))),
    reserve: vi.fn(),
    reserveFenceGeneration: vi.fn(),
  };
  const backend = { backend_pid: 101, backend_start: "2026-10-09T11:00:00.000Z" };
  const acquired: string[] = [];
  const held = new Set<string>();
  let active = false;
  let close = vi.fn<() => void>();
  const disconnect = Promise.withResolvers<never>();
  const query = vi.fn(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (!active) {
      throw new Error("transaction closed");
    }
    const sql = strings.join("?").replaceAll(/\s+/gu, " ").trim();
    events.push(sql);
    if (sql.includes("pg_advisory_xact_lock")) {
      const key = String(values[0]);
      acquired.push(key);
      held.add(`${acquired.length}`);
      return [];
    }
    if (sql.includes("as class_id")) {
      return [{ class_id: "1", object_id: `${acquired.length}` }];
    }
    if (sql.includes("from pg_locks")) {
      return [{ held: values[0] === backend.backend_pid && held.has(String(values[2])) }];
    }
    if (sql === "set local idle_in_transaction_session_timeout = 0") {
      return [];
    }
    throw new Error(`Unexpected fixture query: ${sql}`);
  });
  const unsafe = vi.fn(async () => {
    if (!active) {
      throw new Error("transaction closed");
    }
    events.push("backend identity");
    return [{ ...backend }];
  });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: Only the fixture's implemented tagged-query and unsafe ports are used by the lease.
  const transaction = Object.assign(query, { unsafe }) as unknown as postgres.TransactionSql;
  const begin = vi.fn(async <T>(run: (sql: postgres.TransactionSql) => Promise<T>) => {
    events.push("begin");
    active = true;
    try {
      const result = await Promise.race([run(transaction), disconnect.promise]);
      events.push("commit");
      return result;
    } catch (error) {
      events.push("rollback");
      throw error;
    } finally {
      active = false;
      held.clear();
    }
  });
  const end = vi.fn(async () => {
    expect(active).toBe(false);
    expect(held.size).toBe(0);
    events.push("end");
  });
  // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- SAFETY: This fixture implements exactly the BEGIN and cleanup ports consumed by the operation-owned client.
  const client = { begin, end } as unknown as postgres.Sql;
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
    begin,
    disconnect() {
      close();
      active = false;
      held.clear();
      disconnect.reject(new Error("fixture connection lost"));
    },
    end,
    events,
    held,
    input: { ...context, operationRef, plan: selectedPlan },
    lease,
    query,
    rows,
    store,
    unsafe,
  };
};

describe("pooled protected resource lease", () => {
  it("holds transaction locks throughout the callback and commits before client cleanup", async () => {
    const test = fixture();
    let retainedFence: (() => Promise<void>) | undefined;
    const result = await test.lease(test.input, async (assertFence) => {
      retainedFence = assertFence;
      expect(test.held.size).toBe(6);
      expect(test.events).not.toContain("commit");
      await assertFence();
      return ["first", "second"];
    });
    expect(result).toEqual(["first", "second"]);
    expect(test.events[0]).toBe("begin");
    expect(test.events[1]).toBe("set local idle_in_transaction_session_timeout = 0");
    expect(test.events.slice(-2)).toEqual(["commit", "end"]);
    expect(test.end).toHaveBeenCalledWith({ timeout: 0 });
    const queries = test.query.mock.calls.length + test.unsafe.mock.calls.length;
    await expect(retainedFence?.()).rejects.toThrow("session was lost");
    expect(test.query.mock.calls.length + test.unsafe.mock.calls.length).toBe(queries);
  });

  it("rolls back on callback failure while keeping attempted state in the separate journal", async () => {
    const test = fixture();
    const failed = new Error("worker outcome unknown");
    let retainedFence: (() => Promise<void>) | undefined;
    await expect(
      test.lease(test.input, async (assertFence) => {
        retainedFence = assertFence;
        const row = test.rows.get(keyFor(context));
        if (row?.record.operator === undefined) {
          throw new Error("fixture row missing");
        }
        row.record.operator.pendingEffectId = "install";
        row.record.operator.pendingEffectAttempt = { id: "33333333-3333-4333-8333-333333333333" };
        await assertFence();
        throw failed;
      }),
    ).rejects.toBe(failed);
    expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
    expect(test.rows.get(keyFor(context))?.record.operator?.pendingEffectId).toBe("install");
    await expect(retainedFence?.()).rejects.toThrow("session was lost");
  });

  it("fails on disconnect and denies a callback that completes after the transaction rejected", async () => {
    const test = fixture();
    const entered = Promise.withResolvers<() => Promise<void>>();
    const resumed = Promise.withResolvers<null>();
    const finished = Promise.withResolvers<null>();
    const pending = test.lease(test.input, async (assertFence) => {
      entered.resolve(assertFence);
      await resumed.promise;
      try {
        await expect(assertFence()).rejects.toThrow("session was lost");
        finished.resolve(null);
      } catch (error) {
        finished.reject(error);
        throw error;
      }
      return "late result";
    });
    const assertFence = await entered.promise;
    const rejected = expect(pending).rejects.toThrow("fixture connection lost");
    test.disconnect();
    await rejected;
    expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
    await expect(assertFence()).rejects.toThrow("session was lost");
    resumed.resolve(null);
    await finished.promise;
  });

  it("denies an assertion already awaiting journal read when its transaction ends", async () => {
    const test = fixture();
    const waiting = Promise.withResolvers<null>();
    const resume = Promise.withResolvers<null>();
    let pendingAssertion: Promise<void> | undefined;
    await test.lease(test.input, async (assertFence) => {
      vi.mocked(test.store.read).mockImplementationOnce(async (input) => {
        waiting.resolve(null);
        await resume.promise;
        return test.rows.get(keyFor(input));
      });
      pendingAssertion = assertFence();
      await waiting.promise;
      return "finished callback";
    });
    const denied = expect(pendingAssertion).rejects.toThrow("session was lost");
    resume.resolve(null);
    await denied;
  });

  it("uses deterministic physical resource keys independent of owner, app and operation", async () => {
    const test = fixture();
    await test.lease(test.input, async (assertFence) => {
      await assertFence();
    });
    const expected = [
      ["hosted_protected_operator_database_v1", "fixture-neon", "br_fixture", "shared_auth"],
      ["hosted_protected_operator_database_v1", "fixture-neon", "br_fixture", "spend"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "shared_auth_owner"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "shared_auth_runtime"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "spend_owner"],
      ["hosted_protected_operator_role_v1", "fixture-neon", "br_fixture", "spend_runtime"],
    ]
      .map((parts) => JSON.stringify(parts))
      .toSorted();
    expect(test.acquired).toEqual(expected);
    expect(test.events.some((event) => event.includes("pg_advisory_lock("))).toBe(false);

    const changed = fixture();
    const otherContext = {
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
    const anotherRow = rowFor(otherContext, anotherPlan);
    if (anotherRow.record.operator === undefined) {
      throw new Error("fixture operator missing");
    }
    anotherRow.record.operator.operationRef = anotherOperation;
    changed.rows.set(keyFor(otherContext), anotherRow);
    await changed.lease(
      { ...otherContext, operationRef: anotherOperation, plan: anotherPlan },
      async () => "done",
    );
    expect(changed.acquired).toEqual(expected);
    expect(changed.rows.get(keyFor(context))?.record.operator?.operationRef).toBe(operationRef);
  });

  it("locks only databases when no bootstrap roles are created", async () => {
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
    expect(test.acquired).toHaveLength(2);
    expect(
      test.acquired.every((key) => key.startsWith('["hosted_protected_operator_database_v1",')),
    ).toBe(true);
  });

  it.each(["lease", "fence", "operation", "expiry"])(
    "denies a changed journal %s before a further resource effect",
    async (change) => {
      const test = fixture();
      const effect = vi.fn();
      await expect(
        test.lease(test.input, async (assertFence) => {
          const row = test.rows.get(keyFor(context));
          if (row?.record.operator === undefined) {
            throw new Error("fixture row missing");
          }
          if (change === "lease") {
            row.record.leaseId = "55555555-5555-4555-8555-555555555555";
          }
          if (change === "fence") {
            row.record.operator.fenceGeneration = 2;
          }
          if (change === "operation") {
            row.record.operator.operationRef = "55555555-5555-4555-8555-555555555555";
          }
          if (change === "expiry") {
            row.record.leaseExpiresAt = new Date(now).toISOString();
          }
          await assertFence();
          effect();
        }),
      ).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
      expect(test.events.slice(-2)).toEqual(["rollback", "end"]);
    },
  );

  it.each(["backend", "lock"])(
    "denies a lost %s before another resource effect",
    async (change) => {
      const test = fixture();
      const effect = vi.fn();
      await expect(
        test.lease(test.input, async (assertFence) => {
          if (change === "backend") {
            test.backend.backend_pid += 1;
          }
          if (change === "lock") {
            test.held.clear();
          }
          await assertFence();
          effect();
        }),
      ).rejects.toThrow();
      expect(effect).not.toHaveBeenCalled();
    },
  );

  it("does not borrow another application's journal lease for shared physical resources", async () => {
    const test = fixture();
    const callback = vi.fn();
    const anotherContext = { ...context, target: { ...context.target, appId: "other-app" } };
    await expect(test.lease({ ...anotherContext, operationRef, plan }, callback)).rejects.toThrow(
      "authority is unavailable",
    );
    expect(callback).not.toHaveBeenCalled();
    expect(test.acquired).toHaveLength(0);
    expect(test.rows.get(keyFor(context))?.record.leaseId).toBe(leaseId);
  });
});
