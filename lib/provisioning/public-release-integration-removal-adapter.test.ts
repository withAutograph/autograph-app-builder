/* oxlint-disable eslint/require-await -- Controlled native ports exercise authorization and durable readback without provider or database effects. */
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { createPublicReleaseIntegrationRemovalAdapter } from "./public-release-integration-removal-adapter";
import { integrationCapabilityPlan as initial } from "./app-integration-capability-test-fixture";
import { integrationTestCapability } from "./app-integration-release-test-fixture";
import { centralPrivateProfileFixture } from "./central-integration-private-profile-test-fixture";
import {
  centralIntegrationPrivateProfileSchema,
  centralIntegrationPrivateProfileDigest,
} from "./central-integration-private-profile";
import { activation } from "./central-integration-host-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  appIntegrationCapabilityOperationRef,
  appIntegrationCapabilityRecordSchema,
  preparedAppIntegrationCapabilitySchema,
} from "./app-integration-capability-contract";
import {
  appIntegrationReleaseAttachmentSchema,
  preparedIntegrationScopeDigest,
  appIntegrationRemovalSchema,
} from "./app-integration-release-contract";
import { plan as releaseFixture } from "./public-release-test-fixture";
import { retained } from "./public-release-integration-removal-test-fixture";
import { publicReleasePlanSchema, publicReleaseOperationRef } from "./public-release-contract";
import { centralHostCanonicalBytes } from "./central-integration-host-contract";
import { z } from "zod";
import type { CentralIntegrationHostReadyReceipt } from "./app-integration-central-authority";
import type { PublicReleaseIntegrationRemovalEffectContext } from "./public-release-integration-removal";
import type { runAppIntegrationFileSpool } from "./hosted-operator-sandbox-launcher";

const hash = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const fixture = () => {
  const source = appIntegrationCapabilityPlanSchema.parse({
    ...initial,
    control: {
      ...initial.control,
      activationKeyId: activation.keyId,
      activationPublicKeySha256: activation.publicKeySha256,
    },
  });
  const prepared = preparedAppIntegrationCapabilitySchema.parse({
    ...integrationTestCapability,
    control: {
      ...integrationTestCapability.control,
      activationKeyId: activation.keyId,
      activationPublicKeySha256: activation.publicKeySha256,
    },
  });
  const attachment = appIntegrationReleaseAttachmentSchema.parse({
    operationRef: appIntegrationCapabilityOperationRef(source),
    planDigest: appIntegrationCapabilityPlanDigest(source),
    capability: prepared,
    scopeSha256: preparedIntegrationScopeDigest(prepared),
    readinessPath: source.readinessPath,
  });
  const record = appIntegrationCapabilityRecordSchema.parse({
    kind: "app-integrations-capability-v1",
    plan: source,
    planDigest: attachment.planDigest,
    prepared,
    approvalReceipts: [
      { approvalId: "actual-native-consent-fixture", approvedByCallId: "original-call" },
    ],
    effects: {
      "prepare-control-database": {
        state: "applied",
        receipt: {
          effect: "prepare-control-database",
          resourceVersion: "one",
          resourceId: source.control.database.resourceId,
          database: source.control.database.database,
          runtimeRole: source.control.database.runtimeRole,
          migratorRole: source.control.database.migratorRole,
        },
      },
      "install-control-schema": {
        state: "applied",
        receipt: {
          effect: "install-control-schema",
          resourceVersion: "two",
          schemaSha256: source.control.schema.sha256,
        },
      },
      "bind-service-memberships": {
        state: "applied",
        receipt: {
          effect: "bind-service-memberships",
          resourceVersion: "three",
          memberships: prepared.serviceMemberships,
        },
      },
      "register-central-app": {
        state: "applied",
        receipt: {
          effect: "register-central-app",
          resourceVersion: "four",
          appId: source.selection.appId,
          resourceProfileId: source.control.resourceProfileId,
          registrationRef: prepared.privateConfiguration.reference,
          registrationDigest: prepared.privateConfiguration.sha256,
          principalGeneration: prepared.control.principalGeneration,
        },
      },
    },
  });
  const originalProfile = centralPrivateProfileFixture();
  const { runtimeRole: _runtimeRole, ...resource } = source.control.database;
  void _runtimeRole;
  const profile = centralIntegrationPrivateProfileSchema.parse({
    ...originalProfile,
    resourceProfileId: source.control.resourceProfileId,
    target: {
      ...originalProfile.target,
      projectId: source.control.centralHostSetup.projectId,
      teamId: source.project.teamId,
    },
    control: {
      resource,
      centralRuntimeRole: "central_runtime",
      neon: source.control.neon,
      schemaSha256: source.control.schema.sha256,
    },
    inspector: { ...originalProfile.inspector, ownerId: source.project.teamId },
  });
  const central: CentralIntegrationHostReadyReceipt = {
    version: 1,
    kind: "central-integration-host-ready-v1",
    authority: source.authority,
    setup: {
      operationRef: source.control.centralHostSetup.operationRef,
      planDigest: source.control.centralHostSetup.planDigest,
    },
    callerSetup: {
      operationRef: source.control.centralHostSetup.callerOperationRef,
      planDigest: source.control.centralHostSetup.callerPlanDigest,
    },
    profile: { id: profile.id, digest: centralIntegrationPrivateProfileDigest(profile) },
    resourceProfileId: source.control.resourceProfileId,
    control: profile.control,
    activation,
    provider: profile.provider,
    deployment: {
      projectId: profile.target.projectId,
      teamId: profile.target.teamId,
      installationId: profile.target.installationId,
      environment: "preview",
      serviceId: "integrations",
      providerDeploymentId: source.control.centralHostSetup.providerDeploymentId,
      immutableOrigin: source.control.origin,
      configurationRef: "central-config",
      configurationSha256: "a".repeat(64),
    },
    caller: {
      projectId: source.project.projectId,
      ownerId: source.project.teamId,
      environment: "production",
      trustedSourcesGrantSha256: source.control.centralHostSetup.trustedSourcesGrantSha256,
    },
  };
  const worker = {
    id: "app-integration-bootstrap-v1",
    sha256: "f".repeat(64),
    operationScope: "app-integration-bootstrap-v1" as const,
    executablePath: "/fixed/integration-worker",
    subcommand: "integration-control-schema" as const,
  };
  const removal = appIntegrationRemovalSchema.parse({
    kind: "disabled-app-integration-tombstone-v1",
    sourceCapability: { operationRef: attachment.operationRef, planDigest: attachment.planDigest },
    worker: { reference: worker.id, sha256: worker.sha256 },
    scopeSha256: attachment.scopeSha256,
    stoppedBindingsSha256: "d".repeat(64),
    bindingCount: 2,
    authority: {
      principalName: source.control.database.runtimeRole,
      active: true,
      principalGeneration: prepared.control.principalGeneration,
      expectedFencedGeneration: prepared.control.principalGeneration + 1,
      configurationRef: prepared.privateConfiguration.reference,
      configurationSha256: prepared.privateConfiguration.sha256,
    },
  });
  const plan = publicReleasePlanSchema.parse({
    ...releaseFixture,
    purpose: "application",
    integrationRemoval: removal,
    retainedOptionalBindings: retained,
    effects: ["fence-app-integration-authority", ...releaseFixture.effects],
  });
  const invocation = {
    authority: plan.authority,
    sessionId: plan.selection.sessionId,
    callId: "fresh-removal-consent-call",
    signal: new AbortController().signal,
  };
  let fenced = false;
  let held = false;
  let unknown = false;
  let drift = false;
  const fence = {
    operationRef: publicReleaseOperationRef(plan),
    active: false as const,
    principalGeneration: removal.authority.expectedFencedGeneration,
    priorGeneration: removal.authority.principalGeneration,
    stoppedBindingsSha256: removal.stoppedBindingsSha256,
  };
  const sha = hash(centralHostCanonicalBytes(z.json().parse(fence)));
  const read = vi.fn(async () => ({ operationRef: attachment.operationRef, revision: 8, record }));
  const fetcher = vi.fn<typeof fetch>(async (_url, options) => {
    if (held) {throw new Error("recursive_target_probe");}
    const body = z
      .looseObject({
        providerDeploymentId: z.string(),
        deployment: z.record(z.string(), z.unknown()),
      })
      .parse(JSON.parse(z.string().parse(options?.body)));
    expect(options?.headers).not.toHaveProperty("cookie");
    expect(new Headers(options?.headers).get("authorization")).toBe(
      "Bearer official-inspector-fixture",
    );
    expect(new Headers(options?.headers).get("x-vercel-trusted-oidc-idp-token")).toBe(
      "official-inspector-fixture",
    );
    const { inspection, ...manifest } = body;
    expect(inspection).toMatchObject({
      action: "inspect-app-removal",
      appId: source.selection.appId,
      scopeSha256: attachment.scopeSha256,
    });
    const request = z
      .object({
        expected: z
          .object({ operationRef: z.string(), removal: appIntegrationRemovalSchema })
          .optional(),
      })
      .parse(inspection);
    // The actual source observer treats expected as post-fence-only: it reads
    // the durable receipt and inactive principal, never the pre-fence app RPC.
    if (request.expected !== undefined) {
      if (!fenced) {
        return Response.json({ error: "removal_receipt_unavailable" }, { status: 503 });
      }
      expect(request.expected).toEqual({ operationRef: fence.operationRef, removal });
    } else if (fenced) {
      return Response.json({ error: "inactive_app_authority" }, { status: 503 });
    }
    const { providerDeploymentId, ...configuration } = manifest;
    return Response.json({
      version: 1,
      kind: "central-integrations-readiness-v1",
      ...configuration,
      deployment: {
        ...configuration.deployment,
        providerDeploymentId,
        immutableOrigin: central.deployment.immutableOrigin,
      },
      appRemoval: { ...removal, ...(drift ? { stoppedBindingsSha256: "e".repeat(64) } : {}) },
      ...(fenced ? { removalFence: fence } : {}),
    });
  });
  const run = vi.fn<typeof runAppIntegrationFileSpool>(async (_configuration, input) => {
    if (input.readOnly) {
      const envelope = {
        version: 1 as const,
        operation_id: input.context.operation.operation_id,
        context_digest: "b".repeat(64),
        fence_generation: input.context.operation.fence_generation,
      };
      if (unknown) {return { ...envelope, status: "unknown" as const };}
      if (fenced)
        {return { ...envelope, status: "applied" as const, receipt: fence, readback_sha256: sha };}
      return { ...envelope, status: "not-applied" as const };
    }
    await input.authorizeAppIntegrationRemoval?.();
    held = true;
    await input.assertCurrent();
    await input.assertCurrent();
    held = false;
    fenced = true;
    if (!input.recordCheckpoint) {throw new Error("missing_checkpoint");}
    await input.recordCheckpoint({
      operationId: publicReleaseOperationRef(plan),
      contextDigest: "b".repeat(64),
      resourceId: source.control.database.resourceId,
      fenceGeneration: removal.authority.expectedFencedGeneration,
      sequence: 1,
      effectId: "fence-app-integration-authority",
      tenantId: null,
      receipt: { state: "applied", readbackSha256: sha },
    });
    // Actual mutating SDK transport returns void after the durable checkpoint ACK.
    return null;
  });
  const assertCurrent = vi.fn(async () => {});
  const options = {
    capabilityStore: { read },
    configuration: {
      sandbox: {
        image: "qualified-source",
        projectId: "operator",
        teamId: "team",
        workers: {},
        integrationWorker: worker,
      },
    },
    environment: { HOSTED_CENTRAL_INTEGRATIONS_CONFIGURATION: JSON.stringify(profile) },
    readCentralReady: async () => central,
    readCentralPrivate: async () => ({
      controlMigratorUrl: `postgresql://${source.control.database.migratorRole}:private@${source.control.database.hostname}/${source.control.database.database}?sslmode=verify-full`,
      productionControlDatabaseIdentity: "ep-customer-production.neon.tech/customer",
      authorityKeyring: { activeKeyId: "key", keys: { key: "x" } },
    }),
    readInspectorToken: async () => "official-inspector-fixture",
    fetch: fetcher,
    run,
  };
  const adapter = createPublicReleaseIntegrationRemovalAdapter(options);
  const context: PublicReleaseIntegrationRemovalEffectContext = {
    invocation,
    plan,
    operationRef: publicReleaseOperationRef(plan),
    effect: "fence-app-integration-authority",
    priorPhase: "idle",
    bindings: {
      read: async () => ({}),
      claim: async () => ({ state: "idle" }),
      recordAccepted: async () => {},
      recordVerified: async () => {},
    },
    assertCurrent,
  };
  return {
    adapter,
    options,
    context,
    attachment,
    removal,
    read,
    record,
    fetcher,
    run,
    assertCurrent,
    setUnknown: () => (unknown = true),
    setDrift: () => (drift = true),
  };
};
it("observes actual stopped scope before dispatch and uses central inactive receipt after the fence", async () => {
  const f = fixture();
  await expect(
    f.adapter.readPreflight({
      invocation: f.context.invocation,
      sourceCapability: f.attachment,
      assertCurrent: f.assertCurrent,
    }),
  ).resolves.toEqual(f.removal);
  await expect(f.adapter.reconcile(f.context)).resolves.toBe("not-applied");
  await f.adapter.apply(f.context);
  await expect(f.adapter.reconcile(f.context)).resolves.toBe("applied");
  const execution = f.run.mock.calls.find(([, input]) => !input.readOnly)?.[1];
  expect(execution?.worker.subcommand).toBe("integration-fence-app-authority");
  expect(execution?.context.operation.approval_digest).toBe(execution?.context.release.sha256);
  expect(execution?.startupFiles).toHaveProperty("app-integration-removal-approved-plan.json");
  expect(execution?.startupFiles).toHaveProperty("app-integration-removal-source-plan.json");
});
it("does not dispatch another write when pending outcome is unknown", async () => {
  const f = fixture();
  f.context.priorPhase = "pending";
  f.setUnknown();
  await expect(f.adapter.apply(f.context)).rejects.toThrow();
  expect(f.run.mock.calls.every(([, input]) => input.readOnly)).toBe(true);
});
it("denies stop-snapshot drift before the exclusive fence", async () => {
  const f = fixture();
  f.setDrift();
  await expect(f.adapter.apply(f.context)).rejects.toThrow();
  expect(f.fetcher).toHaveBeenCalledTimes(1);
});
it("refuses foreign canonical capability authority before credentials or inspector access", async () => {
  const f = fixture();
  f.record.plan.authority = { ...f.record.plan.authority, ownerUserId: "foreign" };
  await expect(
    f.adapter.readPreflight({
      invocation: f.context.invocation,
      sourceCapability: f.attachment,
      assertCurrent: f.assertCurrent,
    }),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
  expect(f.run).not.toHaveBeenCalled();
});
it("fails closed when native central private custody is absent", async () => {
  const f = fixture();
  const adapter = createPublicReleaseIntegrationRemovalAdapter({
    ...f.options,
    readCentralPrivate: undefined,
  });
  await expect(
    adapter.readPreflight({
      invocation: f.context.invocation,
      sourceCapability: f.attachment,
      assertCurrent: f.assertCurrent,
    }),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
