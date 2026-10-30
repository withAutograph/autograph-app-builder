/* oxlint-disable unicorn/no-useless-undefined -- Explicit empty registry results and void async mocks preserve the production port contracts. */
import { describe, expect, it, vi } from "vitest";
import { resolveNativeTargetEffectiveConfiguration } from "./native-target-effective-configuration";
import { nativeTargetResourceProfileAuthorityDigest } from "./native-target-resource-profile";
import type { NativeTargetReadyRegistration } from "./native-target-onboarding-contract";
import { createHostedOperatorNativeHandler } from "./hosted-operator-native";
import {
  createConfiguredPreviewTargetResolver,
  createRequestScopedHostedOperatorDependencies,
} from "./hosted-operator-composition";
import { createHostedOperatorNormalAuthTransport } from "./hosted-operator-normal-auth-transport";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { HostedOperatorError, operatorRequestSchema } from "./hosted-operator-contract";
import {
  nativeTargetOnboardingPlanDigest,
  nativeTargetOnboardingRecordSchema,
  nativeTargetRequiredProjectProtection,
} from "./native-target-onboarding-contract";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";

const worker = {
  executablePath: "/trusted/install",
  id: "trusted-installer",
  sha256: "a".repeat(64),
  operationScope: "generated-app-release-install-v1" as const,
  subcommand: "protected-generated-app-install" as const,
};
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  runtimeRole: `${name}_runtime`,
  resourceId: `${name}-resource`,
});
const workload = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  environment: "preview" as const,
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
  teamId: "team",
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
  operator: {
    deploymentId: "operator-deployment",
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator",
  },
  nativeNeon: {
    configuration: {
      connector: "approved-connector",
      nativeStore: {
        configurationId: "approved-store",
        resourceId: "store",
        sourceProjectId: "operator",
      },
      operator: {
        audience: workload.audience,
        environment: workload.environment,
        issuer: workload.issuer,
        ownerId: workload.ownerId,
        projectId: "operator",
      },
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
  sandbox: {
    accessWorker: worker,
    authWorker: worker,
    authProposal: { executablePath: "/trusted/propose", id: "proposal", sha256: "c".repeat(64) },
    resourcesWorker: worker,
    image: "trusted-image",
    projectId: "operator",
    teamId: "team",
    workers: { sibling: worker },
  },
  workloadPolicy: workload,
});
const ready = (appId = "new-app"): NativeTargetReadyRegistration => {
  const time = "2026-10-21T15:00:00.000Z";
  const attemptId = "11111111-1111-4111-8111-111111111111";
  const projectSettings = {
    framework: "nextjs" as const,
    rootDirectory: `apps/${appId}`,
    sourceFilesOutsideRootDirectory: true,
    buildCommand: "bun run build",
  };
  const result: NativeTargetReadyRegistration = {
    kind: "native-target-onboarding",
    version: 1,
    stage: "ready",
    appId,
    planDigest: "a".repeat(64),
    previousAttempts: [],
    plan: {
      version: 1,
      appId,
      branch: "main",
      appDatabase: resource(appId.replaceAll("-", "_")),
      productRoles: [],
      worker,
      origin: {
        publicSessionId: "original-session",
        adapterSessionId: "original-adapter",
        adapterGeneration: 1,
        appSpecDigest: "b".repeat(64),
        release: {
          id: "release-original",
          artifactRef: "private-artifact",
          manifestSha256: "c".repeat(64),
          schemaSha256: "d".repeat(64),
        },
      },
      project: {
        name: appId,
        teamId: "team",
        installationId: "installation",
        projectSettings,
        protection: nativeTargetRequiredProjectProtection,
      },
      nativeNeon: {
        approvalReference: "original-approved-native-scope",
        nativeStore: configuration().nativeNeon.configuration.nativeStore,
        scope: configuration().nativeNeon.scope,
      },
      cost: { ownership: "current-owner", description: "Approved native target" },
      retention: { policy: "retain" },
      conflictPolicy: "stop-on-conflict",
    },
    approval: {
      requestId: "request",
      callId: "call",
      planDigest: "a".repeat(64),
      responderPrincipalId: "owner",
      publicSessionId: "original-session",
      outcome: "approved",
      observedAt: time,
    },
    attempt: {
      attemptId,
      candidateName: appId,
      leaseId: attemptId,
      leaseExpiresAt: time,
      startedAt: time,
    },
    dispatchAuthorizedAt: time,
    acceptedCreation: { attemptId, projectId: `project-${appId}`, acceptedAt: time },
    registration: {
      attemptId,
      observed: {
        projectId: `project-${appId}`,
        name: appId,
        teamId: "team",
        installationId: "installation",
        projectSettings,
        protection: nativeTargetRequiredProjectProtection,
      },
      observedAt: time,
    },
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
  kind: "direct" as const,
  authority,
  principal: { ...authority, scopes: ["autograph:get"] },
  sessionId: "current-session",
  adapterSessionId: "current-adapter",
  adapterGeneration: 2,
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
const unavailable = (): Promise<never> => Promise.reject(new Error("Unexpected effect"));
const dependencies = (): ProtectedHostedOperatorDependencies => ({
  authorize: unavailable,
  assertAuthorized: unavailable,
  bindings: unavailable,
  executeEffect: unavailable,
  plan: unavailable,
  readApproval: unavailable,
  reconcile: unavailable,
  verify: unavailable,
  withResourceLease: unavailable,
  store: {
    compareAndSet: unavailable,
    read: unavailable,
    reserve: unavailable,
    reserveFenceGeneration: unavailable,
  },
});
const request = (appId = "new-app") =>
  new Request("https://operator.example/v1/runtime", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      action: "resolve-preview-target",
      appId,
      sessionId: ownerContext.sessionId,
      ownerContext,
    }),
  });

describe("owner-authorized native target configuration", () => {
  it("projects ready target facts, accepts empty declared roles, and preserves siblings and shared custody", async () => {
    const base = configuration();
    const registration = ready();
    const readReady = vi.fn().mockResolvedValue(registration);
    const effective = await resolveNativeTargetEffectiveConfiguration({
      configuration: base,
      invocation: ownerContext,
      appId: registration.appId,
      readReady,
    });
    expect(readReady).toHaveBeenCalledExactlyOnceWith(ownerContext, "new-app");
    expect(effective.applications["new-app"]).toEqual({
      accessRoles: [],
      nativeTargetRegistration: true,
      appDatabase: registration.plan.appDatabase,
      branch: "main",
      projectId: registration.registration.observed.projectId,
      projectSettings: registration.registration.observed.projectSettings,
    });
    expect(effective.sandbox.workers["new-app"]).toEqual(worker);
    expect(effective.applications.sibling).toEqual(base.applications.sibling);
    expect(effective.catalogAppIds).toEqual(["sibling", "new-app"]);
    expect(effective.gateway.protectedApplicationIds).toEqual(["sibling", "new-app"]);
    expect(effective.nativeNeon).toEqual(base.nativeNeon);
    expect(effective.authDatabase).toEqual(base.authDatabase);
    expect(base.applications["new-app"]).toBeUndefined();
    expect(Object.isFrozen(effective.applications["new-app"].projectSettings)).toBe(true);
    registration.plan.productRoles.push("later_role");
    expect(effective.applications["new-app"].accessRoles).toEqual([]);
  });
  it("keeps static configuration compatible when no ready registration exists, after authorized read", async () => {
    const base = configuration();
    const readReady = vi.fn().mockResolvedValue(undefined);
    expect(
      await resolveNativeTargetEffectiveConfiguration({
        configuration: base,
        invocation: ownerContext,
        appId: "sibling",
        readReady,
      }),
    ).toEqual(base);
    expect(readReady).toHaveBeenCalledOnce();
  });
  it("does not fall back to static authority after the registry denies current ownership", async () => {
    const readReady = vi.fn().mockRejectedValue(new HostedOperatorError("authorization_required"));
    await expect(
      resolveNativeTargetEffectiveConfiguration({
        configuration: configuration(),
        invocation: ownerContext,
        appId: "sibling",
        readReady,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
  it.each(["foreign-team", "operator", "gateway"])(
    "rejects cross-boundary registered target %s",
    async (boundary) => {
      const registration = ready();
      if (boundary === "foreign-team") {
        registration.registration.observed.teamId = boundary;
      } else {
        registration.registration.observed.projectId = boundary;
      }
      await expect(
        resolveNativeTargetEffectiveConfiguration({
          configuration: configuration(),
          invocation: ownerContext,
          appId: "new-app",
          readReady: vi.fn().mockResolvedValue(registration),
        }),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
    },
  );
  it("does not compare later source/session identity or add unrelated registrations to old operation snapshots", async () => {
    const base = configuration();
    const readReady = vi.fn(
      async (_invocation: typeof ownerContext, appId: string) =>
        await Promise.resolve(ready(appId)),
    );
    const first = await resolveNativeTargetEffectiveConfiguration({
      configuration: base,
      invocation: ownerContext,
      appId: "first",
      readReady,
    });
    const second = await resolveNativeTargetEffectiveConfiguration({
      configuration: base,
      invocation: { ...ownerContext, adapterGeneration: 3 },
      appId: "second",
      readReady,
    });
    expect(first.catalogAppIds).toEqual(["sibling", "first"]);
    expect(second.catalogAppIds).toEqual(["sibling", "second"]);
    expect(first.applications.second).toBeUndefined();
  });
  it("reads fresh registration on the next native request without caching another app's dependencies", async () => {
    const registry = new Map<string, NativeTargetReadyRegistration>();
    const close = vi.fn().mockResolvedValue(undefined);
    const readReady = vi.fn(async () => await Promise.resolve(registry.get("new-app")));
    const handler = createHostedOperatorNativeHandler({
      createRequestDependencies: async (incoming) => {
        const effective = await resolveNativeTargetEffectiveConfiguration({
          configuration: configuration(),
          invocation: incoming,
          appId: "new-app",
          readReady,
        });
        return {
          close,
          dependencies: {
            ...dependencies(),
            resolvePreviewTarget: createConfiguredPreviewTargetResolver(
              effective,
              { authorize: vi.fn().mockResolvedValue({ authority, ownerContext }) },
              {
                authorize: vi.fn().mockResolvedValue(context()),
                assertPlanningAuthorized: vi.fn().mockResolvedValue(undefined),
              },
            ),
          },
        };
      },
    });
    const firstResponse = await handler(request());
    expect(await firstResponse.json()).toMatchObject({
      code: "resource_mismatch",
      status: "blocked",
    });
    registry.set("new-app", ready());
    const secondResponse = await handler(request());
    expect(await secondResponse.json()).toMatchObject({
      appId: "new-app",
      projectId: "project-new-app",
    });
    expect(readReady).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("isolates concurrent app resolutions instead of sharing the first request configuration", async () => {
    const readReady = vi.fn(
      async (_incoming: Request, appId: string) => await Promise.resolve(ready(appId)),
    );
    const close = vi.fn().mockResolvedValue(undefined);
    const handler = createHostedOperatorNativeHandler({
      createRequestDependencies: async (incoming) => {
        const parsed = operatorRequestSchema.parse(await incoming.clone().json());
        if (parsed.action !== "resolve-preview-target") {
          throw new Error("Unexpected fixture request");
        }
        const effective = await resolveNativeTargetEffectiveConfiguration({
          configuration: configuration(),
          invocation: incoming,
          appId: parsed.appId,
          readReady,
        });
        return {
          close,
          dependencies: {
            ...dependencies(),
            resolvePreviewTarget: createConfiguredPreviewTargetResolver(
              effective,
              { authorize: vi.fn().mockResolvedValue({ authority, ownerContext }) },
              {
                authorize: vi.fn().mockResolvedValue(context(parsed.appId)),
                assertPlanningAuthorized: vi.fn().mockResolvedValue(undefined),
              },
            ),
          },
        };
      },
    });
    const responses = await Promise.all([handler(request("first")), handler(request("second"))]);
    const values = await Promise.all(
      responses.map(async (response) => {
        const value: unknown = await response.json();
        return value;
      }),
    );
    expect(values).toEqual([
      expect.objectContaining({ appId: "first", projectId: "project-first" }),
      expect.objectContaining({ appId: "second", projectId: "project-second" }),
    ]);
    expect(readReady).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("closes request resources on invalid composition and does not let close failure change a settled response", async () => {
    const close = vi.fn().mockRejectedValue(new Error("private-close-error"));
    const valid = dependencies();
    valid.authorize = vi.fn().mockRejectedValue(new HostedOperatorError("authorization_required"));
    const handler = createHostedOperatorNativeHandler({
      createRequestDependencies: vi.fn().mockResolvedValue({ dependencies: valid, close }),
    });
    const result = await handler(request());
    expect(await result.json()).toMatchObject({ status: "blocked" });
    expect(close).toHaveBeenCalledOnce();
    Reflect.deleteProperty(valid, "store");
    const invalidResponse = await handler(request());
    expect(invalidResponse.status).toBe(503);
    expect(close).toHaveBeenCalledTimes(2);
  });
  it("opens the control plane only after resolution using the exact effective snapshot", async () => {
    const effective = await resolveNativeTargetEffectiveConfiguration({
      configuration: configuration(),
      invocation: ownerContext,
      appId: "new-app",
      readReady: vi.fn().mockResolvedValue(ready()),
    });
    const openControlPlane = vi
      .fn<typeof createHostedOperatorControlPlane>()
      .mockRejectedValue(new Error("fixture-stop-before-private-io"));
    const resolveConfiguration = vi.fn(async (incoming: Request) => {
      await incoming.json();
      return effective;
    });
    const loader = createRequestScopedHostedOperatorDependencies({
      resolveConfiguration,
      openControlPlane,
    });
    const incoming = request();
    await expect(loader(incoming)).rejects.toThrow("fixture-stop-before-private-io");
    expect(resolveConfiguration).toHaveBeenCalledOnce();
    expect(incoming.bodyUsed).toBe(false);
    expect(openControlPlane).toHaveBeenCalledExactlyOnceWith({
      environment: undefined,
      sourceConfiguration: effective,
      workloadPolicy: effective.workloadPolicy,
    });
    resolveConfiguration.mockRejectedValue(new HostedOperatorError("authorization_required"));
    await expect(loader(request())).rejects.toMatchObject({ code: "authorization_required" });
    expect(openControlPlane).toHaveBeenCalledOnce();
  });
  it("supports the real normal Auth transport app lookup with the same effective target", async () => {
    const effective = await resolveNativeTargetEffectiveConfiguration({
      configuration: configuration(),
      invocation: ownerContext,
      appId: "new-app",
      readReady: vi.fn().mockResolvedValue(ready()),
    });
    const current = vi.fn().mockResolvedValue(undefined);
    const transport = await createHostedOperatorNormalAuthTransport(
      {
        configuration: effective,
        context: context(),
        origin: effective.gateway.publicOrigin,
        assertCurrentOwner: current,
        assertPlanningAuthorized: vi.fn().mockResolvedValue(undefined),
      },
      {
        getOidc: vi.fn().mockResolvedValue("synthetic-token"),
        verifyOidc: vi.fn().mockResolvedValue(undefined),
        fetch: vi.fn().mockResolvedValue(Response.json({ user: "synthetic" })),
      },
    );
    const response = await transport(
      `${effective.gateway.publicOrigin}/api/auth/get-session?disableRefresh=true&disableCookieCache=true`,
      { method: "GET", headers: { origin: effective.gateway.publicOrigin } },
    );
    expect(response.status).toBe(200);
    expect(current).toHaveBeenCalled();
  });
});

const resourceProfileFixture = () => {
  const base = configuration();
  const selected = configuration();
  selected.authDatabase = resource("isolated_auth");
  selected.nativeNeon = {
    ...selected.nativeNeon,
    scope: {
      ...selected.nativeNeon.scope,
      projectId: "isolated-neon",
      branchId: "br-isolated",
      endpointId: "ep-isolated",
      hostname: "ep-isolated.neon.tech",
    },
    configuration: {
      ...selected.nativeNeon.configuration,
      nativeStore: {
        ...selected.nativeNeon.configuration.nativeStore,
        resourceId: "isolated-store",
      },
    },
  };
  selected.gateway = {
    ...selected.gateway,
    projectId: "isolated-gateway",
    authBrowserOrigin: "https://isolated-auth.example",
    gatewayOrigin: "https://isolated-gateway.example",
    publicOrigin: "https://isolated-apps.example",
    workload: { ...selected.gateway.workload, projectId: "isolated-gateway" },
  };
  const registration = ready();
  registration.plan.resourceProfileId = "isolated-development";
  registration.plan.resourceProfileAuthorityDigest =
    nativeTargetResourceProfileAuthorityDigest(selected);
  registration.plan.resourceSelectionRevision = 1;
  registration.plan.nativeNeon = {
    ...registration.plan.nativeNeon,
    scope: structuredClone(selected.nativeNeon.scope),
    nativeStore: structuredClone(selected.nativeNeon.configuration.nativeStore),
  };
  registration.plan.appDatabase = {
    ...registration.plan.appDatabase,
    resourceId: "isolated-store",
  };
  registration.planDigest = nativeTargetOnboardingPlanDigest(registration.plan);
  registration.approval.planDigest = registration.planDigest;
  const verified = nativeTargetOnboardingRecordSchema.parse(registration);
  if (verified.stage !== "ready") {
    throw new Error("Expected ready resource profile fixture.");
  }
  return { base, selected, registration: verified };
};

describe("ready target selected resource custody", () => {
  it("uses one selected Auth, Gateway and Neon configuration together with the current app registration", async () => {
    const f = resourceProfileFixture();
    const selectResourceConfiguration = vi.fn(() => f.selected);
    const effective = await resolveNativeTargetEffectiveConfiguration({
      configuration: f.base,
      invocation: ownerContext,
      appId: "new-app",
      readReady: () => Promise.resolve(f.registration),
      selectResourceConfiguration,
    });
    expect(selectResourceConfiguration).toHaveBeenCalledExactlyOnceWith(f.registration);
    expect(effective.authDatabase).toEqual(f.selected.authDatabase);
    expect(effective.nativeNeon).toEqual(f.selected.nativeNeon);
    expect(effective.gateway).toMatchObject({
      projectId: "isolated-gateway",
      authBrowserOrigin: "https://isolated-auth.example",
      gatewayOrigin: "https://isolated-gateway.example",
      publicOrigin: "https://isolated-apps.example",
    });
    expect(effective.applications["new-app"]).toMatchObject({
      nativeTargetRegistration: true,
      projectId: f.registration.registration.observed.projectId,
      appDatabase: f.registration.plan.appDatabase,
      branch: f.registration.plan.branch,
    });
    expect(effective.sandbox.workers["new-app"]).toEqual(f.registration.plan.worker);
    expect(effective.gateway.protectedApplicationIds).toContain("new-app");
    expect(f.base.authDatabase).toEqual(resource("auth"));
    expect(f.base.applications["new-app"]).toBeUndefined();
  });

  it("never falls back to base custody for a ready plan whose resource profile cannot be resolved", async () => {
    const f = resourceProfileFixture();
    await expect(
      resolveNativeTargetEffectiveConfiguration({
        configuration: f.base,
        invocation: ownerContext,
        appId: "new-app",
        readReady: () => Promise.resolve(f.registration),
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.base.applications["new-app"]).toBeUndefined();
  });

  it.each(["native-store", "scope", "app-resource"] as const)(
    "rejects a selected %s that differs from the approved ready plan",
    async (boundary) => {
      const f = resourceProfileFixture();
      if (boundary === "native-store") {
        f.selected.nativeNeon.configuration.nativeStore.resourceId = "different-store";
      } else if (boundary === "scope") {
        f.selected.nativeNeon.scope.branchId = "different-branch";
      } else {
        f.registration.plan.appDatabase.resourceId = "different-app-resource";
        f.registration.planDigest = nativeTargetOnboardingPlanDigest(f.registration.plan);
        f.registration.approval.planDigest = f.registration.planDigest;
      }
      await expect(
        resolveNativeTargetEffectiveConfiguration({
          configuration: f.base,
          invocation: ownerContext,
          appId: "new-app",
          readReady: () => Promise.resolve(f.registration),
          selectResourceConfiguration: () => f.selected,
        }),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.base.applications["new-app"]).toBeUndefined();
    },
  );
});

it.each(["auth-database", "gateway-origin"] as const)(
  "refuses changed %s authority under the same profile and Neon target",
  async (boundary) => {
    const f = resourceProfileFixture();
    if (boundary === "auth-database") {
      f.selected.authDatabase = {
        ...f.selected.authDatabase,
        database: "another_auth",
        runtimeRole: "another_auth_runtime",
      };
    } else {
      f.selected.gateway.publicOrigin = "https://other-isolated-apps.example";
    }
    expect(f.selected.nativeNeon.scope).toEqual(f.registration.plan.nativeNeon.scope);
    expect(f.selected.nativeNeon.configuration.nativeStore).toEqual(
      f.registration.plan.nativeNeon.nativeStore,
    );
    await expect(
      resolveNativeTargetEffectiveConfiguration({
        configuration: f.base,
        invocation: ownerContext,
        appId: "new-app",
        readReady: () => Promise.resolve(f.registration),
        selectResourceConfiguration: () => f.selected,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(f.base.applications["new-app"]).toBeUndefined();
  },
);

it("accepts ordinary source, deployment and worker-byte changes while retaining the approved app worker", async () => {
  const f = resourceProfileFixture();
  f.selected.gateway.gitSha = "e".repeat(40);
  f.selected.gateway.deploymentId = "later-gateway-deployment";
  const operator = {
    ...f.selected.operator,
    deploymentId: "later-operator-deployment",
  };
  f.selected.operator = operator;
  f.base.operator = { ...operator };
  if ("image" in f.selected.sandbox) {
    f.selected.sandbox.image = "later-trusted-image";
  }
  const updatedWorker = {
    ...worker,
    executablePath: "/trusted/updated-install",
    sha256: "f".repeat(64),
  };
  f.selected.sandbox.resourcesWorker = {
    ...f.selected.sandbox.resourcesWorker,
    executablePath: updatedWorker.executablePath,
    sha256: updatedWorker.sha256,
  };
  f.selected.sandbox.authWorker = {
    ...f.selected.sandbox.authWorker,
    executablePath: updatedWorker.executablePath,
    sha256: updatedWorker.sha256,
  };
  f.selected.sandbox.accessWorker = {
    ...f.selected.sandbox.accessWorker,
    executablePath: updatedWorker.executablePath,
    sha256: updatedWorker.sha256,
  };
  f.selected.sandbox.workers["new-app"] = updatedWorker;
  const effective = await resolveNativeTargetEffectiveConfiguration({
    configuration: f.base,
    invocation: ownerContext,
    appId: "new-app",
    readReady: () => Promise.resolve(f.registration),
    selectResourceConfiguration: () => f.selected,
  });
  expect(effective.gateway.gitSha).toBe("e".repeat(40));
  expect(effective.operator.deploymentId).toBe("later-operator-deployment");
  expect(effective.sandbox.resourcesWorker.sha256).toBe("f".repeat(64));
  expect(effective.sandbox.workers["new-app"]).toEqual(f.registration.plan.worker);
  expect(effective.applications["new-app"].projectId).toBe(
    f.registration.registration.observed.projectId,
  );
});

it.each(["operator", "builder-callback"] as const)(
  "rejects a changed %s authority endpoint even when the deployment base changes with it",
  async (kind) => {
    const f = resourceProfileFixture();
    if (kind === "operator") {
      f.selected.operator.origin = "https://other-operator.example";
      f.base.operator.origin = f.selected.operator.origin;
    } else {
      f.selected.builderCallbackOrigin = "https://other-builder.example";
      f.base.builderCallbackOrigin = f.selected.builderCallbackOrigin;
    }
    await expect(
      resolveNativeTargetEffectiveConfiguration({
        configuration: f.base,
        invocation: ownerContext,
        appId: "new-app",
        readReady: () => Promise.resolve(f.registration),
        selectResourceConfiguration: () => f.selected,
      }),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  },
);
