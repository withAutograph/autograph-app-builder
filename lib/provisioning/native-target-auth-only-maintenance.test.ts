/* oxlint-disable eslint/require-await, typescript/no-unsafe-type-assertion -- Owned partial configuration fixtures exercise the private adapter without provider IO. */
import { createHash } from "node:crypto";
import { beforeEach, expect, it, vi } from "vitest";
import type { HostedOperatorContext } from "./hosted-operator-service";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";
import type { PreviewNeonMcpDependencies } from "./hosted-operator-native-preview-neon-mcp";
import { createNativeTargetAuthOnlyMaintenanceReader } from "./native-target-auth-only-maintenance";
import { planNativeTargetAuthOnly } from "./native-target-auth-only-planner";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";

const mocks = vi.hoisted(() => ({
  access: vi.fn(),
  acquire: vi.fn(),
  profile: vi.fn(),
  store: vi.fn(),
}));
vi.mock("./native-target-resource-profile", () => ({
  resolveNativeTargetResourceProfile: mocks.profile,
}));
vi.mock("../agent/prepared-provider-context", () => ({
  readOwnerVercelProjectAccess: mocks.access,
}));
vi.mock("./hosted-runtime-native-neon-binding", () => ({
  readVercelNativeNeonBinding: mocks.store,
}));
vi.mock("./hosted-operator-native-preview-neon-mcp", () => ({
  createPreviewNeonMcpReader: (deps: PreviewNeonMcpDependencies) => ({
    withMaintenanceCredential: async (
      context: HostedOperatorContext,
      scope: Parameters<PreviewNeonMcpDependencies["assertApprovedScope"]>[1],
      consume: (material: {
        maintenanceUrl: string;
        scope: typeof scope;
        initSource: "empty";
      }) => Promise<unknown>,
    ) => {
      context = { ...context, ownerContext: context.ownerContext };
      await deps.assertApprovedScope(context, scope);
      await deps.readCurrentOwnerNativeStore(context, deps.configuration.nativeStore);
      await deps.assertApprovedOwner!(context, scope, deps.configuration.nativeStore);
      await mocks.acquire();
      await deps.assertApprovedOwner!(context, scope, deps.configuration.nativeStore);
      return await consume({ initSource: "empty", maintenanceUrl: "private-fixture-uri", scope });
    },
  }),
}));

const sha = (value: Buffer) => createHash("sha256").update(value).digest("hex");
const bytes = (value: unknown) => Buffer.from(JSON.stringify(value));
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "fixture-owner",
  workspaceId: "fixture-workspace",
};
const target = {
  appId: "signup-pilot",
  branch: "pilot",
  environment: "preview" as const,
  installationId: "icfg-owner",
  projectId: "prj-pilot",
  scopeId: "team-owner",
  scopeType: "team" as const,
  sessionId: "saved-session",
};
const baseProfile = {
  applications: {},
  authDatabase: {
    database: "pilot_auth",
    migratorRole: "pilot_migrator",
    resourceId: "isolated-auth",
    runtimeRole: "pilot_runtime",
  },
  authOnlyApplications: { "signup-pilot": { accessRoles: ["pilot_user"] } },
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "pilot",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    projectId: "prj-gateway",
    publicOrigin: "https://apps.example",
    workload: { projectId: "prj-gateway" },
  },
  nativeNeon: {
    configuration: {
      connector: "neon-owned",
      nativeStore: {
        configurationId: "icfg-neon",
        resourceId: "store-neon",
        sourceProjectId: "prj-anchor",
      },
      operator: {
        audience: "https://vercel.com/owner",
        environment: "preview" as const,
        issuer: "https://oidc.vercel.com/owner",
        ownerId: "team-owner",
        projectId: "prj-operator",
      },
    },
    scope: {
      branchId: "pilot-branch",
      endpointId: "ep-pilot",
      hostname: "ep-pilot.neon.tech",
      maintenanceDatabase: "neondb",
      maintenanceRole: "bootstrap_owner",
      projectId: "pilot-project",
    },
  },
  operator: {
    environment: "preview",
    origin: "https://operator.example",
    projectId: "prj-operator",
  },
  sandbox: { resourcesWorker: { id: "neon-resource-bootstrap-v1", sha256: "b".repeat(64) } },
};
const source = {
  branch: "pilot",
  changeSetDigest: "c".repeat(64),
  gitSha: "d".repeat(40),
  gitTree: "e".repeat(40),
  repositoryId: "repo-fixture",
  reviewDigest: "f".repeat(64),
};
const plan = planNativeTargetAuthOnly({
  authAuthorityBinding: {
    authDatabase: baseProfile.authDatabase,
    gateway: baseProfile.gateway,
    nativeNeon: baseProfile.nativeNeon,
    operator: baseProfile.operator,
  },
  authSchema: {
    artifactRef: "auth-artifact",
    installer: { reference: "auth-worker", sha256: "4".repeat(64) },
    planDigest: "1".repeat(64),
    targetDigest: "2".repeat(64),
  },
  capturedDescription: {
    app: { id: target.appId, routes: ["/"], workspacePath: "apps/signup-pilot" },
    backend: { kind: "static" },
    deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
    validation: { browser: null, check: { task: "mise run app:check signup-pilot" }, test: null },
    version: 1,
  },
  configuredAppRoles: ["pilot_user"],
  owner: {
    adapterGeneration: 1,
    adapterSessionId: "saved-adapter",
    authority,
    publicSessionId: target.sessionId,
  },
  proposal: {
    appId: target.appId,
    appRole: "pilot_user",
    appSpecDigest: "a".repeat(64),
    authProfileId: "pilot-profile",
    branch: target.branch,
    project: {
      installationId: target.installationId,
      name: "pilot-preview",
      teamId: target.scopeId,
    },
  },
  publishedSource: source,
  selectedPhysicalEndpointId: "ep-pilot",
  selectedProfile: {
    appId: target.appId,
    authority,
    configuration: { authDatabase: baseProfile.authDatabase },
    id: "pilot-profile",
  },
  sharedAuthResourceId: "shared-auth",
  sharedPhysicalEndpointId: "shared-endpoint",
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const resourcePlan = {
  action: "prepare",
  authDatabase: baseProfile.authDatabase,
  authOnlyPlanDigest: planDigest,
  bootstrap: { endpointId: "ep-pilot", maintenanceDatabase: "neondb", role: "bootstrap_owner" },
  effects: [{ id: "auth-resources", kind: "resources", resourceId: "isolated-auth" }],
  nativeNeonConfiguration: baseProfile.nativeNeon.configuration,
  neon: { branchId: "pilot-branch", endpoint: "ep-pilot.neon.tech", projectId: "pilot-project" },
  resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "b".repeat(64) },
  target,
  version: 1,
};
const execution = {
  fenceGeneration: 7,
  leaseId: "33333333-3333-4333-a333-333333333333",
  operationRef: "11111111-1111-4111-a111-111111111111",
  workerAttemptId: "22222222-2222-4222-a222-222222222222",
};
beforeEach(() => {
  vi.clearAllMocks();
});
const fixture = () => {
  const profile = structuredClone(baseProfile);
  mocks.profile.mockReturnValue(profile);
  mocks.acquire.mockResolvedValue();
  mocks.access.mockImplementation(
    async (input: { readCredential: () => Promise<unknown>; projectId: string }) => {
      await input.readCredential();
      return {
        project: { id: input.projectId },
        scope: { id: target.scopeId, type: target.scopeType },
        status: "ready",
      };
    },
  );
  mocks.store.mockResolvedValue({ neonProjectId: "pilot-project", resourceId: "store-neon" });
  const approval = {
    callId: "resource-call",
    observedAt: "2026-11-06T12:00:00.000Z",
    outcome: "approved" as const,
    planDigest,
    publicSessionId: target.sessionId,
    requestId: "resource-request",
    responderPrincipalId: authority.ownerUserId,
    sourceDigest: sha(bytes(resourcePlan)),
  };
  const retained = {
    approval: structuredClone(approval),
    approvedResourcePlanBytes: bytes(resourcePlan),
    plan: structuredClone(plan),
  };
  const credential = {
    binding: {
      active: true,
      displayName: "Fixture team",
      installationId: target.installationId,
      plan: "pro",
      scopeId: target.scopeId,
      scopeType: target.scopeType,
      slug: "fixture-team",
      updatedAt: new Date("2026-11-06T12:00:00Z"),
    },
    token: "fixture-owner-token",
  };
  const input = {
    approval,
    approvedResourcePlanBytes: bytes(resourcePlan),
    assertCurrent: vi.fn(async () => undefined),
    assertCurrentOwner: vi.fn(async () => undefined),
    configuration: {} as HostedOperatorSourceConfiguration,
    context: { authority: { ...authority }, target: { ...target } },
    environment: {},
    execution: { ...execution },
    plan: structuredClone(plan),
    readCredential: vi.fn(async () => credential),
    readRetainedResourceApproval: vi.fn<
      Parameters<
        typeof createNativeTargetAuthOnlyMaintenanceReader
      >[0]["readRetainedResourceApproval"]
    >(async () => retained),
  };
  const consume = vi.fn(async (material: { maintenanceUrl: string }) =>
    material.maintenanceUrl === "private-fixture-uri" ? "consumed-privately" : "wrong",
  );
  return { consume, credential, input, profile, retained };
};

it("acquires through existing current-owner native-store checks for the exact resource approval", async () => {
  const f = fixture();
  const reader = createNativeTargetAuthOnlyMaintenanceReader(f.input);
  await expect(reader.withMaintenanceCredential(f.consume)).resolves.toBe("consumed-privately");
  expect(f.input.readCredential).toHaveBeenCalledWith(authority, target.installationId);
  expect(mocks.access).toHaveBeenCalledWith(expect.objectContaining({ projectId: "prj-anchor" }));
  expect(f.input.assertCurrent).toHaveBeenCalledWith({
    context: { ...f.input.context, ownerContext: undefined },
    effectId: "auth-resources",
    execution,
    planDigest,
    resourceId: "isolated-auth",
    resourcePlanDigest: f.input.approval.sourceDigest,
  });
  expect(f.input.readRetainedResourceApproval.mock.calls.length).toBeGreaterThan(2);
  expect(f.consume).toHaveBeenCalledOnce();
});

it.each([
  "schema-approval",
  "cancelled",
  "foreign-owner",
  "foreign-session",
  "resource-digest",
  "target",
  "source-plan",
  "endpoint",
  "database",
  "worker",
  "native-custody",
  "second-resource",
] as const)("rejects %s before any credential acquisition", (kind) => {
  const f = fixture();
  const changed = structuredClone(resourcePlan);
  if (kind === "schema-approval") {
    f.input.approval.sourceDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, source);
  }
  if (kind === "cancelled") {
    Object.assign(f.input.approval, { outcome: "cancelled" });
  }
  if (kind === "foreign-owner") {
    f.input.approval.responderPrincipalId = "other";
  }
  if (kind === "foreign-session") {
    f.input.context.target.sessionId = "other";
  }
  if (kind === "resource-digest") {
    f.input.approvedResourcePlanBytes = Buffer.from(JSON.stringify(resourcePlan, null, 2));
  }
  if (kind === "target") {
    changed.target.projectId = "prj-other";
  }
  if (kind === "source-plan") {
    changed.authOnlyPlanDigest = "f".repeat(64);
  }
  if (kind === "endpoint") {
    changed.bootstrap.endpointId = "ep-other";
  }
  if (kind === "database") {
    changed.authDatabase.database = "other";
  }
  if (kind === "worker") {
    changed.resourcesInstaller.sha256 = "f".repeat(64);
  }
  if (kind === "native-custody") {
    changed.nativeNeonConfiguration.connector = "foreign-connector";
  }
  if (kind === "second-resource") {
    changed.effects.push({ id: "app-resource", kind: "resources", resourceId: "app" });
  }
  if (
    [
      "target",
      "source-plan",
      "endpoint",
      "database",
      "worker",
      "native-custody",
      "second-resource",
    ].includes(kind)
  ) {
    f.input.approvedResourcePlanBytes = bytes(changed);
    f.input.approval.sourceDigest = sha(bytes(changed));
  }
  expect(() => createNativeTargetAuthOnlyMaintenanceReader(f.input)).toThrow();
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(f.input.readCredential).not.toHaveBeenCalled();
});

it.each([
  "missing",
  "plan",
  "bytes",
  "approval",
  "lease",
  "membership",
  "profile",
  "worker",
  "connector",
  "native-store",
] as const)("revalidates retained %s before acquiring private material", async (kind) => {
  const f = fixture();
  const reader = createNativeTargetAuthOnlyMaintenanceReader(f.input);
  if (kind === "missing") {
    f.input.readRetainedResourceApproval.mockResolvedValue(undefined);
  }
  if (kind === "plan") {
    f.retained.plan.publishedSource.gitSha = "1".repeat(40);
  }
  if (kind === "bytes") {
    f.retained.approvedResourcePlanBytes.fill(32);
  }
  if (kind === "approval") {
    f.retained.approval.callId = "different-call";
  }
  if (kind === "lease") {
    f.input.assertCurrent.mockRejectedValue(new Error("lease lost"));
  }
  if (kind === "membership") {
    f.input.assertCurrentOwner.mockRejectedValue(new Error("revoked"));
  }
  if (kind === "profile") {
    f.profile.nativeNeon.scope.endpointId = "ep-other";
  }
  if (kind === "worker") {
    f.profile.sandbox.resourcesWorker.sha256 = "f".repeat(64);
  }
  if (kind === "connector") {
    f.profile.nativeNeon.configuration.connector = "other-connector";
  }
  if (kind === "native-store") {
    f.profile.nativeNeon.configuration.nativeStore.resourceId = "other-store";
  }
  await expect(reader.withMaintenanceCredential(f.consume)).rejects.toThrow(
    "Approved Auth-only maintenance credential is unavailable.",
  );
  expect(mocks.acquire).not.toHaveBeenCalled();
  expect(f.consume).not.toHaveBeenCalled();
});

it("withholds an acquired credential when authority is revoked before private consumption", async () => {
  const f = fixture();
  mocks.acquire.mockImplementation(async () => {
    f.input.assertCurrent.mockRejectedValue(new Error("lease lost"));
  });
  await expect(
    createNativeTargetAuthOnlyMaintenanceReader(f.input).withMaintenanceCredential(f.consume),
  ).rejects.toThrow();
  expect(mocks.acquire).toHaveBeenCalledOnce();
  expect(f.consume).not.toHaveBeenCalled();
});

it("keeps the resource plan and execution binding immutable across awaits", async () => {
  const f = fixture();
  f.input.assertCurrentOwner.mockImplementationOnce(async () => {
    f.input.approvedResourcePlanBytes.fill(32);
    f.input.plan.appRole = "other";
    f.input.context.target.projectId = "prj-other";
    f.input.execution.fenceGeneration = 99;
    f.input.approval.callId = "other";
  });
  await expect(
    createNativeTargetAuthOnlyMaintenanceReader(f.input).withMaintenanceCredential(f.consume),
  ).resolves.toBe("consumed-privately");
  expect(f.input.assertCurrent).toHaveBeenCalledWith(expect.objectContaining({ execution }));
});

it.each(["inactive-installation", "foreign-native-store", "app-as-anchor"] as const)(
  "preserves owner/store rejection for %s",
  async (kind) => {
    const f = fixture();
    if (kind === "inactive-installation") {
      f.credential.binding.active = false;
    }
    if (kind === "foreign-native-store") {
      mocks.store.mockResolvedValue({
        resourceId: "foreign-store",
        neonProjectId: "pilot-project",
      });
    }
    if (kind === "app-as-anchor") {
      mocks.access.mockResolvedValue({
        status: "ready",
        project: { id: target.projectId },
        scope: { id: target.scopeId, type: "team" },
      });
    }
    await expect(
      createNativeTargetAuthOnlyMaintenanceReader(f.input).withMaintenanceCredential(f.consume),
    ).rejects.toThrow();
    expect(mocks.acquire).not.toHaveBeenCalled();
    expect(f.consume).not.toHaveBeenCalled();
  },
);
