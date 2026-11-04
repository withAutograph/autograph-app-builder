/* oxlint-disable eslint/require-await -- Synthetic worker ports exercise actual adapter framing without provider effects. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { plan } from "./central-integration-host-test-fixture";
import {
  centralHostPlanDigest,
  centralHostOperationRef,
  centralHostCanonicalBytes,
} from "./central-integration-host-contract";
import type { CentralHostEffectContext } from "./central-integration-host-service";
import type { CentralEffectReceipt } from "./central-integration-host-checkpoint";
import { createCentralIntegrationSandboxWorker } from "./central-integration-sandbox-worker";
import type {
  runCentralIntegrationFileSpool,
  runAppIntegrationFileSpool,
} from "./hosted-operator-sandbox-launcher";
const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const fixture = (
  effect: "prepare-central-resources" | "install-central-schema" = "install-central-schema",
) => {
  let accepted: CentralEffectReceipt | undefined;
  let afterAcknowledgement = false;
  let loseReply = false;
  let observedGeneration = 7;
  let badHash = false;
  const context: CentralHostEffectContext = {
    plan,
    operationRef: centralHostOperationRef(plan),
    planDigest: centralHostPlanDigest(plan),
    effect,
    priorPhase: "idle",
    fenceGeneration: 7,
    attemptGeneration: 7,
    invocation: {
      authority: plan.authority,
      sessionId: plan.selection.sessionId,
      callId: "genuine-current-call",
      signal: new AbortController().signal,
    },
    assertCurrent: vi.fn(async () => {}),
    checkpoint: {
      read: async () => ({
        attemptId: "11111111-1111-4111-a111-111111111111",
        attemptGeneration: 7,
        ...(accepted === undefined ? {} : { receipt: accepted }),
      }),
      recordGrantAttempt: async () => {},
      recordAccepted: vi.fn(async (receipt: CentralEffectReceipt) => {
        accepted = receipt;
      }),
    },
    bindings: {
      read: async () => ({}),
      claim: async () => {},
      recordAccepted: async () => {},
      recordVerified: async () => {},
    },
  };
  const credentials = { migratorPassword: "m".repeat(32), runtimePassword: "r".repeat(32) };
  const url = (role: string, password: string, database = plan.control.resource.database) =>
    `postgresql://${role}:${password}@${plan.control.resource.hostname}:5432/${database}?sslmode=verify-full`;
  const files = {
    connections: {
      migrator: url(plan.control.resource.migratorRole, credentials.migratorPassword),
      runtime: url(plan.control.centralRuntimeRole, credentials.runtimePassword),
    },
    resourceCredentials: credentials,
    bootstrap: {
      databaseUrl: url("bootstrap", "private", "postgres"),
      role: "bootstrap",
      maintenanceDatabase: "postgres",
    },
  };
  const configuration = {
    image: "fixed-worker-image",
    projectId: "operator-project",
    teamId: "operator-team",
    workers: {},
    resourcesWorker: {
      executablePath: "/workers/resources",
      operationScope: "neon-resource-bootstrap-v1" as const,
      id: "neon-resource-bootstrap-v1" as const,
      sha256: plan.source.workers.resources.sha256,
      subcommand: "neon-resource-bootstrap" as const,
    },
    centralIntegrationWorker: {
      executablePath: "/workers/central",
      operationScope: "central-integration-bootstrap-v1" as const,
      id: "central-integration-bootstrap-v1" as const,
      sha256: plan.source.workers.schema.sha256,
      subcommand: "central-integration-schema" as const,
    },
  };
  const receipt = () => ({
    centralPrincipalGeneration: observedGeneration,
    schemaSha256: plan.control.schemaSha256,
    resourceProfileId: plan.resourceProfileId,
    configurationSha256: plan.source.configurationSha256,
  });
  const run = vi.fn<typeof runCentralIntegrationFileSpool>(async (_config, input) => {
    expect(input.context.kind).toBe("central_integration_schema");
    expect(input.context.operation.fence_generation).toBe(7);
    expect(input.context.release).toEqual({
      id: plan.source.configurationRef,
      sha256: plan.source.configurationSha256,
    });
    expect(
      sha(input.startupFiles["central-integration-approved-plan.json"] ?? Buffer.alloc(0)),
    ).toBe(context.planDigest);
    expect(
      JSON.parse(input.startupFiles["central-integration-connections.json"]?.toString() ?? "null"),
    ).toEqual(files.connections);
    if (input.readOnly)
      return {
        version: 1 as const,
        operation_id: context.operationRef,
        context_digest: "a".repeat(64),
        fence_generation: 7,
        status: "applied" as const,
        readback_sha256: badHash ? "f".repeat(64) : sha(centralHostCanonicalBytes(receipt())),
        receipt: receipt(),
      };
    if (!input.recordCheckpoint) throw new Error("checkpoint port required");
    await input.recordCheckpoint({
      contextDigest: "a".repeat(64),
      effectId: "install-central-schema",
      fenceGeneration: 7,
      operationId: context.operationRef,
      resourceId: plan.control.resource.resourceId,
      sequence: 1,
      tenantId: null,
      receipt: { state: "applied", readbackSha256: sha(centralHostCanonicalBytes(receipt())) },
    });
    expect(accepted).toBeDefined();
    afterAcknowledgement = true;
    if (loseReply) throw new Error("lost SDK completion");
    return null;
  });
  const runResources = vi.fn<typeof runAppIntegrationFileSpool>(async (_config, input) => {
    expect(input.context.app_id).toBe("integrations");
    expect(input.context.operation.fence_generation).toBe(7);
    expect(input.directDatabaseUrl).toBe(files.bootstrap.databaseUrl);
    expect(input.resourceCredentialBytes?.toString()).toBe(JSON.stringify(credentials));
    if (!("scope" in input.context.resource)) throw new Error("resource scope required");
    expect(input.context.resource.scope).toBe("integration_control_database");
    if (input.readOnly)
      return {
        version: 1 as const,
        operation_id: context.operationRef,
        context_digest: "a".repeat(64),
        fence_generation: 7,
        status: "applied" as const,
        resource_id: plan.control.resource.resourceId,
        scope: "integration_control_database" as const,
        readback_sha256: "b".repeat(64),
      };
    if (!input.recordCheckpoint) throw new Error("checkpoint port required");
    await input.recordCheckpoint({
      contextDigest: "a".repeat(64),
      effectId: "resources:acl",
      fenceGeneration: 7,
      operationId: context.operationRef,
      resourceId: plan.control.resource.resourceId,
      sequence: 3,
      tenantId: null,
      receipt: { state: "applied", readbackSha256: "a".repeat(64) },
    });
    expect(accepted).toBeDefined();
    afterAcknowledgement = true;
    return null;
  });
  const readPrivateFiles = vi.fn(async () => files);
  const worker = createCentralIntegrationSandboxWorker({
    configuration,
    readPrivateFiles,
    run,
    runResources,
  });
  return {
    worker,
    context,
    files,
    configuration,
    run,
    runResources,
    readPrivateFiles,
    get accepted() {
      return accepted;
    },
    get acknowledged() {
      return afterAcknowledgement;
    },
    loseReply: () => {
      loseReply = true;
    },
    wrongGeneration: () => {
      observedGeneration = 9;
    },
    wrongHash: () => {
      badHash = true;
    },
  };
};
it("executes the pinned global schema with complete approved outer bytes and persists before acknowledgement", async () => {
  const f = fixture();
  const receipt = await f.worker.execute(f.context);
  expect(receipt).toEqual({
    effect: "install-central-schema",
    centralPrincipalGeneration: 7,
    schemaSha256: plan.control.schemaSha256,
    resourceProfileId: plan.resourceProfileId,
    configurationSha256: plan.source.configurationSha256,
  });
  expect(f.acknowledged).toBe(true);
  expect(f.context.checkpoint.recordAccepted).toHaveBeenCalledOnce();
  expect(f.run.mock.calls.map(([, input]) => input.readOnly)).toEqual([false, true]);
  expect(f.runResources).not.toHaveBeenCalled();
});
it("retains the accepted resource ACL digest while independently inspecting full resource state", async () => {
  const f = fixture("prepare-central-resources");
  const receipt = await f.worker.execute(f.context);
  expect(receipt).toMatchObject({
    effect: "prepare-central-resources",
    resourceId: plan.control.resource.resourceId,
    readbackSha256: "a".repeat(64),
  });
it("uses the exact frozen integration resource artifact while preserving the unrelated legacy worker", async () => {
  const f = fixture("prepare-central-resources");
  const legacy = { ...f.configuration.resourcesWorker, sha256: "b".repeat(64) };
  const integration = { ...f.configuration.resourcesWorker, executablePath: "/workers/integration-resources" };
  const configuration = { ...f.configuration, resourcesWorker: legacy, integrationResourcesWorker: integration };
  const worker = createCentralIntegrationSandboxWorker({ configuration, readPrivateFiles: f.readPrivateFiles, run: f.run, runResources: f.runResources });
  expect(await worker.execute(f.context)).toMatchObject({ effect: "prepare-central-resources" });
  expect(f.runResources).toHaveBeenCalled();
  expect(f.runResources.mock.calls.every(([, input]) => input.worker.executablePath === integration.executablePath)).toBe(true);
  expect(configuration.resourcesWorker).toEqual(legacy);
});
it("retains an old frozen resource artifact when an independently configured integration artifact differs", async () => {
  const f = fixture("prepare-central-resources");
  const configuration = { ...f.configuration, integrationResourcesWorker: { ...f.configuration.resourcesWorker, executablePath: "/workers/new-integration-resources", sha256: "b".repeat(64) } };
  const worker = createCentralIntegrationSandboxWorker({ configuration, readPrivateFiles: f.readPrivateFiles, run: f.run, runResources: f.runResources });
  expect(await worker.execute(f.context)).toMatchObject({ effect: "prepare-central-resources" });
  expect(f.runResources).toHaveBeenCalled();
  expect(f.runResources.mock.calls.every(([, input]) => input.worker.executablePath === f.configuration.resourcesWorker.executablePath)).toBe(true);
});
  expect(f.runResources.mock.calls.map(([, input]) => input.readOnly)).toEqual([false, true]);
  expect(f.run).not.toHaveBeenCalled();
});
it("reconciles an unknown schema completion under a new lease without another mutation or generation relabel", async () => {
  const f = fixture();
  f.loseReply();
  await expect(f.worker.execute(f.context)).rejects.toThrow("lost SDK completion");
  const result = await f.worker.reconcile({
    ...f.context,
    priorPhase: "pending",
    fenceGeneration: 9,
  });
  expect(result).toMatchObject({ status: "applied", receipt: { centralPrincipalGeneration: 7 } });
  expect(f.run.mock.calls.map(([, input]) => input.readOnly)).toEqual([false, true]);
  await expect(
    f.worker.execute({ ...f.context, priorPhase: "pending", fenceGeneration: 9 }),
  ).rejects.toThrow("worker_unavailable");
  expect(f.run).toHaveBeenCalledTimes(2);
});
it("does not acknowledge a checkpoint whose durable owner write fails", async () => {
  const f = fixture();
  f.context.checkpoint.recordAccepted = async () => {
    throw new Error("durable save failed");
  };
  await expect(f.worker.execute(f.context)).rejects.toThrow("durable save failed");
  expect(f.acknowledged).toBe(false);
  expect(f.run).toHaveBeenCalledOnce();
});
it("denies changed worker pins, scope, URL routing override and revoked authority before native dispatch", async () => {
  const f = fixture();
  const altered = createCentralIntegrationSandboxWorker({
    configuration: {
      ...f.configuration,
      centralIntegrationWorker: {
        ...f.configuration.centralIntegrationWorker,
        sha256: "0".repeat(64),
      },
    },
    readPrivateFiles: f.readPrivateFiles,
    run: f.run,
  });
  await expect(altered.execute(f.context)).rejects.toThrow("worker_unavailable");
  await expect(f.worker.execute({ ...f.context, planDigest: "0".repeat(64) })).rejects.toThrow(
    "worker_unavailable",
  );
  f.files.connections.runtime += "&host=foreign.neon.tech";
  await expect(f.worker.execute(f.context)).rejects.toThrow("worker_unavailable");
  await expect(
    f.worker.execute({
      ...f.context,
      assertCurrent: async () => {
        throw new Error("revoked");
      },
    }),
  ).rejects.toThrow("revoked");
  expect(f.run).not.toHaveBeenCalled();
  expect(f.runResources).not.toHaveBeenCalled();
});
it("keeps mismatched original principal generations and malformed receipt hashes unknown", async () => {
  const f = fixture();
  f.wrongGeneration();
  expect(
    await f.worker.reconcile({ ...f.context, priorPhase: "pending", fenceGeneration: 9 }),
  ).toEqual({ status: "unknown" });
  const other = fixture();
  other.wrongHash();
  expect(await other.worker.reconcile({ ...other.context, priorPhase: "pending" })).toEqual({
    status: "unknown",
  });
  expect(f.context.checkpoint.recordAccepted).not.toHaveBeenCalled();
  expect(other.context.checkpoint.recordAccepted).not.toHaveBeenCalled();
});
