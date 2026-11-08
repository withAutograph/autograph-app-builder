import type {
  RetentionProviderBinding,
  RetainedIntegrationReadScope,
} from "./public-release-retained-integrations";
/* oxlint-disable eslint/require-await -- Provider/history/store ports are controlled read-only Promise fixtures. */
import { createHash } from "node:crypto";
import { expect, test, vi } from "vitest";
import { createRetainedOptionalIntegrationReader } from "./public-release-retained-integrations";
import {
  publicReleasePlanSchema,
  publicReleasePlanDigest,
  publicReleaseOperationRef,
  publicReleaseRecordSchema,
} from "./public-release-contract";
import { appIntegrationCapabilityRecordSchema } from "./app-integration-capability-contract";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import { integrationCapabilityPlan as capPlan } from "./app-integration-capability-test-fixture";
import { integrationTestAttachment as attachment } from "./app-integration-release-test-fixture";
import { plan as base } from "./public-release-test-fixture";

const fixture = () => {
  const sourcePlan = publicReleasePlanSchema.parse({
    ...base,
    purpose: "application",
    publicOrigin: capPlan.publicOrigin,
    runtime: {
      ...base.runtime,
      releaseId: capPlan.release.id,
      operationRef: capPlan.runtime.operationRef,
      planDigest: capPlan.runtime.planDigest,
    },
    integrationCapability: attachment,
    environment: [
      ...base.environment,
      {
        key: "APP_INTEGRATIONS_CAPABILITY",
        sha256: createHash("sha256").update(JSON.stringify(attachment.capability)).digest("hex"),
      },
      {
        key: "APP_INTEGRATIONS_RUNTIME_CONFIGURATION",
        sha256: attachment.capability.privateConfiguration.sha256,
      },
    ],
  });
  const sourceRef = publicReleaseOperationRef(sourcePlan);
  const publicReceipt = {
    approvalId: "source-public-approval",
    approvedByCallId: "source-public-call",
  };
  const capReceipt = { approvalId: "source-cap-approval", approvedByCallId: "source-cap-call" };
  const provider: [RetentionProviderBinding, RetentionProviderBinding] = [
    {
      id: "env-cap",
      key: "APP_INTEGRATIONS_CAPABILITY",
      operationRef: sourceRef,
      sha256:
        sourcePlan.environment.find((entry) => entry.key === "APP_INTEGRATIONS_CAPABILITY")
          ?.sha256 ?? "missing",
    },
    {
      id: "env-config",
      key: "APP_INTEGRATIONS_RUNTIME_CONFIGURATION",
      operationRef: sourceRef,
      sha256: attachment.capability.privateConfiguration.sha256,
    },
  ];
  const source = {
    operationRef: sourceRef,
    revision: 1,
    record: publicReleaseRecordSchema.parse({
      kind: "public-app-release-v1",
      plan: sourcePlan,
      planDigest: publicReleasePlanDigest(sourcePlan),
      approvalReceipts: [publicReceipt],
      bindings: Object.fromEntries(
        provider.map((binding) => [binding.key, { acceptedEnvId: binding.id, state: "applied" }]),
      ),
      effects: { "bind-production-runtime": "applied", "publish-release-source": "applied" },
      observation: {
        deploymentId: "source-native-deployment",
        environment: "production",
        projectId: sourcePlan.project.projectId,
        publicOrigin: sourcePlan.publicOrigin,
        releaseId: sourcePlan.runtime.releaseId,
        status: "ready",
      },
    }),
  };
  const resource = capPlan.control.database;
  const cap = {
    operationRef: attachment.operationRef,
    revision: 1,
    record: appIntegrationCapabilityRecordSchema.parse({
      kind: "app-integrations-capability-v1",
      plan: capPlan,
      planDigest: attachment.planDigest,
      approvalReceipts: [capReceipt],
      prepared: attachment.capability,
      effects: {
        "prepare-control-database": {
          receipt: {
            effect: "prepare-control-database",
            resourceVersion: "control-v1",
            resourceId: resource.resourceId,
            database: resource.database,
            runtimeRole: resource.runtimeRole,
            migratorRole: resource.migratorRole,
          },
          state: "applied",
        },
        "install-control-schema": {
          receipt: {
            effect: "install-control-schema",
            resourceVersion: "schema-v1",
            schemaSha256: capPlan.control.schema.sha256,
          },
          state: "applied",
        },
        "bind-service-memberships": {
          receipt: {
            effect: "bind-service-memberships",
            resourceVersion: "members-v1",
            memberships: attachment.capability.serviceMemberships,
          },
          state: "applied",
        },
        "register-central-app": {
          receipt: {
            effect: "register-central-app",
            resourceVersion: "registry-v1",
            appId: capPlan.selection.appId,
            resourceProfileId: capPlan.control.resourceProfileId,
            registrationRef: attachment.operationRef,
            registrationDigest: "3".repeat(64),
            principalGeneration: attachment.capability.control.principalGeneration,
          },
          state: "applied",
        },
      },
    }),
  };
  const publicStore = {
    read: vi.fn(async () => structuredClone(source)),
    reserve: vi.fn(),
    compareAndSet: vi.fn(),
  };
  const capStore = {
    read: vi.fn(async () => structuredClone(cap)),
    reserve: vi.fn(),
    compareAndSet: vi.fn(),
    claimLease: vi.fn(),
  };
  const publicApproval = vi.fn(async (_plan: typeof sourcePlan, _callId: string) => publicReceipt);
  const capApproval = vi.fn(async (_plan: typeof capPlan, _callId: string) => capReceipt);
  const sourceOwner = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "source-native",
    authority: capPlan.authority,
    kind: "direct",
    principal: { ...capPlan.authority, scopes: ["autograph:send"] },
    sessionId: capPlan.selection.sessionId,
  });
  const input: RetainedIntegrationReadScope = {
    owner: { ...sourceOwner, sessionId: "revision-session", adapterSessionId: "revision-native" },
    authority: {
      verifyWorkload: vi.fn<() => Promise<void>>().mockResolvedValue(),
      assertCanonicalAppOwner: vi.fn<() => Promise<void>>().mockResolvedValue(),
    },
    owned: {
      purpose: "auth-bootstrap",
      selection: { appId: capPlan.selection.appId },
      destination: capPlan.project,
      operator: {
        plan: {
          appDatabase: capPlan.runtime.appDatabase,
          neon: {
            projectId: capPlan.runtime.neon.projectId,
            branchId: capPlan.runtime.neon.branchId,
            endpoint: capPlan.runtime.appDatabase.hostname,
            source: "synthetic-only",
            connectionRef: "normal-source-connection",
          },
        },
      },
    },
    publicOrigin: capPlan.publicOrigin,
    assertCurrent: vi.fn<() => Promise<void>>().mockResolvedValue(),
    readSourceOwner: vi.fn(async () => sourceOwner),
    readProviderBindings: vi.fn(async () => structuredClone(provider)),
  };
  const reader = createRetainedOptionalIntegrationReader({
    publicReleases: publicStore,
    capabilities: capStore,
    readPublicApproval: async ({ plan, owner, callId }) => {
      expect(owner.sessionId).toBe(capPlan.selection.sessionId);
      return await publicApproval(plan, callId);
    },
    readCapabilityApproval: async ({ plan, owner, callId }) => {
      expect(owner.sessionId).toBe(capPlan.selection.sessionId);
      return await capApproval(plan, callId);
    },
  });
  return {
    input,
    provider,
    source,
    cap,
    publicStore,
    capStore,
    publicApproval,
    capApproval,
    reader,
  };
};
test("new-session Auth bootstrap retains only exact prior owned approved bindings without mutation", async () => {
  const f = fixture();
  const retained = await f.reader(f.input);
  expect(retained).toHaveLength(2);
  expect(retained?.every((entry) => entry.sourceOperationRef === f.source.operationRef)).toBe(true);
  expect(f.input.readSourceOwner).toHaveBeenCalledWith({
    appId: capPlan.selection.appId,
    sessionId: capPlan.selection.sessionId,
  });
  expect(f.publicApproval).toHaveBeenCalledWith(f.source.record.plan, "source-public-call");
  expect(f.capApproval).toHaveBeenCalledWith(f.cap.record.plan, "source-cap-call");
  expect(f.publicStore.compareAndSet).not.toHaveBeenCalled();
  expect(f.capStore.compareAndSet).not.toHaveBeenCalled();
});
test.each(["hash", "row-id", "mixed-operation", "resource", "uncertain-source"] as const)(
  "foreign or uncertain retained binding fails closed: %s",
  async (change) => {
    const f = fixture();
    if (change === "hash") {
      f.provider[0].sha256 = "f".repeat(64);
    }
    if (change === "row-id") {
      f.provider[0].id = "foreign-row";
    }
    if (change === "mixed-operation") {
      f.provider[0].operationRef = "99999999-9999-4999-a999-999999999999";
    }
    if (change === "resource") {
      f.input.owned.operator.plan.appDatabase = {
        ...f.input.owned.operator.plan.appDatabase,
        resourceId: "foreign-resource",
      };
    }
    if (change === "uncertain-source") {
      delete f.source.record.observation;
    }
    await expect(f.reader(f.input)).rejects.toThrow("Complete and select");
    expect(f.publicStore.compareAndSet).not.toHaveBeenCalled();
  },
);
test("revoked original approval or changed provider readback never authorizes retention", async () => {
  const f = fixture();
  f.capApproval.mockRejectedValue(new Error("revoked"));
  await expect(f.reader(f.input)).rejects.toThrow("revoked");
  const g = fixture();
  vi.mocked(g.input.readProviderBindings)
    .mockResolvedValueOnce(structuredClone(g.provider))
    .mockResolvedValueOnce(g.provider.map((entry) => ({ ...entry, sha256: "f".repeat(64) })));
  await expect(g.reader(g.input)).rejects.toThrow("Complete and select");
});

test("application removal explicitly opts into the same exact original custody checks", async () => {
  const f = fixture();
  f.input.owned.purpose = "application";
  await expect(f.reader(f.input)).rejects.toThrow();
  const removalInput = { ...f.input, allowApplicationRemoval: true as const };
  const retained = await f.reader(removalInput);
  expect(retained?.map((entry) => entry.acceptedEnvId)).toEqual(["env-cap", "env-config"]);
  f.capApproval.mockRejectedValue(new Error("original_capability_approval_revoked"));
  await expect(f.reader(removalInput)).rejects.toThrow("original_capability_approval_revoked");
});
