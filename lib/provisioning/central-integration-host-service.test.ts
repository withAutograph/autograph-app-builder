/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Deterministic async authority and CAS ports exercise the actual service/schema/transition code without hosted effects. */
import { isDeepStrictEqual } from "node:util";
import { expect, test } from "vitest";
import { plan as original, ready as originalReady } from "./central-integration-host-test-fixture";
import {
  centralHostPlanDigest,
  centralHostOperationRef,
  centralHostCallerPlanSchema,
  centralHostReadyReceiptSchema,
} from "./central-integration-host-contract";
import type {
  CentralHostSetupPlan,
  CentralHostCallerPlan,
} from "./central-integration-host-contract";
import {
  centralHostRecordSchema,
  assertCentralHostTransition,
} from "./central-integration-host-store";
import type { CentralHostRow, CentralHostRecord } from "./central-integration-host-store";
import { createCentralHostService } from "./central-integration-host-service";
import type {
  CentralHostServicePorts,
  CentralHostEffectContext,
} from "./central-integration-host-service";
import type { CentralEffectReceipt } from "./central-integration-host-checkpoint";
import {
  centralHostPlanResultSchema,
  centralHostApprovalInputSchema,
} from "./central-integration-host-transport";
import { retainCentralNativeDeploymentReceipt } from "./central-integration-deployment-receipt";

const id = "11111111-1111-4111-a111-111111111111";
const receiptFor = (context: CentralHostEffectContext): CentralEffectReceipt => {
  const plan = context.plan;
  if (plan.kind === "central-integration-host-caller-v1") {
    return {
      effect: "authorize-app-central-caller",
      projectId: plan.central.projectId,
      callerProjectId: plan.caller.projectId,
      environment: "production",
      targetEnvironment: "preview",
      trustedSourcesSha256: "a".repeat(64),
      trustedSourcesGrantSha256: "b".repeat(64),
    };
  }
  switch (context.effect) {
    case "prepare-central-resources": {
      return {
        effect: context.effect,
        resourceId: plan.control.resource.resourceId,
        resourceVersion: "resource-v1",
        readbackSha256: "a".repeat(64),
      };
    }
    case "install-central-schema": {
      return {
        effect: context.effect,
        resourceProfileId: plan.resourceProfileId,
        schemaSha256: plan.control.schemaSha256,
        configurationSha256: plan.source.configurationSha256,
        centralPrincipalGeneration: context.attemptGeneration,
      };
    }
    case "register-deployment-receiver": {
      return {
        effect: context.effect,
        id: "accepted-provider-webhook",
        secretSha256: "a".repeat(64),
      };
    }
    case "authorize-central-inspector": {
      return {
        effect: context.effect,
        projectId: plan.target.projectId,
        callerProjectId: plan.inspector.projectId,
        environment: plan.inspector.environment,
        targetEnvironment: "preview",
        trustedSourcesSha256: "a".repeat(64),
        trustedSourcesGrantSha256: "b".repeat(64),
      };
    }
    case "bind-central-preview-runtime": {
      return { effect: context.effect, environmentSha256: "a".repeat(64) };
    }
    case "publish-central-host-source": {
      return {
        effect: context.effect,
        repositoryId: plan.source.repositoryId,
        branch: plan.source.operationBranch,
        sourceSha: plan.source.reviewedSourceSha,
      };
    }
    case "authorize-app-central-caller": {
      throw new Error("wrong effect");
    }
    default: {
      throw new Error("unrecognized fixture effect");
    }
  }
};
const fixture = (plan: CentralHostSetupPlan | CentralHostCallerPlan = original) => {
  let row: CentralHostRow | undefined;
  let authorized = true;
  let generation = 0;
  let providerReady = false;
  let lost = false;
  let unknown = false;
  let conflict = false;
  const revoked = new Set<string>();
  const applied: CentralHostEffectContext["effect"][] = [];
  const reconciled: { effect: string; generation: number }[] = [];
  const invocation = {
    authority: plan.authority,
    sessionId: plan.selection.sessionId,
    callId: "current-call",
    signal: new AbortController().signal,
  };
  const approval = (callId: string) => ({
    approvedByCallId: callId,
    approvedAt: "2026-11-03T00:00:00Z",
  });
  const store: CentralHostServicePorts["store"] = {
    read: async (authority, operationRef) =>
      row !== undefined &&
      isDeepStrictEqual(authority, row.record.plan.authority) &&
      operationRef === row.operationRef
        ? structuredClone(row)
        : undefined,
    reserve: async (selected) => {
      row ??= {
        operationRef: centralHostOperationRef(selected),
        revision: 1,
        record: centralHostRecordSchema.parse({
          kind: "central-integration-host-journal-v1",
          plan: selected,
          planDigest: centralHostPlanDigest(selected),
          effects: Object.fromEntries(selected.effects.map((effect) => [effect, "idle"])),
          attempts: {},
          ...(selected.kind === "central-integration-host-setup-v1"
            ? { nativeDeployment: { status: "empty" } }
            : {}),
        }),
      };
      return structuredClone(row);
    },
    compareAndSet: async (before, raw): Promise<CentralHostRow | undefined> => {
      if (conflict) {
        conflict = false;
        return undefined;
      }
      if (row?.revision !== before.revision) {
        return undefined;
      }
      const record = centralHostRecordSchema.parse(raw);
      assertCentralHostTransition(before.record, record);
      row = { operationRef: before.operationRef, revision: before.revision + 1, record };
      return structuredClone(row);
    },
  };
  const ports: CentralHostServicePorts = {
    store,
    resolvePlan: async () => plan,
    assertAuthorized: async () => {
      if (!authorized) {
        throw new Error("owner revoked");
      }
    },
    readApproval: async (_inv, _plan, callId) => {
      if (revoked.has(callId)) {
        throw new Error("consent revoked");
      }
      return approval(callId);
    },
    withTargetLease: async (_inv, _plan, run) => {
      generation += 1;
      return await run({
        leaseId: id,
        fenceGeneration: generation,
        assertCurrent: async () => {
          if (!authorized) {
            throw new Error("lease revoked");
          }
        },
      });
    },
    applyEffect: async (context) => {
      expect(row?.record.effects[context.effect]).toBe("pending");
      expect(row?.record.attempts?.[context.effect]?.attemptGeneration).toBe(
        context.attemptGeneration,
      );
      applied.push(context.effect);
      await context.checkpoint.recordAccepted(receiptFor(context));
      if (lost) {
        lost = false;
        throw new Error("lost acknowledgement");
      }
    },
    reconcileEffect: async (context) => {
      reconciled.push({ effect: context.effect, generation: context.attemptGeneration });
      return unknown ? { status: "unknown" } : { status: "applied", receipt: receiptFor(context) };
    },
    observeSetup: async () => providerReady,
    observeCaller: async () =>
      plan.kind === "central-integration-host-caller-v1"
        ? centralHostReadyReceiptSchema.parse({
            ...originalReady,
            authority: plan.authority,
            setup: plan.setup,
            callerSetup: {
              operationRef: centralHostOperationRef(plan),
              planDigest: centralHostPlanDigest(plan),
            },
            caller: {
              ...originalReady.caller,
              projectId: plan.caller.projectId,
              ownerId: plan.caller.ownerId,
            },
          })
        : undefined,
  };
  const service = createCentralHostService(ports);
  const select = {
    operationRef: centralHostOperationRef(plan),
    planDigest: centralHostPlanDigest(plan),
  };
  const native = async (eventType: "deployment.created" | "deployment.ready") => {
    if (
      row === undefined ||
      row.record.plan.kind !== "central-integration-host-setup-v1" ||
      row.record.nativeDeployment === undefined
    ) {
      throw new Error("fixture missing setup");
    }
    const next = {
      ...row.record,
      nativeDeployment: retainCentralNativeDeploymentReceipt(row.record.nativeDeployment, {
        eventId: eventType,
        eventType,
        bodySha256: "a".repeat(64),
        projectId: row.record.plan.target.projectId,
        teamId: row.record.plan.target.teamId,
        providerDeploymentId: originalReady.deployment.providerDeploymentId,
        immutableOrigin: originalReady.deployment.immutableOrigin,
      }),
    };
    row = await store.compareAndSet(row, next);
  };
  return {
    service,
    store,
    ports,
    invocation,
    select,
    applied,
    reconciled,
    native,
    markProviderReady: () => {
      providerReady = true;
    },
    row: () => {
      if (row === undefined) {
        throw new Error("missing fixture row");
      }
      return structuredClone(row);
    },
    lose: () => {
      lost = true;
    },
    setUnknown: () => {
      unknown = true;
    },
    revokeOwner: () => {
      authorized = false;
    },
    revokeCall: (callId: string) => revoked.add(callId),
    conflict: () => {
      conflict = true;
    },
  };
};
test("normal planning reserves no effects; global prepare performs exactly six ordered effects and waits for signed ready identity", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  expect(f.applied).toEqual([]);
  expect(await f.service.prepare(f.invocation, f.select)).toMatchObject({
    status: "waiting-native-deployment",
  });
  expect(f.applied).toEqual([...original.effects]);
  expect(f.row().record.nativeDeployment).toEqual({ status: "empty" });
  await f.native("deployment.created");
  expect(await f.service.read(f.invocation, f.select)).toMatchObject({ status: "pending" });
  await f.native("deployment.ready");
  f.markProviderReady();
  expect(await f.service.read(f.invocation, f.select)).toMatchObject({ status: "ready" });
  expect(f.applied).toHaveLength(6);
});
test("pending recovery inspects the original attempt generation under a fresh lease without replay", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  f.lose();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow("lost acknowledgement");
  expect(f.row().record.effects[original.effects[0]]).toBe("pending");
  await f.service.prepare({ ...f.invocation, callId: "resume-call" }, f.select);
  expect(f.applied.filter((effect) => effect === original.effects[0])).toHaveLength(1);
  expect(f.reconciled[0]).toEqual({ effect: original.effects[0], generation: 1 });
  expect(f.row().record.executionLease?.fenceGeneration).toBe(2);
});
test("uncertain readback never dispatches the pending effect or advances dependencies", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  f.lose();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow();
  f.setUnknown();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow("outcome_unknown");
  expect(f.applied).toEqual([original.effects[0]]);
  expect(f.row().record.effects[original.effects[1]]).toBe("idle");
});
test("revoked original consent blocks recovery even when a new call consents", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  f.lose();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow();
  f.revokeCall(f.invocation.callId);
  await expect(
    f.service.prepare({ ...f.invocation, callId: "new-consent" }, f.select),
  ).rejects.toThrow("consent revoked");
  expect(f.applied).toHaveLength(1);
});
test("owner revocation, foreign session and stale plan cannot authorize effects", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  await expect(
    f.service.prepare({ ...f.invocation, sessionId: "foreign-session" }, f.select),
  ).rejects.toThrow();
  await expect(
    f.service.prepare(f.invocation, { ...f.select, planDigest: "f".repeat(64) }),
  ).rejects.toThrow();
  f.revokeOwner();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow();
  expect(f.applied).toEqual([]);
});
test("CAS conflict before dispatch stops rather than retrying any effect", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  f.conflict();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow("state_changed");
  expect(f.applied).toEqual([]);
});
test("real store transition rejects phase regression, replaced receipts, removed approval and stale fence", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  f.lose();
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow();
  const before = f.row().record;
  const changed = (patch: Partial<CentralHostRecord>) => ({ ...before, ...patch });
  expect(() => {
    assertCentralHostTransition(
      before,
      changed({ effects: { ...before.effects, [original.effects[0]]: "idle" } }),
    );
  }).toThrow();
  expect(() => {
    assertCentralHostTransition(before, changed({ approvalReceipts: [] }));
  }).toThrow();
  expect(() => {
    assertCentralHostTransition(
      before,
      changed({ executionLease: { leaseId: id, fenceGeneration: 0 } }),
    );
  }).toThrow();
  const attempt = before.attempts?.[original.effects[0]];
  if (attempt === undefined) {
    throw new Error("missing attempt");
  }
  expect(() => {
    assertCentralHostTransition(
      before,
      changed({
        attempts: {
          ...before.attempts,
          [original.effects[0]]: {
            ...attempt,
            receipt: {
              effect: "prepare-central-resources",
              resourceId: original.control.resource.resourceId,
              resourceVersion: "replaced",
              readbackSha256: "b".repeat(64),
            },
          },
        },
      }),
    );
  }).toThrow();
});
test("caller enrollment performs only its one approved effect and persists the independently observed receipt", async () => {
  const plan = centralHostCallerPlanSchema.parse({
    version: 1,
    kind: "central-integration-host-caller-v1",
    authority: original.authority,
    selection: original.selection,
    profile: original.profile,
    setup: {
      operationRef: centralHostOperationRef(original),
      planDigest: centralHostPlanDigest(original),
    },
    setupAuthority: original.authority,
    central: {
      projectId: original.target.projectId,
      teamId: original.target.teamId,
      installationId: original.target.installationId,
      providerDeploymentId: originalReady.deployment.providerDeploymentId,
      immutableOrigin: originalReady.deployment.immutableOrigin,
      configurationSha256: original.source.configurationSha256,
    },
    caller: {
      projectId: originalReady.caller.projectId,
      ownerId: originalReady.caller.ownerId,
      environment: "production",
      targetEnvironment: "preview",
      provisioningRequestId: id,
      provisioningDigest: "a".repeat(64),
      priorGrantSha256: "b".repeat(64),
    },
    effects: ["authorize-app-central-caller"],
  });
  const f = fixture(plan);
  await f.service.plan(f.invocation, { kind: "caller", appId: plan.selection.initiatingAppId });
  expect(await f.service.prepare(f.invocation, f.select)).toMatchObject({ status: "ready" });
  expect(f.applied).toEqual(["authorize-app-central-caller"]);
  expect(f.row().record.nativeDeployment).toBeUndefined();
  expect(f.row().record.observation).toBeDefined();
});

test("provider grant and per-key accepted IDs stay in the same row and cannot be replaced", async () => {
  const f = fixture();
  const apply = f.ports.applyEffect;
  f.ports.applyEffect = async (context) => {
    if (context.effect === "authorize-central-inspector") {
      await context.checkpoint.recordGrantAttempt({
        beforeSha256: "a".repeat(64),
        afterSha256: "b".repeat(64),
      });
    }
    if (
      context.effect === "bind-central-preview-runtime" &&
      context.plan.kind === "central-integration-host-setup-v1"
    ) {
      for (const entry of context.plan.environment) {
        await context.bindings.claim(entry.key);
        await context.bindings.recordAccepted(entry.key, "accepted-env-id");
        await context.bindings.recordVerified(entry.key);
      }
    }
    await apply(context);
  };
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  await f.service.prepare(f.invocation, f.select);
  const before = f.row().record;
  expect(before.attempts?.["authorize-central-inspector"]?.grantAttempt).toEqual({
    beforeSha256: "a".repeat(64),
    afterSha256: "b".repeat(64),
  });
  expect(before.runtimeBindings?.[original.environment[0].key]).toMatchObject({
    acceptedEnvId: "accepted-env-id",
    state: "applied",
  });
  const binding = before.runtimeBindings?.[original.environment[0].key];
  if (binding?.state !== "applied") {
    throw new Error("missing binding");
  }
  expect(() => {
    assertCentralHostTransition(before, {
      ...before,
      runtimeBindings: {
        ...before.runtimeBindings,
        [original.environment[0].key]: { ...binding, acceptedEnvId: "foreign-env" },
      },
    });
  }).toThrow();
});
test("wrong worker generation cannot settle pending schema or advance to receiver", async () => {
  const f = fixture();
  const reconcile = f.ports.reconcileEffect;
  f.ports.reconcileEffect = async (context) =>
    context.effect === "install-central-schema"
      ? {
          status: "applied",
          receipt: {
            ...receiptFor(context),
            effect: "install-central-schema",
            resourceProfileId: original.resourceProfileId,
            schemaSha256: original.control.schemaSha256,
            configurationSha256: original.source.configurationSha256,
            centralPrincipalGeneration: 999,
          },
        }
      : await reconcile(context);
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  await expect(f.service.prepare(f.invocation, f.select)).rejects.toThrow();
  expect(f.row().record.effects["install-central-schema"]).toBe("pending");
  expect(f.applied).toEqual(["prepare-central-resources", "install-central-schema"]);
});
test("conflicting native identity and late consent revocation remain visible on read", async () => {
  const f = fixture();
  await f.service.plan(f.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  await f.service.prepare(f.invocation, f.select);
  await f.native("deployment.ready");
  const current = f.row();
  await f.store.compareAndSet(current, {
    ...current.record,
    nativeDeployment: {
      status: "conflict",
      providerDeploymentIds: [
        originalReady.deployment.providerDeploymentId,
        "conflicting-native-id",
      ],
    },
  });
  await expect(f.service.read(f.invocation, f.select)).rejects.toThrow(
    "native_deployment_conflict",
  );
  const g = fixture();
  await g.service.plan(g.invocation, { kind: "setup", appId: original.selection.initiatingAppId });
  await g.service.prepare(g.invocation, g.select);
  await g.native("deployment.ready");
  g.revokeCall(g.invocation.callId);
  await expect(g.service.read(g.invocation, g.select)).rejects.toThrow("consent revoked");
});
test("separate revision session receives read-only canonical caller READY pointer without another intent or approval", async () => {
  const f = fixture();
  const receipt = centralHostReadyReceiptSchema.parse(originalReady);
  const revision = {
    ...f.invocation,
    sessionId: "separate-existing-app-revision",
    callId: "revision-plan",
  };
  let originalAuthorityReads = 0;
  f.ports.resolveReady = async (invocation, request) => {
    expect(invocation.sessionId).toBe(revision.sessionId);
    expect(request).toEqual({ kind: "caller", appId: original.selection.initiatingAppId });
    originalAuthorityReads += 1;
    return receipt;
  };
  f.ports.resolvePlan = async () => {
    throw new Error("must not create another intent");
  };
  f.ports.store.reserve = async () => {
    throw new Error("must not reserve another caller row");
  };
  f.ports.readApproval = async () => {
    throw new Error("must not create revision consent");
  };
  const result = await f.service.plan(revision, {
    kind: "caller",
    appId: original.selection.initiatingAppId,
  });
  expect(result).toEqual({ status: "ready", receipt, ...receipt.callerSetup });
  expect(originalAuthorityReads).toBe(1);
  expect("plan" in result).toBe(false);
  expect(centralHostPlanResultSchema.parse(result)).toEqual(result);
  expect(centralHostApprovalInputSchema.safeParse(result).success).toBe(false);
  expect(f.applied).toEqual([]);
});
test("read-only caller reuse rejects foreign receipt authority without reserving intent", async () => {
  const f = fixture();
  f.ports.resolveReady = async () =>
    centralHostReadyReceiptSchema.parse({
      ...originalReady,
      authority: { ...originalReady.authority, ownerUserId: "foreign" },
    });
  await expect(
    f.service.plan(
      { ...f.invocation, sessionId: "revision-session" },
      { kind: "caller", appId: original.selection.initiatingAppId },
    ),
  ).rejects.toThrow("central_host_service_unavailable");
  expect(f.applied).toEqual([]);
});
