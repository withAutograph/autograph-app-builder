import { integrationCapabilityPlan } from "./app-integration-capability-test-fixture";
import {
  appIntegrationCapabilityPlanSchema,
  appIntegrationCapabilityPlanDigest,
  appIntegrationCapabilityOperationRef,
} from "./app-integration-capability-contract";
import { appIntegrationCapabilityTransportRequestSchema } from "./app-integration-capability-transport";
/* oxlint-disable eslint/require-await, typescript/no-non-null-assertion -- These async port fixtures intentionally resolve synchronously; required fixture records are asserted in the tested producer. */
import { assembleStandardBuilderRuntimeConfiguration } from "./standard-builder-runtime-configuration";
import { standardDevelopmentRuntimePolicySchema } from "./hosted-operator-source-configuration-schema";
/* oxlint-disable unicorn/no-useless-undefined -- Explicit absent optional registry rows and void mocks match the read ports. */
import { describe, expect, it, vi } from "vitest";
import { capturedGenericWorkerFixture } from "./operator-worker-source-capture.test-fixture";
import { createNativeTargetConfigurationResolver } from "./native-target-configuration-resolver";
import type { NativeTargetConfigurationResources } from "./native-target-configuration-resolver";
import type { NativeTargetReadyRegistration } from "./native-target-onboarding-contract";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingRecordSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorContext } from "./hosted-operator-service";
import { HostedOperatorError } from "./hosted-operator-contract";
import type { OperatorOwnerContext, OperatorSelection } from "./hosted-operator-contract";

const worker = {
  executablePath: "/trusted/install",
  id: "trusted-installer",
  operationScope: "generated-app-release-install-v1" as const,
  sha256: "a".repeat(64),
  subcommand: "protected-generated-app-install" as const,
};
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const workload = {
  audience: "https://vercel.com/team",
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  subject: "builder-workload",
};
const configuration = (): HostedOperatorSourceConfiguration => ({
  applications: {
    sibling: {
      accessRoles: ["reviewer"],
      appDatabase: resource("sibling"),
      branch: "main",
      projectId: "sibling-project",
    },
  },
  authDatabase: resource("auth"),
  builderCallbackOrigin: "https://builder.example",
  catalogAppIds: ["sibling"],
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "main",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    gitSha: "b".repeat(40),
    projectId: "gateway",
    protectedApplicationIds: ["sibling"],
    publicOrigin: "https://apps.example",
    repoId: "gateway-repository",
    workload: { ...workload, projectId: "gateway" },
  },
  nativeNeon: {
    configuration: {
      connector: "approved-connector",
      nativeStore: {
        configurationId: "approved-store",
        resourceId: "store",
        sourceProjectId: "operator",
      },
      operator: { ...workload, projectId: "operator" },
    },
    scope: {
      branchId: "br-shared",
      endpointId: "ep-shared",
      hostname: "ep-shared.neon.tech",
      maintenanceDatabase: "neondb",
      maintenanceRole: "neondb_owner",
      projectId: "shared-neon",
    },
  },
  operator: {
    deploymentId: "operator-deployment",
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator",
  },
  sandbox: {
    accessWorker: worker,
    authProposal: { executablePath: "/trusted/propose", id: "proposal", sha256: "c".repeat(64) },
    authWorker: worker,
    image: "trusted-image",
    projectId: "operator",
    resourcesWorker: worker,
    teamId: "team",
    workers: { sibling: worker },
  },
  teamId: "team",
  workloadPolicy: workload,
});
const ready = (appId = "new-app"): NativeTargetReadyRegistration => {
  const time = "2026-10-21T15:00:00.000Z";
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const projectSettings = {
    buildCommand: "bun run build",
    framework: "nextjs" as const,
    rootDirectory: `apps/${appId}`,
    sourceFilesOutsideRootDirectory: true,
  };
  const result: NativeTargetReadyRegistration = {
    acceptedCreation: { acceptedAt: time, attemptId, projectId: `project-${appId}` },
    appId,
    approval: {
      callId: "call",
      observedAt: time,
      outcome: "approved",
      planDigest: "a".repeat(64),
      publicSessionId: "original-session",
      requestId: "request",
      responderPrincipalId: "owner",
    },
    attempt: {
      attemptId,
      candidateName: appId,
      leaseExpiresAt: time,
      leaseId: attemptId,
      startedAt: time,
    },
    dispatchAuthorizedAt: time,
    kind: "native-target-onboarding",
    plan: {
      appDatabase: resource(appId.replaceAll("-", "_")),
      appId,
      branch: "main",
      conflictPolicy: "stop-on-conflict",
      cost: { description: "Approved native target", ownership: "current-owner" },
      nativeNeon: {
        approvalReference: "original-approved-native-scope",
        nativeStore: configuration().nativeNeon.configuration.nativeStore,
        scope: configuration().nativeNeon.scope,
      },
      origin: {
        adapterGeneration: 1,
        adapterSessionId: "original-adapter",
        appSpecDigest: "b".repeat(64),
        publicSessionId: "original-session",
        release: {
          artifactRef: "private-artifact",
          id: "release-original",
          manifestSha256: "c".repeat(64),
          schemaSha256: "d".repeat(64),
        },
      },
      productRoles: [],
      project: {
        installationId: "installation",
        name: appId,
        projectSettings,
        protection: nativeTargetRequiredProjectProtection,
        teamId: "team",
      },
      retention: { policy: "retain" },
      version: 1,
      worker,
    },
    planDigest: "a".repeat(64),
    previousAttempts: [],
    registration: {
      attemptId,
      observed: {
        installationId: "installation",
        name: appId,
        projectId: `project-${appId}`,
        projectSettings,
        protection: nativeTargetRequiredProjectProtection,
        teamId: "team",
      },
      observedAt: time,
    },
    stage: "ready",
    version: 1,
  };
  result.planDigest = nativeTargetOnboardingPlanDigest(result.plan);
  result.approval.planDigest = result.planDigest;
  const parsed = nativeTargetOnboardingRecordSchema.parse(result);
  if (parsed.stage !== "ready") {
    throw new Error("Expected ready fixture");
  }
  return parsed;
};
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const ownerContext = {
  adapterGeneration: 2,
  adapterSessionId: "current-adapter",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:get"] },
  sessionId: "current-session",
};
const context = (appId = "new-app"): HostedOperatorContext => ({
  authority,
  ownerContext,
  target: {
    appId,
    branch: "main",
    environment: "preview",
    installationId: "installation",
    projectId: `project-${appId}`,
    scopeId: "team",
    scopeType: "team",
    sessionId: ownerContext.sessionId,
  },
});

interface ConfigurationFixtureBody {
  adapterSessionId?: string;
  execution?: { logicalSessionId: string };

  action: string;
  ownerContext?: OperatorOwnerContext;
  selection?: OperatorSelection;
  appId?: string;
  sessionId?: string;
  operation?: string;
  phase?: string;
  intentId?: string;
  exportId?: string;
  planRef?: string;
  planDigest?: string;
  idempotencyKey?: string;
  callId?: string;
}
const request = (body: ConfigurationFixtureBody) =>
  new Request("https://operator.example/v1/runtime", {
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
    method: "POST",
  });
const setup = () => {
  const order: string[] = [];
  const record = ready();
  const registry = {
    read: vi.fn(async () => {
      order.push("registry");
      return await Promise.resolve({
        appId: record.appId,
        authority,
        createdAt: new Date(),
        record,
        requestId: "registry",
        revision: 1,
        updatedAt: new Date(),
      });
    }),
  };
  const resources = {
    close: vi.fn(async () => {
      order.push("close");
      await Promise.resolve();
    }),
    continuity: { read: vi.fn().mockResolvedValue({ plan: { target: context().target } }) },
    exports: { read: vi.fn().mockResolvedValue({ originalTarget: context().target }) },
    owner: {
      assertCanonicalAppOwner: vi.fn(async () => {
        order.push("owner");
        await Promise.resolve();
      }),
      assertNoStandardBuilderDestination: vi.fn(async () => {}),
      verifyWorkload: vi.fn(async () => {
        order.push("workload");
        await Promise.resolve();
      }),
    },
    registry,
  } satisfies NativeTargetConfigurationResources;
  const openResources = vi.fn(async () => await Promise.resolve(resources));
  return {
    openResources,
    order,
    resolve: createNativeTargetConfigurationResolver({
      configuration: configuration(),
      openResources,
    }),
    resources,
  };
};

describe("production native target configuration resolver", () => {
  it("verifies current app ownership before the actual registry reader and projects ready metadata", async () => {
    const fixture = setup();
    const effective = await fixture.resolve(
      request({
        action: "resolve-preview-target",
        appId: "new-app",
        ownerContext,
        sessionId: ownerContext.sessionId,
      }),
    );
    expect(fixture.order).toEqual(["workload", "owner", "registry", "close"]);
    expect(fixture.resources.owner.assertCanonicalAppOwner).toHaveBeenCalledExactlyOnceWith({
      authority,
      ownerContext,
      target: { appId: "new-app", sessionId: ownerContext.sessionId },
    });
    expect(fixture.resources.registry.read).toHaveBeenCalledExactlyOnceWith({
      appId: "new-app",
      authority,
    });
    expect(effective.applications["new-app"].projectId).toBe("project-new-app");
  });
  it("resolves an ordinary selected app operation through fresh registry authorization", async () => {
    const fixture = setup();
    const { target } = context();
    const effective = await fixture.resolve(
      request({
        action: "plan",
        operation: "prepare",
        ownerContext,
        selection: {
          appId: target.appId,
          branch: target.branch,
          environment: target.environment,
          projectId: target.projectId,
          sessionId: target.sessionId,
        },
      }),
    );
    expect(fixture.order).toEqual(["workload", "owner", "registry", "close"]);
    expect(effective.applications[target.appId].projectId).toBe(target.projectId);
  });
  it.each(["workload", "owner"] as const)(
    "rejects %s denial before private registration read",
    async (boundary) => {
      const fixture = setup();
      const port =
        boundary === "workload"
          ? fixture.resources.owner.verifyWorkload
          : fixture.resources.owner.assertCanonicalAppOwner;
      port.mockRejectedValue(new HostedOperatorError("authorization_required"));
      await expect(
        fixture.resolve(
          request({
            action: "resolve-preview-target",
            appId: "new-app",
            ownerContext,
            sessionId: ownerContext.sessionId,
          }),
        ),
      ).rejects.toMatchObject({ code: "authorization_required" });
      expect(fixture.resources.registry.read).not.toHaveBeenCalled();
      expect(fixture.resources.close).toHaveBeenCalledOnce();
    },
  );
  it.each([
    "continuity-read",
    "continuity-status",
    "continuity-approval",
    "continuity",
    "export-read",
    "export-status",
    "export-approval",
    "export",
  ])("resolves %s from its retained operation, without a body appId", async (action) => {
    const fixture = setup();
    const id = "11111111-1111-4111-8111-111111111111";
    const isRead = action.endsWith("read") || action.endsWith("status");
    const body = {
      action,
      ownerContext,
      ...(isRead
        ? { [action.startsWith("continuity") ? "intentId" : "exportId"]: id }
        : {
            idempotencyKey: "same-operation",
            planDigest: "a".repeat(64),
            planRef: action.startsWith("export")
              ? `_protected-operator/export-plans/${id}`
              : `private-plan/${id}`,
            ...(action.endsWith("approval") ? {} : { callId: "approved-call" }),
          }),
    };
    const effective = await fixture.resolve(request(body));
    const reader = action.startsWith("continuity")
      ? fixture.resources.continuity.read
      : fixture.resources.exports.read;
    expect(reader).toHaveBeenCalledOnce();
    expect(fixture.order).toEqual(["workload", "workload", "owner", "registry", "close"]);
    expect(fixture.resources.registry.read).toHaveBeenCalledExactlyOnceWith({
      appId: "new-app",
      authority,
    });
    expect(effective.applications["new-app"].projectId).toBe("project-new-app");
  });
  it("rejects a retained operation from another owner session before registration read", async () => {
    const fixture = setup();
    fixture.resources.continuity.read.mockResolvedValue({
      plan: { target: { ...context().target, sessionId: "foreign-session" } },
    });
    await expect(
      fixture.resolve(
        request({
          action: "continuity-status",
          intentId: "11111111-1111-4111-8111-111111111111",
          ownerContext,
        }),
      ),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(fixture.resources.registry.read).not.toHaveBeenCalled();
    expect(fixture.resources.close).toHaveBeenCalledOnce();
  });
  it("does not read retained operations after invalid workload and does not borrow body app hints", async () => {
    const fixture = setup();
    fixture.resources.owner.verifyWorkload.mockRejectedValue(
      new HostedOperatorError("authorization_required"),
    );
    await expect(
      fixture.resolve(
        request({
          action: "export-status",
          exportId: "11111111-1111-4111-8111-111111111111",
          ownerContext,
        }),
      ),
    ).rejects.toThrow();
    expect(fixture.resources.exports.read).not.toHaveBeenCalled();
    expect(fixture.resources.registry.read).not.toHaveBeenCalled();
  });
  it.each([
    {
      action: "neon-authorization",
      ownerContext,
      phase: "check",
      sessionId: ownerContext.sessionId,
    },
    { action: "separate-onboarding-dispatch", appId: "new-app" },
  ])(
    "leaves independent handler authority intact without opening registration stores",
    async (body) => {
      const fixture = setup();
      expect(await fixture.resolve(request(body))).toEqual(configuration());
      expect(fixture.openResources).not.toHaveBeenCalled();
    },
  );
});

describe("normal single-project destination resolution", () => {
  const standard = () => {
    const config = configuration();
    config.composition = "single-project-services";
    config.gateway.gatewayOrigin = config.gateway.publicOrigin;
    config.gateway.authBrowserOrigin = config.gateway.publicOrigin;
    config.applications.sibling = {
      ...config.applications.sibling,
      projectId: config.gateway.projectId,
      projectSettings: { framework: "services", rootDirectory: "." },
    };
    return config;
  };
  const body = {
    action: "resolve-preview-target",
    appId: "sibling",
    ownerContext,
    sessionId: ownerContext.sessionId,
  };

  it("requires normal destination selection without looking up a dedicated target", async () => {
    const f = setup();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: standard(),
      openResources: f.openResources,
    });
    await expect(resolve(request(body))).rejects.toMatchObject({
      code: "builder_destination_required",
    });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });

  it("uses the trusted normal receipt for the configured single-project destination", async () => {
    const f = setup();
    const config = standard();
    const readStandardDestination = vi.fn().mockResolvedValue({
      installationId: "installation",
      name: "apps-sibling",
      projectId: config.gateway.projectId,
      teamId: config.teamId,
    });
    const resolve = createNativeTargetConfigurationResolver({
      configuration: config,
      openResources: async () => await Promise.resolve({ ...f.resources, readStandardDestination }),
    });
    const result = await resolve(request(body));
    expect(result.applications.sibling.projectId).toBe(result.gateway.projectId);
    expect(readStandardDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { appId: "sibling", sessionId: ownerContext.sessionId },
      }),
    );
  });

  it("reports missing coherent setup instead of mixing an old Gateway into a new receipt", async () => {
    const f = setup();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: standard(),
      openResources: async () =>
        await Promise.resolve({
          ...f.resources,
          readStandardDestination: vi.fn().mockResolvedValue({
            installationId: "installation",
            name: "apps-sibling",
            projectId: "new-standard-project",
            teamId: "team",
          }),
        }),
    });
    await expect(resolve(request(body))).rejects.toMatchObject({
      code: "builder_destination_configuration_required",
    });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
});

describe("fresh normal same-project runtime assembly", () => {
  const fixture = () => {
    const f = setup();
    const base = configuration();
    base.sandbox.genericInstallerWorker = capturedGenericWorkerFixture;
    const { audience, issuer, environment: operatorEnvironment, ownerId } = workload;
    base.nativeNeon.configuration.operator = {
      audience,
      environment: operatorEnvironment,
      issuer,
      ownerId,
      projectId: base.operator.projectId,
    };
    const selected = {
      appId: "new-app",
      appSpecDigest: "a".repeat(64),
      artifactRef: "generated-release:fixture",
      manifestSha256: "b".repeat(64),
      publishedSource: {
        branch: "builder/current-app",
        changeSetDigest: "1".repeat(64),
        gitSha: "d".repeat(40),
        gitTree: "e".repeat(40),
        repositoryId: "123",
        reviewDigest: "f".repeat(64),
      },
      releaseId: "release-current",
      schemaSha256: "c".repeat(64),
      version: 1 as const,
    };
    const description = {
      app: { id: "new-app", routes: ["/"], workspacePath: "apps/new-app" },
      backend: {
        authorization: "app-owned" as const,
        kind: "generated-postgres" as const,
        release: { artifactHash: "c".repeat(64), directory: "release", id: "release-current" },
        roles: ["member"],
        runtime: { databaseEnvironment: "APP_DATABASE_URL" },
        schemaReceipt: null,
      },
      validation: { browser: null, check: { task: "check" }, test: null },
      version: 1 as const,
    };
    const destination = {
      deploymentAccess: "public-app" as const,
      installationId: "installation",
      name: "apps-new-app",
      projectId: "standard-project",
      provisioningDigest: "2".repeat(64),
      provisioningRequestId: "bb863e20-5238-4e28-b156-31b9ca26d304",
      repository: "owner/apps-new-app",
      repositoryId: "123",
      teamId: "team",
      teamSlug: "team",
    };
    const environment = {
      PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: JSON.stringify([
        { appId: "new-app", authority, configuration: base, id: "isolated" },
      ]),
      PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES: JSON.stringify([
        {
          appId: "new-app",
          authOwnership: { kind: "dedicated-app-development", resource: base.authDatabase },
          authority,
          gatewayProductionWorkload: {
            audience: workload.audience,
            issuer: workload.issuer,
            subject: "explicitly-reviewed-production-gateway",
          },
          gatewayWorkload: {
            audience: workload.audience,
            issuer: workload.issuer,
            subject: "same-project-gateway",
          },
          productionDatabaseIdentity: "ep-production.neon.tech/auth",
          publicOrigin: "https://apps-new-app.vercel.app",
          resourceProfileId: "isolated",
        },
      ]),
    };
    const readStandardDestination = vi.fn().mockResolvedValue(destination);
    const readStandardCapture = vi.fn().mockResolvedValue({ description, selection: selected });
    const resolve = createNativeTargetConfigurationResolver({
      configuration: base,
      environment,
      openResources: async () => ({ ...f.resources, readStandardCapture, readStandardDestination }),
    });
    const body = {
      action: "resolve-preview-target",
      appId: "new-app",
      ownerContext,
      sessionId: ownerContext.sessionId,
    };
    return {
      ...f,
      base,
      body,
      description,
      destination,
      environment,
      readStandardCapture,
      readStandardDestination,
      resolve,
      selected,
    };
  };
  const generic = () => {
    const f = fixture();
    const nativeNeon = structuredClone(f.base.nativeNeon);
    nativeNeon.configuration.syntheticEnrollment = {
      authority: "synthetic-only",
      branches: [
        {
          branchId: nativeNeon.scope.branchId,
          createdAt: "2026-10-01T01:00:00Z",
          initSource: "parent-schema",
          parentId: "development-root",
          parentLsn: "0/1",
        },
      ],
      creationApprovalReference: "existing-reviewed-development-project",
      project: {
        createdAt: "2026-10-01T00:00:00Z",
        id: nativeNeon.scope.projectId,
        ownerId: "development-owner",
      },
      root: {
        branchId: "development-root",
        createdAt: "2026-10-01T00:00:00Z",
        initSource: "schema-only",
      },
      sourceBaselineReference: "reviewed-empty-development-baseline",
    };
    f.base.standardDevelopmentRuntime = {
      kind: "standard-development-runtime-policy-v1",
      nativeNeon,
      policyId: "normal-development",
      productionDatabaseIdentity: "ep-production.neon.tech/auth",
      version: 1,
      workloadIdentity: "vercel-team-oidc-v1",
    };
    const readStandardPublicOrigin = vi.fn().mockResolvedValue("https://actual-public.example");
    const resolve = createNativeTargetConfigurationResolver({
      configuration: f.base,
      openResources: async () => ({
        ...f.resources,
        readStandardCapture: f.readStandardCapture,
        readStandardDestination: f.readStandardDestination,
        readStandardPublicOrigin,
      }),
    });
    return { ...f, readStandardPublicOrigin, resolve };
  };
  it("derives a new normal app runtime through the generic policy without a per-app profile or old registration", async () => {
    const f = generic();
    const before = structuredClone(f.base);
    const result = await f.resolve(request(f.body));
    expect(result.gateway.publicOrigin).toBe("https://actual-public.example");
    expect(result.standardRuntime?.profileId).toMatch(/^normal-development:[a-f0-9]{64}$/u);
    expect(result.authDatabase).not.toEqual(f.base.authDatabase);
    const app = result.applications["new-app"];
    expect(new Set([app.appDatabase.database, result.authDatabase.database]).size).toBe(2);
    expect(
      new Set([
        app.appDatabase.runtimeRole,
        app.appDatabase.migratorRole,
        result.authDatabase.runtimeRole,
        result.authDatabase.migratorRole,
      ]).size,
    ).toBe(4);
    expect(f.base).toEqual(before);
    expect(f.resources.registry.read).not.toHaveBeenCalled();
    expect(f.readStandardPublicOrigin).toHaveBeenCalledWith(
      expect.objectContaining({ authority }),
      f.destination,
    );
  });
  it("preserves existing explicit per-app profiles before the generic policy without domain re-selection", async () => {
    const f = generic();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: f.base,
      environment: f.environment,
      openResources: async () => ({
        ...f.resources,
        readStandardCapture: f.readStandardCapture,
        readStandardDestination: f.readStandardDestination,
        readStandardPublicOrigin: f.readStandardPublicOrigin,
      }),
    });
    const result = await resolve(request(f.body));
    expect(result.authDatabase).toEqual(f.base.authDatabase);
    expect(result.gateway.publicOrigin).toBe("https://apps-new-app.vercel.app");
    expect(f.readStandardPublicOrigin).not.toHaveBeenCalled();
  });
  it("does not silently rebind an explicit frozen profile to a new public-origin choice", async () => {
    const f = generic();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: f.base,
      environment: f.environment,
      openResources: async () => ({
        ...f.resources,
        readStandardCapture: f.readStandardCapture,
        readStandardDestination: f.readStandardDestination,
        readStandardOriginSelection: async () =>
          await Promise.resolve("https://different-chosen.example"),
        readStandardPublicOrigin: f.readStandardPublicOrigin,
      }),
    });
    await expect(resolve(request(f.body))).rejects.toMatchObject({
      code: "builder_destination_configuration_required",
    });
    expect(f.readStandardPublicOrigin).not.toHaveBeenCalled();
  });
  it("rejects a choice changed during the final owner read without rewriting a frozen profile", async () => {
    const f = generic();
    const readStandardOriginSelection = vi
      .fn()
      .mockResolvedValueOnce("https://apps-new-app.vercel.app")
      .mockResolvedValueOnce("https://new-choice.example");
    const before = structuredClone(f.base);
    const resolve = createNativeTargetConfigurationResolver({
      configuration: f.base,
      environment: f.environment,
      openResources: async () => ({
        ...f.resources,
        readStandardCapture: f.readStandardCapture,
        readStandardDestination: f.readStandardDestination,
        readStandardOriginSelection,
        readStandardPublicOrigin: f.readStandardPublicOrigin,
      }),
    });
    await expect(resolve(request(f.body))).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.base).toEqual(before);
    expect(f.readStandardPublicOrigin).not.toHaveBeenCalled();
    expect(readStandardOriginSelection).toHaveBeenCalledTimes(2);
  });
  it("rejects A/B/A selection coherence drift rather than returning a verified different origin", async () => {
    const f = generic();
    const readStandardOriginSelection = vi.fn().mockResolvedValue("https://choice-a.example");
    f.readStandardPublicOrigin.mockResolvedValue("https://choice-b.example");
    const resolve = createNativeTargetConfigurationResolver({
      configuration: f.base,
      openResources: async () => ({
        ...f.resources,
        readStandardCapture: f.readStandardCapture,
        readStandardDestination: f.readStandardDestination,
        readStandardOriginSelection,
        readStandardPublicOrigin: f.readStandardPublicOrigin,
      }),
    });
    await expect(resolve(request(f.body))).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(readStandardOriginSelection).toHaveBeenCalledOnce();
    expect(f.readStandardPublicOrigin).toHaveBeenCalledOnce();
  });
  it.each(["app-integration-capability-plan", "app-integration-capability-prepare"] as const)(
    "derives the canonical normal app runtime for actual capability ingress %s",
    async (action) => {
      const f = generic();
      f.selected.appId = integrationCapabilityPlan.selection.appId;
      f.description.app.id = integrationCapabilityPlan.selection.appId;
      const plan = appIntegrationCapabilityPlanSchema.parse({
        ...integrationCapabilityPlan,
        selection: { ...integrationCapabilityPlan.selection, sessionId: ownerContext.sessionId },
      });
      const common = {
        action,
        adapterSessionId: ownerContext.adapterSessionId,
        callId: "current-capability-call",
        execution: { logicalSessionId: ownerContext.adapterSessionId },
        ownerContext,
      };
      const incoming = appIntegrationCapabilityTransportRequestSchema.parse(
        action === "app-integration-capability-plan"
          ? { ...common, appId: plan.selection.appId }
          : {
              ...common,
              input: {
                operationRef: appIntegrationCapabilityOperationRef(plan),
                plan,
                planDigest: appIntegrationCapabilityPlanDigest(plan),
              },
            },
      );
      const result = await f.resolve(
        new Request("https://operator.example/v1/app-integrations", {
          body: JSON.stringify(incoming),
          method: "POST",
        }),
      );
      expect(result.applications[plan.selection.appId]?.projectId).toBe(f.destination.projectId);
      expect(result.standardRuntime?.profileId).toMatch(/^normal-development:/u);
      expect(f.resources.registry.read).not.toHaveBeenCalled();
    },
  );
  it("rejects foreign capability ownership before deriving resource configuration", async () => {
    const f = generic();
    f.resources.owner.assertCanonicalAppOwner.mockRejectedValueOnce(new Error("foreign app owner"));
    const incoming = {
      action: "app-integration-capability-plan",
      adapterSessionId: ownerContext.adapterSessionId,
      appId: "new-app",
      callId: "capability",
      execution: { logicalSessionId: ownerContext.adapterSessionId },
      ownerContext,
    };
    await expect(
      f.resolve(
        new Request("https://operator.example/v1/app-integrations", {
          body: JSON.stringify(incoming),
          method: "POST",
        }),
      ),
    ).rejects.toThrow("foreign app owner");
    expect(f.readStandardDestination).not.toHaveBeenCalled();
    expect(f.readStandardPublicOrigin).not.toHaveBeenCalled();
  });
  it("keeps derived resource identities stable across revisions and distinct across canonical owners", async () => {
    const f = generic();
    const assemble = (owner = authority, release = f.selected) =>
      assembleStandardBuilderRuntimeConfiguration({
        appId: "new-app",
        authority: owner,
        base: f.base,
        captured: { description: f.description, selection: release },
        destination: {
          ...f.destination,
          githubInstallationId: undefined,
          productionBranch: undefined,
        },
        environment: {},
        verifiedPublicOrigin: "https://actual-public.example",
      });
    const first = assemble();
    expect(assemble(authority, { ...f.selected, releaseId: "next-release" }).authDatabase).toEqual(
      first.authDatabase,
    );
    expect(assemble({ ...authority, ownerUserId: "other-owner" }).authDatabase).not.toEqual(
      first.authDatabase,
    );
  });
  it("fails closed on missing origin proof, default branch, Production endpoint or incompatible operator custody", async () => {
    const f = generic();
    f.readStandardPublicOrigin.mockResolvedValue(undefined);
    await expect(f.resolve(request(f.body))).rejects.toMatchObject({
      code: "builder_destination_configuration_required",
    });
    const policy = f.base.standardDevelopmentRuntime!;
    expect(
      standardDevelopmentRuntimePolicySchema.safeParse({
        ...policy,
        nativeNeon: {
          ...policy.nativeNeon,
          scope: { ...policy.nativeNeon.scope, branchId: "development-root" },
        },
      }).success,
    ).toBe(false);
    expect(
      standardDevelopmentRuntimePolicySchema.safeParse({
        ...policy,
        productionDatabaseIdentity: `${policy.nativeNeon.scope.hostname}/production`,
      }).success,
    ).toBe(false);
    policy.nativeNeon.configuration.operator.audience = "https://foreign.example";
    expect(() =>
      assembleStandardBuilderRuntimeConfiguration({
        appId: "new-app",
        authority,
        base: f.base,
        captured: { description: f.description, selection: f.selected },
        destination: {
          ...f.destination,
          githubInstallationId: undefined,
          productionBranch: undefined,
        },
        environment: {},
        verifiedPublicOrigin: "https://actual-public.example",
      }),
    ).toThrow();
  });
  it("uses the real normal receipt and captured source without reading legacy native registration", async () => {
    const f = fixture();
    const result = await f.resolve(request(f.body));
    expect(result.gateway).toMatchObject({
      branch: f.selected.publishedSource.branch,
      environment: "preview",
      gitSha: f.selected.publishedSource.gitSha,
      projectId: f.destination.projectId,
      publicOrigin: "https://apps-new-app.vercel.app",
      repoId: "123",
    });
    expect(result.gateway.deploymentId).toBeUndefined();
    expect(result.sandbox.workers["new-app"]).toEqual(capturedGenericWorkerFixture);
    expect(result.standardRuntime?.publicRealmWorkload).toMatchObject({
      environment: "production",
      ownerId: f.destination.teamId,
      projectId: f.destination.projectId,
      subject: "explicitly-reviewed-production-gateway",
    });
    expect(result.standardRuntime?.publicRealmWorkload).toMatchObject({
      environment: "production",
      ownerId: f.destination.teamId,
      projectId: f.destination.projectId,
      subject: "explicitly-reviewed-production-gateway",
    });
    expect(result.applications["new-app"]).toMatchObject({
      accessRoles: ["member"],
      projectId: result.gateway.projectId,
      projectSettings: { framework: "services", rootDirectory: "." },
    });
    expect(result.applications.sibling).toBeUndefined();
    expect(result.gateway.projectId).not.toBe(f.base.gateway.projectId);
    expect(result.nativeNeon).toEqual(f.base.nativeNeon);
    expect(f.resources.registry.read).not.toHaveBeenCalled();
    expect(f.base.gateway.projectId).toBe("gateway");
  });
  it.each(["missing-destination", "foreign-source", "foreign-profile", "private-delivery"])(
    "refuses %s without falling back to a legacy target",
    async (failure) => {
      const f = fixture();
      if (failure === "missing-destination") {
        f.readStandardDestination.mockResolvedValue(undefined);
      }
      if (failure === "foreign-source") {
        f.selected.publishedSource.repositoryId = "foreign-repository";
      }
      if (failure === "foreign-profile") {
        f.environment.PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES = JSON.stringify([
          {
            appId: "new-app",
            authority: { ...authority, ownerUserId: "other" },
            configuration: f.base,
            id: "isolated",
          },
        ]);
      }
      if (failure === "private-delivery") {
        f.readStandardDestination.mockResolvedValue({
          ...f.destination,
          deploymentAccess: undefined,
        });
      }
      await expect(f.resolve(request(f.body))).rejects.toThrow();
      expect(f.resources.registry.read).not.toHaveBeenCalled();
    },
  );
  it("routes public release through the same normal destination and never reads the obsolete registry", async () => {
    const f = fixture();
    const result = await f.resolve(
      request({
        action: "public-release-plan",
        adapterSessionId: ownerContext.adapterSessionId,
        appId: "new-app",
        callId: "release-call",
        execution: { logicalSessionId: ownerContext.adapterSessionId },
        ownerContext,
      }),
    );
    expect(result.gateway.projectId).toBe(f.destination.projectId);
    expect(result.standardRuntime?.productionDatabaseIdentity).toBe("ep-production.neon.tech/auth");
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
  it("does not borrow a legacy native target for an unconfigured public release", async () => {
    const f = setup();
    await expect(
      f.resolve(
        request({
          action: "public-release-plan",
          adapterSessionId: ownerContext.adapterSessionId,
          appId: "new-app",
          callId: "release-call",
          execution: { logicalSessionId: ownerContext.adapterSessionId },
          ownerContext,
        }),
      ),
    ).rejects.toMatchObject({ code: "builder_destination_configuration_required" });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
});

describe("normal single-project destination resolution", () => {
  // oxlint-disable-next-line sonarjs/no-identical-functions -- Retain the existing separately named normal-destination regression scenarios.
  const standard = () => {
    const config = configuration();
    config.composition = "single-project-services";
    config.gateway.gatewayOrigin = config.gateway.publicOrigin;
    config.gateway.authBrowserOrigin = config.gateway.publicOrigin;
    config.applications.sibling = {
      ...config.applications.sibling,
      projectId: config.gateway.projectId,
      projectSettings: { framework: "services", rootDirectory: "." },
    };
    return config;
  };
  const body = {
    action: "resolve-preview-target",
    appId: "sibling",
    ownerContext,
    sessionId: ownerContext.sessionId,
  };

  it("requires normal destination selection without looking up a dedicated target", async () => {
    const f = setup();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: standard(),
      openResources: f.openResources,
    });
    await expect(resolve(request(body))).rejects.toMatchObject({
      code: "builder_destination_required",
    });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });

  it("uses the trusted normal receipt for the configured single-project destination", async () => {
    const f = setup();
    const config = standard();
    const readStandardDestination = vi.fn().mockResolvedValue({
      installationId: "installation",
      name: "apps-sibling",
      projectId: config.gateway.projectId,
      teamId: config.teamId,
    });
    const resolve = createNativeTargetConfigurationResolver({
      configuration: config,
      openResources: async () => await Promise.resolve({ ...f.resources, readStandardDestination }),
    });
    const result = await resolve(request(body));
    expect(result.applications.sibling.projectId).toBe(result.gateway.projectId);
    expect(readStandardDestination).toHaveBeenCalledWith(
      expect.objectContaining({
        target: { appId: "sibling", sessionId: ownerContext.sessionId },
      }),
    );
  });

  it("reports missing coherent setup instead of mixing an old Gateway into a new receipt", async () => {
    const f = setup();
    const resolve = createNativeTargetConfigurationResolver({
      configuration: standard(),
      openResources: async () =>
        await Promise.resolve({
          ...f.resources,
          readStandardDestination: vi.fn().mockResolvedValue({
            installationId: "installation",
            name: "apps-sibling",
            projectId: "new-standard-project",
            teamId: "team",
          }),
        }),
    });
    await expect(resolve(request(body))).rejects.toMatchObject({
      code: "builder_destination_configuration_required",
    });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
});
describe("fresh normal same-project runtime assembly", () => {
  // oxlint-disable-next-line sonarjs/no-identical-functions -- Retain the existing separately named fresh-destination regression scenarios.
  const fixture = () => {
    const f = setup();
    const base = configuration();
    base.sandbox.genericInstallerWorker = capturedGenericWorkerFixture;
    const { audience, issuer, environment: operatorEnvironment, ownerId } = workload;
    base.nativeNeon.configuration.operator = {
      audience,
      environment: operatorEnvironment,
      issuer,
      ownerId,
      projectId: base.operator.projectId,
    };
    const selected = {
      appId: "new-app",
      appSpecDigest: "a".repeat(64),
      artifactRef: "generated-release:fixture",
      manifestSha256: "b".repeat(64),
      publishedSource: {
        branch: "builder/current-app",
        changeSetDigest: "1".repeat(64),
        gitSha: "d".repeat(40),
        gitTree: "e".repeat(40),
        repositoryId: "123",
        reviewDigest: "f".repeat(64),
      },
      releaseId: "release-current",
      schemaSha256: "c".repeat(64),
      version: 1 as const,
    };
    const description = {
      app: { id: "new-app", routes: ["/"], workspacePath: "apps/new-app" },
      backend: {
        authorization: "app-owned" as const,
        kind: "generated-postgres" as const,
        release: { artifactHash: "c".repeat(64), directory: "release", id: "release-current" },
        roles: ["member"],
        runtime: { databaseEnvironment: "APP_DATABASE_URL" },
        schemaReceipt: null,
      },
      validation: { browser: null, check: { task: "check" }, test: null },
      version: 1 as const,
    };
    const destination = {
      deploymentAccess: "public-app" as const,
      installationId: "installation",
      name: "apps-new-app",
      projectId: "standard-project",
      provisioningDigest: "2".repeat(64),
      provisioningRequestId: "bb863e20-5238-4e28-b156-31b9ca26d304",
      repository: "owner/apps-new-app",
      repositoryId: "123",
      teamId: "team",
      teamSlug: "team",
    };
    const environment = {
      PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES: JSON.stringify([
        { appId: "new-app", authority, configuration: base, id: "isolated" },
      ]),
      PROTECTED_HOSTED_OPERATOR_STANDARD_RUNTIME_PROFILES: JSON.stringify([
        {
          appId: "new-app",
          authOwnership: { kind: "dedicated-app-development", resource: base.authDatabase },
          authority,
          gatewayProductionWorkload: {
            audience: workload.audience,
            issuer: workload.issuer,
            subject: "explicitly-reviewed-production-gateway",
          },
          gatewayWorkload: {
            audience: workload.audience,
            issuer: workload.issuer,
            subject: "same-project-gateway",
          },
          productionDatabaseIdentity: "ep-production.neon.tech/auth",
          publicOrigin: "https://apps-new-app.vercel.app",
          resourceProfileId: "isolated",
        },
      ]),
    };
    const readStandardDestination = vi.fn().mockResolvedValue(destination);
    const readStandardCapture = vi.fn().mockResolvedValue({ description, selection: selected });
    const resolve = createNativeTargetConfigurationResolver({
      configuration: base,
      environment,
      openResources: async () => ({ ...f.resources, readStandardCapture, readStandardDestination }),
    });
    const body = {
      action: "resolve-preview-target",
      appId: "new-app",
      ownerContext,
      sessionId: ownerContext.sessionId,
    };
    return {
      ...f,
      base,
      body,
      description,
      destination,
      environment,
      readStandardCapture,
      readStandardDestination,
      resolve,
      selected,
    };
  };
  it("uses the real normal receipt and captured source without reading legacy native registration", async () => {
    const f = fixture();
    const result = await f.resolve(request(f.body));
    expect(result.gateway).toMatchObject({
      branch: f.selected.publishedSource.branch,
      environment: "preview",
      gitSha: f.selected.publishedSource.gitSha,
      projectId: f.destination.projectId,
      publicOrigin: "https://apps-new-app.vercel.app",
      repoId: "123",
    });
    expect(result.gateway.deploymentId).toBeUndefined();
    expect(result.sandbox.workers["new-app"]).toEqual(capturedGenericWorkerFixture);
    expect(result.standardRuntime?.publicRealmWorkload).toMatchObject({
      environment: "production",
      ownerId: f.destination.teamId,
      projectId: f.destination.projectId,
      subject: "explicitly-reviewed-production-gateway",
    });
    expect(result.applications["new-app"]).toMatchObject({
      accessRoles: ["member"],
      projectId: result.gateway.projectId,
      projectSettings: { framework: "services", rootDirectory: "." },
    });
    expect(result.applications.sibling).toBeUndefined();
    expect(result.gateway.projectId).not.toBe(f.base.gateway.projectId);
    expect(result.nativeNeon).toEqual(f.base.nativeNeon);
    expect(f.resources.registry.read).not.toHaveBeenCalled();
    expect(f.base.gateway.projectId).toBe("gateway");
  });
  it.each(["missing-destination", "foreign-source", "foreign-profile", "private-delivery"])(
    "refuses %s without falling back to a legacy target",
    async (failure) => {
      const f = fixture();
      if (failure === "missing-destination") {
        f.readStandardDestination.mockResolvedValue(undefined);
      }
      if (failure === "foreign-source") {
        f.selected.publishedSource.repositoryId = "foreign-repository";
      }
      if (failure === "foreign-profile") {
        f.environment.PROTECTED_HOSTED_OPERATOR_RESOURCE_PROFILES = JSON.stringify([
          {
            appId: "new-app",
            authority: { ...authority, ownerUserId: "other" },
            configuration: f.base,
            id: "isolated",
          },
        ]);
      }
      if (failure === "private-delivery") {
        f.readStandardDestination.mockResolvedValue({
          ...f.destination,
          deploymentAccess: undefined,
        });
      }
      await expect(f.resolve(request(f.body))).rejects.toThrow();
      expect(f.resources.registry.read).not.toHaveBeenCalled();
    },
  );
  it("routes public release through the same normal destination and never reads the obsolete registry", async () => {
    const f = fixture();
    const result = await f.resolve(
      request({
        action: "public-release-plan",
        adapterSessionId: ownerContext.adapterSessionId,
        appId: "new-app",
        callId: "release-call",
        execution: { logicalSessionId: ownerContext.adapterSessionId },
        ownerContext,
      }),
    );
    expect(result.gateway.projectId).toBe(f.destination.projectId);
    expect(result.standardRuntime?.productionDatabaseIdentity).toBe("ep-production.neon.tech/auth");
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
  it("does not borrow a legacy native target for an unconfigured public release", async () => {
    const f = setup();
    await expect(
      f.resolve(
        request({
          action: "public-release-plan",
          adapterSessionId: ownerContext.adapterSessionId,
          appId: "new-app",
          callId: "release-call",
          execution: { logicalSessionId: ownerContext.adapterSessionId },
          ownerContext,
        }),
      ),
    ).rejects.toMatchObject({ code: "builder_destination_configuration_required" });
    expect(f.resources.registry.read).not.toHaveBeenCalled();
  });
});
it("closed receipt ingress has no request-selected app or unbounded pre-authorization JSON parsing", async () => {
  const fixture = setup();
  const result = await fixture.resolve(
    new Request("https://operator.example/v1/central-deployment-events", {
      body: "not-json; the authenticated receipt handler owns bounded parsing",
      method: "POST",
    }),
  );
  expect(result).toEqual(configuration());
  expect(fixture.openResources).not.toHaveBeenCalled();
});
