/* oxlint-disable unicorn/no-useless-undefined -- Explicit absent optional registry rows and void mocks match the read ports. */
import { describe, expect, it, vi } from "vitest";
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

interface ConfigurationFixtureBody {
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
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
const setup = () => {
  const order: string[] = [];
  const record = ready();
  const registry = {
    read: vi.fn(async () => {
      order.push("registry");
      return await Promise.resolve({
        authority,
        appId: record.appId,
        requestId: "registry",
        revision: 1,
        record,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
    }),
  };
  const resources = {
    owner: {
      verifyWorkload: vi.fn(async () => {
        order.push("workload");
        await Promise.resolve();
      }),
      assertCanonicalAppOwner: vi.fn(async () => {
        order.push("owner");
        await Promise.resolve();
      }),
    },
    registry,
    continuity: { read: vi.fn().mockResolvedValue({ plan: { target: context().target } }) },
    exports: { read: vi.fn().mockResolvedValue({ originalTarget: context().target }) },
    close: vi.fn(async () => {
      order.push("close");
      await Promise.resolve();
    }),
  } satisfies NativeTargetConfigurationResources;
  const openResources = vi.fn(async () => await Promise.resolve(resources));
  return {
    resolve: createNativeTargetConfigurationResolver({
      configuration: configuration(),
      openResources,
    }),
    resources,
    openResources,
    order,
  };
};

describe("production native target configuration resolver", () => {
  it("verifies current app ownership before the actual registry reader and projects ready metadata", async () => {
    const fixture = setup();
    const effective = await fixture.resolve(
      request({
        action: "resolve-preview-target",
        appId: "new-app",
        sessionId: ownerContext.sessionId,
        ownerContext,
      }),
    );
    expect(fixture.order).toEqual(["workload", "owner", "registry", "close"]);
    expect(fixture.resources.owner.assertCanonicalAppOwner).toHaveBeenCalledExactlyOnceWith({
      authority,
      ownerContext,
      target: { appId: "new-app", sessionId: ownerContext.sessionId },
    });
    expect(fixture.resources.registry.read).toHaveBeenCalledExactlyOnceWith({
      authority,
      appId: "new-app",
    });
    expect(effective.applications["new-app"].projectId).toBe("project-new-app");
  });
  it("resolves an ordinary selected app operation through fresh registry authorization", async () => {
    const fixture = setup();
    const target = context().target;
    const effective = await fixture.resolve(
      request({
        action: "plan",
        operation: "prepare",
        ownerContext,
        selection: {
          appId: target.appId,
          sessionId: target.sessionId,
          projectId: target.projectId,
          branch: target.branch,
          environment: target.environment,
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
            sessionId: ownerContext.sessionId,
            ownerContext,
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
            planRef: action.startsWith("export")
              ? `_protected-operator/export-plans/${id}`
              : `private-plan/${id}`,
            planDigest: "a".repeat(64),
            idempotencyKey: "same-operation",
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
      authority,
      appId: "new-app",
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
      phase: "check",
      sessionId: ownerContext.sessionId,
      ownerContext,
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
