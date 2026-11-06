/* oxlint-disable unicorn/no-useless-undefined -- Explicit undefined models journal CAS absence and valueless coordination promises; these values are supported inputs. */
import { describe, expect, it, vi } from "vitest";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorPublicResultSchema,
} from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  readOperatorExecutionObservation,
  settleOperatorExecution,
} from "./hosted-operator-execution-observation";

import {
  OPERATOR_EXECUTION_OBSERVATION_HEADER,
  OPERATOR_EXECUTION_OBSERVATION_PREFERENCE,
  OPERATOR_PREPARATION_PROGRESS_HEADER,
  OPERATOR_PREPARATION_PROGRESS_PREFERENCE,
} from "./hosted-operator-execution-observation-protocol";

const now = Date.parse("2026-10-19T12:00:00Z");
const operationRef = "801583e6-b763-46eb-b9ca-9ac5a13733c4";
const fixture = (priorSettled = false, clock: () => number = () => now) => {
  const selection = {
    appId: "reports",
    branch: "review",
    environment: "preview" as const,
    projectId: "project-reports",
    sessionId: "session-reports",
  };
  const plan = hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: {
      database: "reports",
      migratorRole: "reports_owner",
      resourceId: "reports",
      runtimeRole: "reports_reader",
    },
    authDatabase: {
      database: "identity",
      migratorRole: "identity_owner",
      resourceId: "identity",
      runtimeRole: "identity_reader",
    },
    contextId: "context",
    cost: { class: "shared-recovery-group", description: "fixture", owner: "fixture" },
    effects: [
      { description: "Observe resources", id: "resources", kind: "resources" },
      { description: "Install", id: "install", kind: "install" },
      { description: "Access", id: "access", kind: "access" },
      { description: "Bind", id: "bindings", kind: "bindings" },
    ],
    installer: { reference: "installer", sha256: "a".repeat(64) },
    neon: {
      branchId: "branch",
      connectionRef: "connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon",
      source: "synthetic-only",
    },
    release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "retain" },
    selection,
    version: 1,
  });
  const authority = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    workspaceId: "workspace",
  };
  const target = {
    ...selection,
    installationId: "installation",
    scopeId: "team",
    scopeType: "team" as const,
  };
  let row = {
    record: hostedRuntimeJournalRecordSchema.parse({
      approvedByCallId: "approved-call",
      kind: "app-runtime",
      operator: {
        approvalId: "approval",
        fenceGeneration: 1,
        mode: "protected-operator-v1",
        operationRef,
        plan,
        planDigest: operatorPlanDigest(plan),
        receipts: [],
      },
      privateState: {
        encryptedToken: "synthetic-ciphertext",
        keyVersion: "v1",
        tokenIv: "iv",
        tokenTag: "tag",
      },
      request: target,
      status: "pending",
      step: "reserved",
      version: 1,
    }),
    revision: 1,
  };
  if (priorSettled) {
    row.record.executionObservation = {
      approvalId: "approval",
      attemptRef: "9b7a1463-3626-4730-bcbf-b2c226cc1c45",
      callId: "approved-call",
      operationRef,
      outcome: { code: "reconciliation_required", status: "blocked" },
      planDigest: operatorPlanDigest(plan),
      state: "settled",
    };
  }
  const store: HostedRuntimeJournalStore = {
    compareAndSet: async (input) => {
      if (input.expectedRevision !== row.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal CAS contract explicitly returns undefined on a revision conflict.
        return undefined;
      }
      row = {
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
        revision: row.revision + 1,
      };
      return structuredClone(row);
    },
    read: async () => structuredClone(row),
    reserve: async () => structuredClone(row),
    reserveFenceGeneration: async () => {
      throw new Error("Fence already allocated");
    },
  };
  const gate = Promise.withResolvers<undefined>();
  const entered = Promise.withResolvers<undefined>();
  let failure: Error | undefined;
  let physicalFence = true;
  const executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
    async (input) => {
      entered.resolve(undefined);
      await gate.promise;
      if (failure !== undefined) {
        throw failure;
      }
      return {
        effectId: input.effect.id,
        observedAt: new Date(now).toISOString(),
        resourceVersion: "owned-readback",
        ...(input.effect.kind === "access" ? { fenceGeneration: input.fenceGeneration } : {}),
      };
    },
  );
  const assertAuthorized = vi.fn(async () => {});
  const assertCanonicalOwner = vi.fn(async () => {});
  let physicalLeaseReleased = false;
  const deps: ProtectedHostedOperatorDependencies = {
    assertAuthorized,
    assertCanonicalOwner,
    authorize: async () => ({ authority, target }),
    bindings: async () => ({}),
    executeEffect,
    now: clock,
    plan: async () => plan,
    readApproval: async (input) => ({ ...input, approvalId: "approval", approved: true }),
    reconcile: async () => ({ status: "absent" }),
    store,
    verify: async () => ({
      actors: 1,
      artifactHash: plan.release.sha256,
      authenticatedBehavior: "unassessed",
      manifestSha256: plan.release.sha256,
      releaseId: plan.release.id,
      tenants: 1,
    }),
    withResourceLease: async (_input, run) => {
      const { leaseId } = row.record;
      try {
        return await run(async () => {
          const liveExpiry =
            row.record.leaseExpiresAt !== undefined &&
            Date.parse(row.record.leaseExpiresAt) > clock();
          physicalFence && row.record.leaseId === leaseId && liveExpiry
            ? await Promise.resolve()
            : await Promise.reject(new HostedOperatorError("operation_in_progress"));
        });
      } finally {
        physicalLeaseReleased = true;
      }
    },
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const request = async (
    action: "execute" | "status",
    observe = true,
    signal?: AbortSignal,
    progress?: string,
  ) =>
    await handler(
      new Request("https://operator.example/v1/runtime", {
        body: JSON.stringify({
          action,
          operationRef,
          selection,
          ...(action === "execute"
            ? { callId: "approved-call", planDigest: operatorPlanDigest(plan) }
            : {}),
        }),
        headers: {
          "content-type": "application/json",
          ...(progress === undefined ? {} : { [OPERATOR_PREPARATION_PROGRESS_HEADER]: progress }),
          ...(observe
            ? { [OPERATOR_EXECUTION_OBSERVATION_HEADER]: OPERATOR_EXECUTION_OBSERVATION_PREFERENCE }
            : {}),
        },
        method: "POST",
        signal,
      }),
    );
  const status = async () => {
    const response = await request("status");
    return operatorPublicResultSchema.parse(await response.json());
  };
  return {
    assertAuthorized,
    assertCanonicalOwner,
    deps,
    entered,
    executeEffect,
    fail: (error: Error) => {
      failure = error;
    },
    gate,
    loseFence: () => {
      physicalFence = false;
    },
    get physicalLeaseReleased() {
      return physicalLeaseReleased;
    },
    get record() {
      return row.record;
    },
    request,
    get revision() {
      return row.revision;
    },
    status,
    store,
  };
};

const readExecutingEffect = (f: ReturnType<typeof fixture>) => {
  const effect = f.executeEffect.mock.calls[0]?.[0];
  if (effect === undefined || effect.assertCurrentObservation === undefined) {
    throw new Error("Fixture execution observation is missing");
  }
  return { ...effect, assertCurrentObservation: effect.assertCurrentObservation };
};

describe("canonical execution observation", () => {
  it.each([false, true])(
    "includes recorded preparation progress in read-only status (observation %s)",
    async (observe) => {
      const f = fixture();
      const read = vi.spyOn(f.store, "read");
      const write = vi.spyOn(f.store, "compareAndSet");
      const record = structuredClone(f.record);
      const response = await f.request(
        "status",
        observe,
        undefined,
        OPERATOR_PREPARATION_PROGRESS_PREFERENCE,
      );
      const result = operatorPublicResultSchema.parse(await response.json());
      expect(result).toMatchObject({
        preparationProgress: {
          accountsCompleted: false,
          allPlanEffectsReceipted: false,
          hasAccountPreparation: false,
          hasPendingAttempt: false,
          hasPendingEffect: false,
          lease: "absent",
          missingEffectKinds: ["resources", "install", "access", "bindings"],
        },
        status: "pending",
      });
      expect(result.preparationProgress).not.toHaveProperty("planStage");
      expect(read).toHaveBeenCalledOnce();
      expect(write).not.toHaveBeenCalled();
      expect(f.assertAuthorized).toHaveBeenCalledOnce();
      expect(f.executeEffect).not.toHaveBeenCalled();
      expect(f.record).toEqual(record);
    },
  );

  it.each([undefined, "requested", "v2"])(
    "preserves legacy result shape for missing or unsupported preparation preference %s",
    async (preference) => {
      const f = fixture();
      const response = await f.request("status", true, undefined, preference);
      const result = operatorPublicResultSchema
        .omit({ preparationProgress: true })
        .parse(await response.json());
      expect(result).not.toHaveProperty("preparationProgress");
      expect(result.execution).toEqual({ state: "unknown" });
    },
  );

  it("does not disclose preparation facts when status authorization fails", async () => {
    const f = fixture();
    f.assertAuthorized.mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    const response = await f.request(
      "status",
      true,
      undefined,
      OPERATOR_PREPARATION_PROGRESS_PREFERENCE,
    );
    const result = operatorPublicResultSchema.parse(await response.json());
    expect(result).toMatchObject({ code: "authorization_required", status: "blocked" });
    expect(result.preparationProgress).toBeUndefined();
    expect(f.executeEffect).not.toHaveBeenCalled();
  });

  it("keeps frequent observations read-only while mutations still reauthorize the provider", async () => {
    const f = fixture();
    const execution = f.request("execute");
    await f.entered.promise;
    const effect = readExecutingEffect(f);
    const { revision } = f;
    const expiresAt = f.record.leaseExpiresAt;
    const providerReads = f.assertAuthorized.mock.calls.length;
    await Promise.all(
      Array.from({ length: 100 }, async () => {
        await effect.assertCurrentObservation();
      }),
    );
    expect(f.revision).toBe(revision);
    expect(f.record.leaseExpiresAt).toBe(expiresAt);
    expect(f.assertAuthorized).toHaveBeenCalledTimes(providerReads);
    expect(f.assertCanonicalOwner).toHaveBeenCalledTimes(100);
    await effect.assertCurrent();
    expect(f.assertAuthorized).toHaveBeenCalledTimes(providerReads + 1);
    expect(f.revision).toBe(revision);
    f.assertAuthorized.mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    await expect(effect.assertCurrent()).rejects.toMatchObject({ code: "authorization_required" });
    f.gate.resolve(undefined);
    await execution;
    expect(f.revision).toBeGreaterThan(revision);
    expect(f.record.operator?.receipts).toHaveLength(4);
  });

  it("renews during pre-worker reconciliation without provider GETs or post-release writes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = fixture(false, Date.now);
    const entered = Promise.withResolvers<undefined>();
    const release = Promise.withResolvers<undefined>();
    f.deps.reconcile = async () => {
      entered.resolve(undefined);
      await release.promise;
      return { status: "absent" };
    };
    f.gate.resolve(undefined);
    const execution = f.request("execute");
    try {
      await entered.promise;
      const { revision } = f;
      const providerReads = f.assertAuthorized.mock.calls.length;
      await vi.advanceTimersByTimeAsync(61_000);
      expect(f.revision).toBe(revision + 3);
      expect(Date.parse(f.record.leaseExpiresAt ?? "")).toBeGreaterThan(Date.now());
      expect(f.assertAuthorized).toHaveBeenCalledTimes(providerReads);
      expect(f.executeEffect).not.toHaveBeenCalled();
      release.resolve(undefined);
      await execution;
      expect(f.physicalLeaseReleased).toBe(true);
      expect(f.record.leaseId).toBeUndefined();
      const settledRevision = f.revision;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(f.revision).toBe(settledRevision);
    } finally {
      release.resolve(undefined);
      await execution;
      vi.useRealTimers();
    }
  });

  it.each(["owner", "approval", "fence", "expired", "replaced", "cancel"] as const)(
    "rejects an observation after %s loss without renewing authority",
    async (lost) => {
      const f = fixture();
      const abort = new AbortController();
      const execution = f.request("execute", true, abort.signal);
      await f.entered.promise;
      const effect = readExecutingEffect(f);
      const { revision } = f;
      if (lost === "owner") {
        f.assertCanonicalOwner.mockRejectedValue(new HostedOperatorError("authorization_required"));
      }
      if (lost === "approval") {
        f.deps.readApproval = async () => ({
          action: "prepare",
          approvalId: "approval",
          approved: false,
          callId: "approved-call",
          planDigest: effect.plan.release.sha256,
        });
      }
      if (lost === "fence") {
        f.loseFence();
      }
      if (lost === "expired") {
        f.record.leaseExpiresAt = new Date(now - 1).toISOString();
      }
      if (lost === "replaced") {
        f.record.leaseId = "9b7a1463-3626-4730-bcbf-b2c226cc1c45";
      }
      if (lost === "cancel") {
        abort.abort(new HostedOperatorError("authorization_required"));
      }
      await expect(effect.assertCurrentObservation()).rejects.toBeInstanceOf(Error);
      expect(f.revision).toBe(revision);
      f.gate.resolve(undefined);
      await execution;
    },
  );

  it("aborts the worker when renewal loses owner authority", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = fixture(false, Date.now);
    const execution = f.request("execute");
    try {
      await f.entered.promise;
      const effect = readExecutingEffect(f);
      const { revision } = f;
      f.assertCanonicalOwner.mockRejectedValue(new HostedOperatorError("authorization_required"));
      await vi.advanceTimersByTimeAsync(20_000);
      expect(effect.signal?.aborted).toBe(true);
      expect(f.revision).toBe(revision);
      f.gate.resolve(undefined);
      const response = await execution;
      expect(await response.json()).toMatchObject({
        code: "authorization_required",
        status: "blocked",
      });
      expect(f.executeEffect).toHaveBeenCalledOnce();
      expect(f.record.leaseId).toBeUndefined();
    } finally {
      f.gate.resolve(undefined);
      await execution;
      vi.useRealTimers();
    }
  });

  it("rechecks authority after a lost renewal CAS", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = fixture(false, Date.now);
    const execution = f.request("execute");
    try {
      await f.entered.promise;
      const effect = readExecutingEffect(f);
      const { revision } = f;
      const rechecked = Promise.withResolvers<undefined>();
      vi.spyOn(f.store, "compareAndSet").mockImplementationOnce(async () => {
        f.assertCanonicalOwner.mockImplementation(async () => {
          rechecked.resolve(undefined);
          throw new HostedOperatorError("authorization_required");
        });
        return undefined;
      });
      await vi.advanceTimersByTimeAsync(20_000);
      await rechecked.promise;
      await vi.advanceTimersByTimeAsync(0);
      expect(effect.signal?.aborted).toBe(true);
      expect(f.revision).toBe(revision);
      f.gate.resolve(undefined);
      const response = await execution;
      expect(await response.json()).toMatchObject({
        code: "authorization_required",
        status: "blocked",
      });
    } finally {
      f.gate.resolve(undefined);
      await execution;
      vi.useRealTimers();
    }
  });

  it("drains an in-flight renewal before releasing the physical and journal leases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = fixture(false, Date.now);
    const execution = f.request("execute");
    const release = Promise.withResolvers<undefined>();
    try {
      await f.entered.promise;
      const { compareAndSet } = f.store;
      vi.spyOn(f.store, "compareAndSet").mockImplementationOnce(async (input) => {
        await release.promise;
        return await compareAndSet(input);
      });
      await vi.advanceTimersByTimeAsync(20_000);
      f.fail(new HostedOperatorError("reconciliation_required"));
      f.gate.resolve(undefined);
      await vi.advanceTimersByTimeAsync(0);
      expect(f.physicalLeaseReleased).toBe(false);
      expect(f.record.leaseId).toBeDefined();
      release.resolve(undefined);
      await execution;
      expect(f.physicalLeaseReleased).toBe(true);
      expect(f.record.leaseId).toBeUndefined();
    } finally {
      release.resolve(undefined);
      f.gate.resolve(undefined);
      await execution;
      vi.useRealTimers();
    }
  });

  it("stops renewal when the physical lease fails before its callback returns", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const f = fixture(false, Date.now);
    const lost = Promise.withResolvers<never>();
    const { withResourceLease } = f.deps;
    let callback: Promise<unknown> | undefined;
    f.deps.withResourceLease = async (input, run) => {
      const running = withResourceLease(input, run);
      callback = running;
      return await Promise.race([running, lost.promise]);
    };
    const execution = f.request("execute");
    try {
      await f.entered.promise;
      const effect = readExecutingEffect(f);
      f.loseFence();
      lost.reject(new HostedOperatorError("operation_in_progress"));
      const response = await execution;
      expect(await response.json()).toMatchObject({ status: "blocked" });
      expect(effect.signal?.aborted).toBe(true);
      expect(f.record.leaseId).toBeUndefined();
      const { revision } = f;
      await vi.advanceTimersByTimeAsync(80_000);
      expect(f.revision).toBe(revision);
      expect(vi.getTimerCount()).toBe(0);
      f.gate.resolve(undefined);
      await expect(callback).rejects.toBeInstanceOf(Error);
      expect(f.revision).toBe(revision);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      lost.reject(new HostedOperatorError("operation_in_progress"));
      f.gate.resolve(undefined);
      await execution;
      try {
        await callback;
      } catch {
        // The detached callback must reject after the physical fence is lost.
      }
      vi.useRealTimers();
    }
  });

  it("invalidates a prior settled acknowledgement before a legacy technical retry", async () => {
    const f = fixture(true);
    expect(await f.status()).toMatchObject({
      execution: { outcome: { status: "blocked" }, state: "settled" },
    });
    const execution = f.request("execute", false);
    await f.entered.promise;
    expect(f.record).not.toHaveProperty("executionObservation");
    expect(await f.status()).toMatchObject({ execution: { state: "running" } });
    f.gate.resolve(undefined);
    await execution;
    expect(f.record).not.toHaveProperty("executionObservation");
    expect(await f.status()).toMatchObject({
      execution: { outcome: { status: "prepared" }, state: "settled" },
      status: "prepared",
    });
    expect(f.executeEffect).toHaveBeenCalledTimes(4);
  });
  it("does not add execution journal state for legacy EXECUTE callers", async () => {
    const f = fixture();
    const execution = f.request("execute", false);
    await f.entered.promise;
    expect(f.record).not.toHaveProperty("executionObservation");
    f.gate.resolve(undefined);
    await execution;
    expect(f.record).not.toHaveProperty("executionObservation");
  });
  it("preserves the legacy STATUS wire shape without explicit observation preference", async () => {
    const f = fixture();
    const execution = f.request("execute");
    await f.entered.promise;
    const running = await f.request("status", false);
    expect(await running.json()).not.toHaveProperty("execution");
    f.gate.resolve(undefined);
    await execution;
    const settled = await f.request("status", false);
    expect(await settled.json()).not.toHaveProperty("execution");
  });
  it.each(["prepared", "reconciliation_required"] as const)(
    "observes a live execution then its actual %s outcome without another execute",
    async (outcome) => {
      const f = fixture();
      const privateState = structuredClone(f.record.privateState);
      const execution = f.request("execute");
      await f.entered.promise;
      expect(await f.status()).toMatchObject({
        execution: { state: "running" },
        status: "pending",
      });
      expect(f.record.leaseId).toBeDefined();
      if (outcome === "reconciliation_required") {
        f.fail(new HostedOperatorError(outcome));
      }
      f.gate.resolve(undefined);
      await execution;
      expect(f.record.leaseId).toBeUndefined();
      expect(await f.status()).toMatchObject({
        execution: {
          outcome: {
            status: outcome === "prepared" ? "prepared" : "blocked",
            ...(outcome === "prepared" ? {} : { code: outcome }),
          },
          state: "settled",
        },
        status: outcome === "prepared" ? "prepared" : "pending",
      });
      expect(f.executeEffect).toHaveBeenCalledTimes(outcome === "prepared" ? 4 : 1);
      expect(f.record.privateState).toEqual(privateState);
    },
  );
  it("leaves a lost physical fence unknown rather than recording a terminal error", async () => {
    const f = fixture();
    const execution = f.request("execute");
    await f.entered.promise;
    f.loseFence();
    f.fail(new HostedOperatorError("reconciliation_required"));
    f.gate.resolve(undefined);
    await execution;
    expect(await f.status()).toMatchObject({ execution: { state: "unknown" }, status: "pending" });
  });
  it.each([
    "different-lease",
    "different-plan",
    "different-operation",
    "different-approval",
    "missing-lease",
  ] as const)("does not let a stale attempt settle after %s", (drift) => {
    const f = fixture();
    const record = structuredClone(f.record);
    const { operator } = record;
    if (operator === undefined) {
      throw new Error("Fixture requires an operator");
    }
    const attemptRef = "9b7a1463-3626-4730-bcbf-b2c226cc1c45";
    record.leaseId = attemptRef;
    record.leaseExpiresAt = new Date(now + 60_000).toISOString();
    record.executionObservation = {
      approvalId: "approval",
      attemptRef,
      callId: record.approvedByCallId,
      operationRef,
      planDigest: operatorPlanDigest(operator.plan),
      state: "running",
    };
    if (drift === "different-lease") {
      record.leaseId = "da4878eb-314c-4b73-b1e4-65fbd08eb12f";
    }
    if (drift === "different-plan") {
      operator.planDigest = "f".repeat(64);
    }
    if (drift === "different-operation") {
      operator.operationRef = "da4878eb-314c-4b73-b1e4-65fbd08eb12f";
    }
    if (drift === "different-approval") {
      operator.approvalId = "new-approval";
    }
    if (drift === "missing-lease") {
      delete record.leaseId;
    }
    expect(settleOperatorExecution(record, attemptRef, { status: "prepared" })).toBe(record);
  });
  it("does not fabricate an outcome from missing or expired acknowledgement", () => {
    const f = fixture();
    expect(readOperatorExecutionObservation(f.record, now)).toEqual({ state: "unknown" });
    const record = {
      ...f.record,
      leaseExpiresAt: new Date(now - 1).toISOString(),
      leaseId: "9b7a1463-3626-4730-bcbf-b2c226cc1c45",
    };
    expect(readOperatorExecutionObservation(record, now)).toEqual({ state: "unknown" });
  });
});
