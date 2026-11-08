/* oxlint-disable eslint/require-await -- Read-only authority ports are controlled synthetic observations. */
import { expect, it, vi } from "vitest";
import {
  centralHostRecordSchema,
  createReadCentralIntegrationHostReady,
} from "./central-integration-host-store";
import type { CentralHostRow } from "./central-integration-host-store";
import {
  centralHostCallerPlanSchema,
  centralHostPlanDigest,
  centralHostOperationRef,
  centralHostReadyReceiptSchema,
} from "./central-integration-host-contract";
import { plan as original, ready as originalReady } from "./central-integration-host-test-fixture";

const fixture = () => {
  const setupPlan = {
    ...original,
    authority: { ...original.authority, ownerUserId: "infrastructure-owner" },
  };
  const setup: CentralHostRow = {
    operationRef: centralHostOperationRef(setupPlan),
    revision: 8,
    record: centralHostRecordSchema.parse({
      kind: "central-integration-host-journal-v1",
      plan: setupPlan,
      planDigest: centralHostPlanDigest(setupPlan),
      effects: Object.fromEntries(setupPlan.effects.map((effect) => [effect, "applied"])),
      nativeDeployment: {
        status: "accepted",
        providerDeploymentId: originalReady.deployment.providerDeploymentId,
        immutableOrigin: originalReady.deployment.immutableOrigin,
        events: [
          {
            eventId: "actual-native-created",
            eventType: "deployment.created",
            bodySha256: "a".repeat(64),
            projectId: setupPlan.target.projectId,
            teamId: setupPlan.target.teamId,
            providerDeploymentId: originalReady.deployment.providerDeploymentId,
            immutableOrigin: originalReady.deployment.immutableOrigin,
          },
        ],
      },
      approvalReceipts: [
        { approvedAt: "2026-11-03T00:00:00Z", approvedByCallId: "global-setup-call" },
      ],
    }),
  };
  const callerPlan = centralHostCallerPlanSchema.parse({
    version: 1,
    kind: "central-integration-host-caller-v1",
    authority: original.authority,
    selection: original.selection,
    profile: original.profile,
    setup: { operationRef: setup.operationRef, planDigest: setup.record.planDigest },
    setupAuthority: setupPlan.authority,
    central: {
      projectId: original.target.projectId,
      teamId: original.target.teamId,
      installationId: original.target.installationId,
      providerDeploymentId: originalReady.deployment.providerDeploymentId,
      immutableOrigin: originalReady.deployment.immutableOrigin,
      configurationSha256: originalReady.deployment.configurationSha256,
    },
    caller: {
      projectId: originalReady.caller.projectId,
      ownerId: originalReady.caller.ownerId,
      environment: "production",
      targetEnvironment: "preview",
      provisioningRequestId: "11111111-1111-4111-a111-111111111111",
      provisioningDigest: "a".repeat(64),
      priorGrantSha256: "b".repeat(64),
    },
    effects: ["authorize-app-central-caller"],
  });
  const actual = centralHostReadyReceiptSchema.parse({
    ...originalReady,
    setup: callerPlan.setup,
    callerSetup: {
      operationRef: centralHostOperationRef(callerPlan),
      planDigest: centralHostPlanDigest(callerPlan),
    },
  });
  const caller: CentralHostRow = {
    operationRef: centralHostOperationRef(callerPlan),
    revision: 3,
    record: centralHostRecordSchema.parse({
      kind: "central-integration-host-journal-v1",
      plan: callerPlan,
      planDigest: centralHostPlanDigest(callerPlan),
      effects: { "authorize-app-central-caller": "applied" },
      approvalReceipts: [
        { approvedAt: "2026-11-03T00:00:00Z", approvedByCallId: "app-caller-call" },
      ],
      observation: actual,
    }),
  };
  const request = {
    authority: callerPlan.authority,
    appId: callerPlan.selection.initiatingAppId,
    appProjectId: callerPlan.caller.projectId,
    teamId: callerPlan.central.teamId,
    assertCurrentOwner: vi.fn(async () => {}),
    signal: new AbortController().signal,
  };
  const ports = {
    store: {
      read: vi.fn(async () => structuredClone(setup)),
      readReadyCaller: vi.fn(async () => structuredClone(caller)),
    },
    assertSetupAuthorized: vi.fn(async () => {}),
    observe: vi.fn(async () => structuredClone(actual)),
  };
  return {
    actual,
    caller,
    ports,
    read: createReadCentralIntegrationHostReady(ports),
    request,
    setup,
  };
};
it("requires independently current setup and app-caller authority with separate global ownership", async () => {
  const f = fixture();
  expect(await f.read(f.request)).toEqual(f.actual);
  expect(f.ports.store.read).toHaveBeenCalledWith(
    f.setup.record.plan.authority,
    f.setup.operationRef,
  );
  expect(f.ports.assertSetupAuthorized).toHaveBeenCalledTimes(2);
  expect(f.request.assertCurrentOwner).toHaveBeenCalledTimes(2);
});
it("does not return a ready-looking caller before every setup effect is complete", async () => {
  const f = fixture();
  f.setup.record.effects["install-central-schema"] = "pending";
  await expect(f.read(f.request)).rejects.toThrow("central_integration_host_unavailable");
  expect(f.ports.observe).not.toHaveBeenCalled();
});
it("does not adopt another app's caller or select a different central deployment", async () => {
  const f = fixture();
  await expect(f.read({ ...f.request, appId: "foreign-app" })).rejects.toThrow();
  f.ports.observe.mockResolvedValue({
    ...f.actual,
    deployment: { ...f.actual.deployment, providerDeploymentId: "other-provider-id" },
  });
  await expect(f.read(f.request)).rejects.toThrow("central_integration_host_unavailable");
});
it("honors owner and global authority revocation after readback", async () => {
  const f = fixture();
  f.request.assertCurrentOwner.mockRejectedValueOnce(new Error("owner-revoked"));
  await expect(f.read(f.request)).rejects.toThrow("owner-revoked");
  expect(f.ports.store.readReadyCaller).not.toHaveBeenCalled();
  const g = fixture();
  g.ports.assertSetupAuthorized
    .mockResolvedValueOnce()
    .mockRejectedValueOnce(new Error("setup-revoked"));
  await expect(g.read(g.request)).rejects.toThrow("setup-revoked");
});
it("rejects ready receipts bound to another plan or incomplete caller effects", () => {
  const f = fixture();
  expect(
    centralHostRecordSchema.safeParse({
      ...f.caller.record,
      effects: { "authorize-app-central-caller": "pending" },
    }).success,
  ).toBe(false);
  expect(
    centralHostRecordSchema.safeParse({
      ...f.caller.record,
      observation: {
        ...f.actual,
        callerSetup: { ...f.actual.callerSetup, planDigest: "0".repeat(64) },
      },
    }).success,
  ).toBe(false);
});
