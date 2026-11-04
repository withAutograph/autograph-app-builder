/* oxlint-disable eslint/require-await -- Synthetic trusted ports exercise dispatch and durable checkpoints without providers. */
import { expect, it, vi } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { createAppIntegrationCapabilitySandboxWorker } from "./app-integration-capability-sandbox-worker";
import type { AppIntegrationWorkerPrivateFiles } from "./app-integration-capability-sandbox-worker";
import type { AppIntegrationCapabilityEffectContext } from "./app-integration-capability-ports";
import { integrationCapabilityV2PlanInput } from "./app-integration-capability-v2-test-fixture";
import type {
  AppIntegrationCapabilityPlan,
  IntegrationCapabilityReceipt,
} from "./app-integration-capability-contract";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityPlanDigest,
} from "./app-integration-capability-contract";
import { integrationCapabilityPlan as legacyPlan } from "./app-integration-capability-test-fixture";
import type { runAppIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const fixture = (
  effect: AppIntegrationCapabilityEffectContext["effect"] = "install-control-schema",
  selectedPlan: AppIntegrationCapabilityPlan = legacyPlan,
) => {
  const plan = selectedPlan;
  let accepted: IntegrationCapabilityReceipt | undefined;
  const context: AppIntegrationCapabilityEffectContext = {
    plan,
    operationRef: appIntegrationCapabilityOperationRef(plan),
    planDigest: appIntegrationCapabilityPlanDigest(plan),
    effect,
    priorPhase: "pending",
    fenceGeneration: 7,
    attemptGeneration: 7,
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "current-call",
      signal: new AbortController().signal,
    },
    assertCurrent: vi.fn(async () => {}),
    checkpoint: {
      read: async () => accepted,
      recordAccepted: vi.fn(async (receipt: IntegrationCapabilityReceipt) => {
        accepted = receipt;
      }),
    },
  };
  const url = (resource: typeof plan.control.database, purpose: "migrator" | "runtime") =>
    `postgresql://${purpose === "migrator" ? resource.migratorRole : resource.runtimeRole}:private@${resource.hostname}/${resource.database}?sslmode=verify-full`;
  const files: AppIntegrationWorkerPrivateFiles = {
    connections: {
      controlMigrator: url(plan.control.database, "migrator"),
      controlRuntime: url(plan.control.database, "runtime"),
      applicationMigrator: url(plan.runtime.appDatabase, "migrator"),
      applicationRuntime: url(plan.runtime.appDatabase, "runtime"),
    },
    // oxlint-disable-next-line sonarjs/no-hardcoded-passwords -- Disposable private worker inputs, never a live credential.
    controlCredentials: {
      migratorPassword: randomUUID(),
      runtimePassword: randomUUID(),
    },
    controlBootstrap: {
      databaseUrl: `postgresql://owner:private@${plan.control.database.hostname}/neondb?sslmode=verify-full`,
      role: "owner",
      maintenanceDatabase: "neondb",
    },
  };
  const configuration = {
    image: "pinned-source",
    projectId: "operator-project",
    teamId: "owned-team",
    workers: {},
    integrationWorker: {
      executablePath: "/workers/integration",
      id: plan.worker.reference,
      sha256: plan.worker.sha256,
      operationScope: "app-integration-bootstrap-v1" as const,
      subcommand: "integration-control-schema" as const,
    },
    resourcesWorker: {
      executablePath: "/workers/resources",
      id: "neon-resource-bootstrap-v1",
      sha256: "a".repeat(64),
      operationScope: "neon-resource-bootstrap-v1" as const,
      subcommand: "neon-resource-bootstrap" as const,
    },
  };
  const run = vi.fn<typeof runAppIntegrationFileSpool>(async (_configuration, input) => {
    if (!input.readOnly) {
      expect(await context.checkpoint.read()).toBeUndefined();
      if (!input.recordCheckpoint) throw new Error("checkpoint required");
      await input.recordCheckpoint({
        contextDigest: "a".repeat(64),
        effectId: effect === "prepare-control-database" ? "resources:acl" : effect,
        fenceGeneration: 7,
        operationId: context.operationRef,
        resourceId: plan.control.database.resourceId,
        sequence: 1,
        tenantId: null,
        receipt: { state: "applied", readbackSha256: "b".repeat(64) },
      });
      expect(await context.checkpoint.read()).toBeDefined();
      return null;
    }
    const common = {
      version: 1 as const,
      operation_id: context.operationRef,
      context_digest: "a".repeat(64),
      fence_generation: 7,
      status: "applied" as const,
      readback_sha256: "b".repeat(64),
    };
    if (effect === "prepare-control-database")
      return {
        ...common,
        resource_id: plan.control.database.resourceId,
        scope: "integration_control_database" as const,
      };
    return {
      ...common,
      receipt:
        effect === "install-control-schema"
          ? {
              resourceId: plan.control.database.resourceId,
              schemaSha256: plan.control.schema.sha256,
            }
          : {
              appId: plan.selection.appId,
              releaseId: plan.release.id,
              serviceMemberships: plan.serviceMemberships.map((member) => ({
                ...member,
                fenceGeneration: 7,
              })),
            },
    };
  });
  const worker = createAppIntegrationCapabilitySandboxWorker({
    configuration,
    readPrivateFiles: async () => files,
    run,
  });
  return { context, files, configuration, run, worker };
};
it("persists the bounded accepted receipt before write acknowledgement and independently reads actual scope", async () => {
  const f = fixture();
  const result = await f.worker.execute(f.context);
  expect(result.effect).toBe("install-control-schema");
  expect(f.context.checkpoint.recordAccepted).toHaveBeenCalledOnce();
  expect(f.run.mock.calls.map(([, input]) => input.readOnly)).toEqual([false, true]);
  expect(f.run.mock.calls[0]?.[1].context.resource.provider_project_id).toBe(
    legacyPlan.control.neon.projectId,
  );
  expect(f.run.mock.calls[0]?.[1].startupFiles["app-integration-connections.json"]).toBeInstanceOf(
    Buffer,
  );
});
it("uses the distinct control Neon resource and explicit fixed allocation scope", async () => {
  const f = fixture("prepare-control-database");
  await f.worker.execute(f.context);
  const wire = f.run.mock.calls[0]?.[1].context;
  expect(wire).toMatchObject({
    kind: "neon_resource_bootstrap",
    app_id: "integrations",
    resource: {
      scope: "integration_control_database",
      provider_project_id: legacyPlan.control.neon.projectId,
      provider_branch_id: legacyPlan.control.neon.branchId,
      credentials_sha256: sha(JSON.stringify(f.files.controlCredentials)),
    },
  });
  expect(wire?.resource.provider_project_id).not.toBe(legacyPlan.runtime.neon.projectId);
  expect(
    JSON.parse(
      f.run.mock.calls[0]?.[1].startupFiles["app-integration-approved-plan.json"]?.toString() ??
        "null",
    ),
  ).toEqual(legacyPlan);
});
it("keeps an uncertain pending effect unknown without a write or manufactured nonapplication proof", async () => {
  const f = fixture();
  f.run.mockRejectedValueOnce(new Error("provider unavailable"));
  expect(await f.worker.reconcile(f.context)).toEqual({ status: "unknown" });
  it("does not retarget a retained v1 resource effect when a new integration catalog is configured", async () => {
    const f = fixture("prepare-control-database");
    const worker = createAppIntegrationCapabilitySandboxWorker({
      configuration: {
        ...f.configuration,
        integrationResourcesWorker: {
          ...f.configuration.resourcesWorker,
          executablePath: "/workers/new-integration-resources",
          sha256: "b".repeat(64),
        },
      },
      readPrivateFiles: async () => f.files,
      run: f.run,
    });
    await worker.execute(f.context);
    expect(f.run).toHaveBeenCalled();
    expect(
      f.run.mock.calls.every(
        ([, input]) =>
          input.worker.executablePath === f.configuration.resourcesWorker.executablePath,
      ),
    ).toBe(true);
  });
  expect(f.run.mock.calls[0]?.[1].readOnly).toBe(true);
  expect(f.context.checkpoint.recordAccepted).not.toHaveBeenCalled();
});
it("does not substitute a newer lease generation for accepted service membership generation", async () => {
  const f = fixture("bind-service-memberships");
  f.context.fenceGeneration = 9;
  expect(await f.worker.reconcile(f.context)).toMatchObject({
    status: "applied",
    receipt: { memberships: [{ fenceGeneration: 7 }] },
  });
  expect(f.run.mock.calls[0]?.[1].context.operation.fence_generation).toBe(9);
});
it("denies a transplanted sealed registration before allocating compute", async () => {
  const f = fixture("register-central-app");
  f.files.authority = {
    kind: "app-integration-application-authority-v1",
    resourceProfileId: legacyPlan.control.resourceProfileId,
    appId: legacyPlan.selection.appId,
    registrationIdentitySha256: legacyPlan.control.registrationIdentitySha256,
    operationRef: f.context.operationRef,
    planDigest: f.context.planDigest,
    principalName: legacyPlan.control.database.runtimeRole,
    principalGeneration: 7,
    customerIds: ["foreign-tenant"],
    scopeSha256: "a".repeat(64),
    configurationRef: legacyPlan.privateConfigurationSeed.reference,
    configurationSha256: "b".repeat(64),
    authoritySha256: "c".repeat(64),
    keyId: "fixture",
    active: true,
    sealed: { encryptedToken: "opaque", tokenIv: "opaque", tokenTag: "opaque" },
  };
  await expect(f.worker.execute(f.context)).rejects.toThrow("app_integration_worker_unavailable");
  expect(f.run).not.toHaveBeenCalled();
});

it("dispatches a v2 resource effect only through its approved integration-only executable", async () => {
  const plan = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
  const f = fixture("prepare-control-database", plan);
  const selected = {
    ...f.configuration.resourcesWorker,
    executablePath: "/workers/pinned-integration-resources",
  };
  const worker = createAppIntegrationCapabilitySandboxWorker({
    configuration: { ...f.configuration, integrationResourcesWorker: selected },
    readPrivateFiles: async () => f.files,
    run: f.run,
  });
  await worker.execute(f.context);
  expect(f.context.checkpoint.recordAccepted).toHaveBeenCalledOnce();
  expect(
    f.run.mock.calls.map(([, input]) => ({
      path: input.worker.executablePath,
      readOnly: input.readOnly,
    })),
  ).toEqual([
    { path: selected.executablePath, readOnly: false },
    { path: selected.executablePath, readOnly: true },
  ]);
  expect(
    JSON.parse(
      f.run.mock.calls[0]?.[1].startupFiles["app-integration-approved-plan.json"]?.toString() ??
        "null",
    ),
  ).toEqual(plan);
});
it.each(["missing", "hash", "id", "scope"])(
  "denies a v2 resource %s catalog mismatch before any SQL dispatch",
  async (mismatch) => {
    const plan = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
    const f = fixture("prepare-control-database", plan);
    const descriptor = {
      ...f.configuration.resourcesWorker,
      ...(mismatch === "hash" ? { sha256: "b".repeat(64) } : {}),
      ...(mismatch === "id" ? { id: "different-resource-worker" } : {}),
      ...(mismatch === "scope" ? { operationScope: "app-integration-bootstrap-v1" as const } : {}),
    };
    const worker = createAppIntegrationCapabilitySandboxWorker({
      configuration: {
        ...f.configuration,
        ...(mismatch === "missing" ? {} : { integrationResourcesWorker: descriptor }),
      },
      readPrivateFiles: async () => f.files,
      run: f.run,
    });
    await expect(worker.execute(f.context)).rejects.toThrow("app_integration_worker_unavailable");
    expect(f.run).not.toHaveBeenCalled();
    expect(f.context.checkpoint.recordAccepted).not.toHaveBeenCalled();
  },
);
it("keeps a v2 provider destination effect out of the SQL adapter and private file reader", async () => {
  const plan = appIntegrationCapabilityPlanSchema.parse(integrationCapabilityV2PlanInput());
  const f = fixture("prepare-provider-destination", plan);
  const readPrivateFiles = vi.fn(async () => f.files);
  const worker = createAppIntegrationCapabilitySandboxWorker({
    configuration: f.configuration,
    readPrivateFiles,
    run: f.run,
  });
  await expect(worker.execute(f.context)).rejects.toThrow("app_integration_worker_unavailable");
  expect(readPrivateFiles).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
