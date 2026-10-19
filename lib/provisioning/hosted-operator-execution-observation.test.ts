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
} from "./hosted-operator-execution-observation-protocol";

const now = Date.parse("2026-10-19T12:00:00Z");
const operationRef = "801583e6-b763-46eb-b9ca-9ac5a13733c4";
const fixture = (priorSettled = false) => {
  const selection = {
    appId: "reports",
    branch: "review",
    projectId: "project-reports",
    sessionId: "session-reports",
    environment: "preview" as const,
  };
  const plan = hostedOperatorPlanSchema.parse({
    version: 1,
    action: "prepare",
    selection,
    contextId: "context",
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
    access: [],
    cost: { class: "shared-recovery-group", description: "fixture", owner: "fixture" },
    effects: [
      { id: "resources", kind: "resources", description: "Observe resources" },
      { id: "install", kind: "install", description: "Install" },
      { id: "access", kind: "access", description: "Access" },
      { id: "bindings", kind: "bindings", description: "Bind" },
    ],
    installer: { reference: "installer", sha256: "a".repeat(64) },
    neon: {
      projectId: "neon",
      branchId: "branch",
      endpoint: "ep-fixture.neon.tech",
      connectionRef: "connection",
      source: "synthetic-only",
    },
    release: { id: "release", artifactRef: "artifact", sha256: "b".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "retain" },
  });
  const authority = {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
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
    revision: 1,
    record: hostedRuntimeJournalRecordSchema.parse({
      version: 1,
      kind: "app-runtime",
      request: target,
      approvedByCallId: "approved-call",
      status: "pending",
      step: "reserved",
      privateState: {
        encryptedToken: "synthetic-ciphertext",
        tokenIv: "iv",
        tokenTag: "tag",
        keyVersion: "v1",
      },
      operator: {
        mode: "protected-operator-v1",
        operationRef,
        planDigest: operatorPlanDigest(plan),
        plan,
        receipts: [],
        approvalId: "approval",
        fenceGeneration: 1,
      },
    }),
  };
  if (priorSettled) {
    row.record.executionObservation = {
      state: "settled",
      attemptRef: "9b7a1463-3626-4730-bcbf-b2c226cc1c45",
      operationRef,
      planDigest: operatorPlanDigest(plan),
      callId: "approved-call",
      approvalId: "approval",
      outcome: { status: "blocked", code: "reconciliation_required" },
    };
  }
  const store: HostedRuntimeJournalStore = {
    read: () => Promise.resolve(structuredClone(row)),
    reserve: () => Promise.resolve(structuredClone(row)),
    compareAndSet: (input) => {
      if (input.expectedRevision !== row.revision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal CAS contract explicitly returns undefined on a revision conflict.
        return Promise.resolve(undefined);
      }
      row = {
        revision: row.revision + 1,
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
      };
      return Promise.resolve(structuredClone(row));
    },
    reserveFenceGeneration: () => Promise.reject(new Error("Fence already allocated")),
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
  const deps: ProtectedHostedOperatorDependencies = {
    store,
    now: () => now,
    authorize: () => Promise.resolve({ authority, target }),
    assertAuthorized: () => Promise.resolve(),
    plan: () => Promise.resolve(plan),
    readApproval: (input) => Promise.resolve({ ...input, approvalId: "approval", approved: true }),
    withResourceLease: async (_input, run) =>
      await run(() =>
        physicalFence
          ? Promise.resolve()
          : Promise.reject(new HostedOperatorError("operation_in_progress")),
      ),
    reconcile: () => Promise.resolve({ status: "absent" }),
    executeEffect,
    verify: () =>
      Promise.resolve({
        actors: 1,
        tenants: 1,
        releaseId: plan.release.id,
        artifactHash: plan.release.sha256,
        manifestSha256: plan.release.sha256,
        authenticatedBehavior: "unassessed",
      }),
    bindings: () => Promise.resolve({}),
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const request = (action: "execute" | "status", observe = true) =>
    handler(
      new Request("https://operator.example/v1/runtime", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(observe
            ? { [OPERATOR_EXECUTION_OBSERVATION_HEADER]: OPERATOR_EXECUTION_OBSERVATION_PREFERENCE }
            : {}),
        },
        body: JSON.stringify({
          action,
          selection,
          operationRef,
          ...(action === "execute"
            ? { callId: "approved-call", planDigest: operatorPlanDigest(plan) }
            : {}),
        }),
      }),
    );
  const status = async () => {
    const response = await request("status");
    return operatorPublicResultSchema.parse(await response.json());
  };
  return {
    request,
    status,
    entered,
    gate,
    executeEffect,
    get record() {
      return row.record;
    },
    fail: (error: Error) => {
      failure = error;
    },
    loseFence: () => {
      physicalFence = false;
    },
  };
};

describe("canonical execution observation", () => {
  it("invalidates a prior settled acknowledgement before a legacy technical retry", async () => {
    const f = fixture(true);
    expect(await f.status()).toMatchObject({
      execution: { state: "settled", outcome: { status: "blocked" } },
    });
    const execution = f.request("execute", false);
    await f.entered.promise;
    expect(f.record).not.toHaveProperty("executionObservation");
    expect(await f.status()).toMatchObject({ execution: { state: "running" } });
    f.gate.resolve(undefined);
    await execution;
    expect(f.record).not.toHaveProperty("executionObservation");
    expect(await f.status()).toMatchObject({
      status: "prepared",
      execution: { state: "settled", outcome: { status: "prepared" } },
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
        status: "pending",
        execution: { state: "running" },
      });
      expect(f.record.leaseId).toBeDefined();
      if (outcome === "reconciliation_required") {
        f.fail(new HostedOperatorError(outcome));
      }
      f.gate.resolve(undefined);
      await execution;
      expect(f.record.leaseId).toBeUndefined();
      expect(await f.status()).toMatchObject({
        status: outcome === "prepared" ? "prepared" : "pending",
        execution: {
          state: "settled",
          outcome: {
            status: outcome === "prepared" ? "prepared" : "blocked",
            ...(outcome === "prepared" ? {} : { code: outcome }),
          },
        },
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
    expect(await f.status()).toMatchObject({ status: "pending", execution: { state: "unknown" } });
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
    const operator = record.operator;
    if (operator === undefined) {
      throw new Error("Fixture requires an operator");
    }
    const attemptRef = "9b7a1463-3626-4730-bcbf-b2c226cc1c45";
    record.leaseId = attemptRef;
    record.leaseExpiresAt = new Date(now + 60_000).toISOString();
    record.executionObservation = {
      state: "running",
      attemptRef,
      operationRef,
      planDigest: operatorPlanDigest(operator.plan),
      callId: record.approvedByCallId,
      approvalId: "approval",
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
      leaseId: "9b7a1463-3626-4730-bcbf-b2c226cc1c45",
      leaseExpiresAt: new Date(now - 1).toISOString(),
    };
    expect(readOperatorExecutionObservation(record, now)).toEqual({ state: "unknown" });
  });
});
