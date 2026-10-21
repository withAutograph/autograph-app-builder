/* oxlint-disable unicorn/no-useless-undefined -- Explicit empty registry results and void async mocks preserve the production port contracts. */
import { describe, expect, it, vi } from "vitest";
import { resolveNativeTargetEffectiveConfiguration } from "./native-target-effective-configuration";
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
