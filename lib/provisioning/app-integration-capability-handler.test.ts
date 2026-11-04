import { IntegrationProviderError } from "./app-integration-provider-diagnostic";
import { appIntegrationCapabilityResultSchema } from "./app-integration-capability-transport";
/* oxlint-disable eslint/require-await -- Durable adapters are controlled test ports. */
import { integrationCapabilityV2PlanInput } from "./app-integration-capability-v2-test-fixture";
import { expect, test, vi } from "vitest";
import { createAppIntegrationCapabilityHandler } from "./app-integration-capability-handler";
import type { AppIntegrationCapabilityPorts } from "./app-integration-capability-handler";
import { initialAppIntegrationCapabilityRecord } from "./app-integration-capability-store";
import type { AppIntegrationCapabilityWorker } from "./app-integration-capability-ports";
import type { AppIntegrationCapabilityRow } from "./app-integration-capability-store";
import type {
  IntegrationCapabilityReceipt,
  AppIntegrationCapabilityPlan,
} from "./app-integration-capability-contract";
import {
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanSchema,
} from "./app-integration-capability-contract";
import { integrationCapabilityPlan as plan } from "./app-integration-capability-test-fixture";

const invocation = {
  authority: plan.authority,
  sessionId: plan.selection.sessionId,
  callId: "current-call",
  signal: new AbortController().signal,
};
const fixture = (selectedPlan: AppIntegrationCapabilityPlan = plan) => {
  let row: AppIntegrationCapabilityRow | undefined;
  const receipts = new Map<string, IntegrationCapabilityReceipt>();
  const writes: string[] = [];
  const receipt = (
    effect: (typeof selectedPlan.effects)[number],
    generation: number,
  ): IntegrationCapabilityReceipt => {
    const resourceVersion = `verified-${effect}`;
    switch (effect) {
      case "prepare-control-database": {
        return {
          effect,
          resourceVersion,
          resourceId: selectedPlan.control.database.resourceId,
          database: selectedPlan.control.database.database,
          runtimeRole: selectedPlan.control.database.runtimeRole,
          migratorRole: selectedPlan.control.database.migratorRole,
        };
      }
      case "install-control-schema": {
        return { effect, resourceVersion, schemaSha256: selectedPlan.control.schema.sha256 };
      }
      case "bind-service-memberships": {
        return {
          effect,
          resourceVersion,
          memberships: selectedPlan.serviceMemberships.map((member) => ({
            ...member,
            fenceGeneration: generation,
          })),
        };
      }
      case "register-central-app": {
        return {
          effect,
          resourceVersion,
          appId: selectedPlan.selection.appId,
          resourceProfileId: selectedPlan.control.resourceProfileId,
          principalGeneration: generation,
          registrationRef: appIntegrationCapabilityOperationRef(selectedPlan),
          registrationDigest: "7".repeat(64),
        };
      }
      case "prepare-provider-destination": {
        const target = selectedPlan.providerDestination;
        if (target === undefined)
          {throw new Error("version-one fixture has no provider destination");}
        return {
          effect,
          destinationId: "fixture-accepted-destination",
          name: target.name,
          url: new URL(target.path, target.origin).href,
          secretRef: "11111111-1111-4111-a111-111111111111",
          secretSha256: "a".repeat(64),
        };
      }
      default: {
        throw new Error("unexpected effect");
      }
    }
  };
  const ports: AppIntegrationCapabilityPorts = {
    store: {
      read: async () => (row === undefined ? undefined : structuredClone(row)),
      reserve: async (selected) => {
        row ??= {
          operationRef: appIntegrationCapabilityOperationRef(selected),
          revision: 1,
          record: initialAppIntegrationCapabilityRecord(selected),
        };
        return structuredClone(row);
      },
      compareAndSet: async (previous, record) => {
        if (row?.revision !== previous.revision) {
          return;
        }
        row = { ...row, record: structuredClone(record), revision: row.revision + 1 };
        return structuredClone(row);
      },
      claimLease: async () => row,
    },
    resolvePlan: async () => selectedPlan,
    assertAuthorized: vi.fn(async () => {}),
    withTargetLease: async (_inv, _plan, run) => {
      if (!row) {
        throw new Error("missing");
      }
      row = {
        ...row,
        revision: row.revision + 1,
        record: {
          ...row.record,
          executionLease: { leaseId: "88888888-8888-4888-a888-888888888888", fenceGeneration: 9 },
        },
      };
      return await run();
    },
    worker: {
      reconcile: vi.fn<AppIntegrationCapabilityWorker["reconcile"]>(async (context) => {
        expect(context.priorPhase).toBe("pending");
        const observed = receipts.get(context.effect);
        if (observed !== undefined) {
          return { status: "applied" as const, receipt: observed };
        }
        if (context.priorPhase === "pending") {
          return { status: "unknown" as const };
        }
        return {
          status: "not-applied" as const,
          proof: "authoritative-effect-not-applied" as const,
        };
      }),
      execute: vi.fn<AppIntegrationCapabilityWorker["execute"]>(async (context) => {
        expect(row?.record.effects[context.effect]?.state).toBe("pending");
        writes.push(context.effect);
        const result = receipt(context.effect, context.attemptGeneration);
        receipts.set(context.effect, result);
        return result;
      }),
    },
    finalize: async () => {
      const project = (resource: typeof selectedPlan.control.database) => ({
        resourceId: resource.resourceId,
        hostname: resource.hostname,
        port: resource.port,
        database: resource.database,
        schema: resource.schema,
        runtimeRole: resource.runtimeRole,
      });
      const appDatabase = project(selectedPlan.runtime.appDatabase);
      const database = project(selectedPlan.control.database);
      return {
        kind: "app-integrations-development-v1",
        appId: selectedPlan.selection.appId,
        environment: "development",
        resourceProfile: "isolated-development",
        release: {
          id: selectedPlan.release.id,
          manifestSha256: selectedPlan.release.manifestSha256,
          artifactSha256: selectedPlan.release.artifactSha256,
        },
        appDatabase,
        control: {
          origin: selectedPlan.control.origin,
          resourceProfileId: selectedPlan.control.resourceProfileId,
          database,
          activationKeyId: selectedPlan.control.activationKeyId,
          activationPublicKeySha256: selectedPlan.control.activationPublicKeySha256,
          principalGeneration: 9,
        },
        provider: selectedPlan.provider,
        ...(selectedPlan.machineIngress === undefined
          ? {}
          : { machineIngress: selectedPlan.machineIngress }),
        ...(selectedPlan.version === 2
          ? {
              providerDestination: {
                destinationId: "fixture-accepted-destination",
                name: selectedPlan.providerDestination?.name ?? "",
                url: new URL(
                  selectedPlan.providerDestination?.path ?? "",
                  selectedPlan.publicOrigin,
                ).href,
                secretSha256: "a".repeat(64),
              },
            }
          : {}),
        serviceMemberships: selectedPlan.serviceMemberships.map((member) => ({
          ...member,
          fenceGeneration: 9,
        })),
        privateConfiguration: {
          reference: selectedPlan.privateConfigurationSeed.reference,
          sha256: "8".repeat(64),
        },
      };
    },
  };
  return {
    ports,
    writes,
    receipts,
    receipt,
    handler: createAppIntegrationCapabilityHandler(ports),
    read: () => {
      if (row === undefined) {
        throw new Error("missing");
      }
      return row;
    },
    set: (value: AppIntegrationCapabilityRow) => {
      row = value;
    },
  };
};
test("approved capability executes resource/schema/actor/registration in order and replays without writes", async () => {
  const f = fixture();
  const selected = await f.handler.plan(invocation, plan.selection.appId);
  const first = await f.handler.prepare(invocation, selected.operationRef, selected.planDigest);
  expect(first.status).toBe("prepared");
  expect(f.writes).toEqual(plan.effects);
  const replay = await f.handler.prepare(invocation, selected.operationRef, selected.planDigest);
  expect(replay.status).toBe("prepared");
  expect(f.writes).toHaveLength(4);
});
test("pending unknown remains visible and is never blindly retried", async () => {
  const f = fixture();
  const selected = await f.handler.plan(invocation, plan.selection.appId);
  const row = f.read();
  f.set({
    ...row,
    record: {
      ...row.record,
      effects: {
        ...row.record.effects,
        "prepare-control-database": { state: "pending", attemptGeneration: 4, retiredAttempts: [] },
      },
    },
  });
  const pending = await f.handler.prepare(invocation, selected.operationRef, selected.planDigest);
  expect(pending.status).toBe("reconciliation-required");
  expect(f.writes).toEqual([]);
});
test("revoked ordinary approval and foreign owner deny before provider effects", async () => {
  const f = fixture();
  const selected = await f.handler.plan(invocation, plan.selection.appId);
  vi.mocked(f.ports.assertAuthorized).mockRejectedValue(new Error("revoked"));
  await expect(
    f.handler.prepare(invocation, selected.operationRef, selected.planDigest),
  ).rejects.toThrow("revoked");
  await expect(
    f.handler.prepare(
      { ...invocation, authority: { ...invocation.authority, ownerUserId: "foreign" } },
      selected.operationRef,
      selected.planDigest,
    ),
  ).rejects.toThrow("app_integration_capability_unavailable");
  expect(f.writes).toEqual([]);
});

test("new consent executes all five v2 effects once and replays the frozen create intent", async () => {
  const current = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
    const f = fixture(current);
  const planned = await f.handler.plan(invocation, current.selection.appId);
  const first = await f.handler.prepare(invocation, planned.operationRef, planned.planDigest);
  expect(first.status).toBe("prepared");
  expect(f.writes).toEqual(current.effects);
  const replay = await f.handler.prepare(invocation, planned.operationRef, planned.planDigest);
  expect(replay.status).toBe("prepared");
  expect(f.writes).toEqual(current.effects);
  expect(f.read().record.plan.providerDestination?.existing).toBeUndefined();
});
test("an uncertain destination remains pending after earlier SQL effects and cannot be resent", async () => {
  const current = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
    const f = fixture(current);
  const planned = await f.handler.plan(invocation, current.selection.appId);
    const row = f.read();
  const effects = {
    ...row.record.effects,
    "prepare-provider-destination": {
      state: "pending" as const,
      attemptGeneration: 9,
      retiredAttempts: [],
    },
  };
  for (const effect of [
    "prepare-control-database",
    "install-control-schema",
    "bind-service-memberships",
  ] as const) {
    effects[effect] = {
      state: "applied",
      attemptGeneration: 9,
      retiredAttempts: [],
      receipt: f.receipt(effect, 9),
    };
  }
  f.set({ ...row, record: { ...row.record, effects } });
  const outcome = await f.handler.prepare(invocation, planned.operationRef, planned.planDigest);
  expect(outcome.status).toBe("reconciliation-required");
  expect(f.writes).toEqual([]);
  expect(f.read().record.effects["prepare-provider-destination"]?.state).toBe("pending");
});

test("provider diagnostics survive durable pending recovery without re-dispatching the rejected destination", async () => {
  const selectedPlan = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
  const f = fixture(selectedPlan);
  const execute = vi.mocked(f.ports.worker.execute).getMockImplementation();
  if (execute === undefined) {
    throw new Error("Missing fixture execution");
  }
  const diagnostic = {
    provider: "ampersand" as const,
    statusCode: 403,
    code: "forbidden" as const,
    requestRef: "request-safe-403",
  };
  vi.mocked(f.ports.worker.execute).mockImplementation(async (context) => {
    if (context.effect === "prepare-provider-destination") {
      throw new IntegrationProviderError(diagnostic);
    }
    return await execute(context);
  });
  const selected = await f.handler.plan(invocation, selectedPlan.selection.appId);
  const first = await f.handler.prepare(invocation, selected.operationRef, selected.planDigest);
  expect(appIntegrationCapabilityResultSchema.parse(first)).toMatchObject({
    status: "reconciliation-required",
    effect: "prepare-provider-destination",
    diagnostic,
  });
  expect(f.read().record.providerDiagnostic).toEqual(diagnostic);
  expect(f.read().record.effects["prepare-provider-destination"]?.state).toBe("pending");
  const dispatched = vi.mocked(f.ports.worker.execute).mock.calls.length;
  const second = await createAppIntegrationCapabilityHandler(f.ports).prepare(
    { ...invocation, callId: "later-current-approved-call" },
    selected.operationRef,
    selected.planDigest,
  );
  expect(second).toEqual(first);
  expect(vi.mocked(f.ports.worker.execute).mock.calls.length).toBe(dispatched);
  expect(f.read().record.providerDiagnostic).toEqual(diagnostic);
});
