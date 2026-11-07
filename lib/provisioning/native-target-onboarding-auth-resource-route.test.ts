/* oxlint-disable eslint/require-await -- Focused route ports do not call providers. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { operatorOwnerContextSchema } from "./hosted-operator-contract";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import { planNativeTargetAuthOnly } from "./native-target-auth-only-planner";
import { nativeTargetAuthOnlyCredentialOperationRef } from "./native-target-auth-only-credential-store";
import { nativeTargetAuthOnlyResourcePlanDigest } from "./native-target-auth-only-resource-plan-store";
import {
  buildNativeTargetAuthOnlyResourcePlanBytes,
  createNativeTargetOnboardingDeployment,
} from "./native-target-onboarding-deployment";
import type { NativeTargetAuthOnlyRuntimeStore } from "./hosted-operator-auth-only-runtime";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { NativeTargetRequest } from "./native-target-onboarding-transport";

const mock = vi.hoisted(() => ({
  findReference: vi.fn(),
  genericService: vi.fn(),
  readArtifact: vi.fn(),
  readCredentials: vi.fn(),
  readDescription: vi.fn(),
  readDispatch: vi.fn(),
  readPlan: vi.fn(),
  readPublishedSource: vi.fn(),
  readResource: vi.fn(),
  readResourceApproval: vi.fn(),
  readSchemaApproval: vi.fn(),
  readSecrets: vi.fn(),
  resolveProfile: vi.fn(),
  resolveRegistered: vi.fn(),
  runResources: vi.fn(),
  runSchema: vi.fn(),
  runtimeStore: vi.fn(),
  seal: vi.fn(),
  verifyReadiness: vi.fn(),
}));

vi.mock("./native-target-auth-only-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-target-auth-only-dispatch")>()),
  createPostgresNativeTargetAuthOnlyDispatchStore: () => ({ read: mock.readDispatch }),
}));
vi.mock("./native-target-auth-only-plan-store", () => ({
  createNativeTargetAuthOnlyPlanStore: () => ({ read: mock.readPlan }),
}));
vi.mock("./native-target-auth-only-resource-plan-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-target-auth-only-resource-plan-store")>()),
  createNativeTargetAuthOnlyResourcePlanStore: () => ({ read: mock.readResource }),
}));
vi.mock("../eve/private-native-target-auth-only-resource-approval", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../eve/private-native-target-auth-only-resource-approval")
  >()),
  readPrivateNativeTargetAuthOnlyResourceApproval: mock.readResourceApproval,
}));
vi.mock("../eve/private-native-target-auth-only-approval", () => ({
  readPrivateNativeTargetAuthOnlyApproval: mock.readSchemaApproval,
}));
vi.mock("./native-target-configuration-resolver", () => ({
  resolveNativeTargetAuthOnlyRegistration: mock.resolveRegistered,
}));
vi.mock("./native-target-resource-profile", () => ({
  resolveNativeTargetResourceProfile: mock.resolveProfile,
}));
vi.mock("./captured-app-description", () => ({
  createCapturedAppDescriptionStore: () => ({ read: mock.readDescription }),
}));
vi.mock("./hosted-operator-auth-only-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosted-operator-auth-only-runtime")>()),
  createPostgresNativeTargetAuthOnlyRuntimeStore: mock.runtimeStore,
  readNativeTargetAuthOnlyPublishedSource: mock.readPublishedSource,
}));
vi.mock("./hosted-operator-artifacts", () => ({
  createOperatorArtifactPublication: () => ({ readAuthPlan: mock.readArtifact }),
}));
vi.mock("./native-target-auth-only-maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-target-auth-only-maintenance")>()),
  createNativeTargetAuthOnlyMaintenanceReader: () => ({
    withMaintenanceCredential: async (
      consume: (material: { maintenanceUrl: string }) => Promise<unknown>,
    ) => consume({ maintenanceUrl: "private-maintenance-url" }),
  }),
}));
vi.mock("./native-target-auth-only-credential-store", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./native-target-auth-only-credential-store")>()),
  createNativeTargetAuthOnlyCredentialCustody: () => ({
    findReference: mock.findReference,
    seal: mock.seal,
    readSecrets: mock.readSecrets,
    read: mock.readCredentials,
  }),
  nativeTargetAuthOnlyCredentialContextForPlan: () => ({}),
}));
vi.mock("./hosted-operator-auth-readiness", () => ({
  createHostedOperatorAuthReadiness: () => ({ verify: mock.verifyReadiness }),
}));
vi.mock("./hosted-operator-sandbox-launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./hosted-operator-sandbox-launcher")>()),
  runAuthResourceFileSpool: mock.runResources,
  runAuthSchemaFileSpool: mock.runSchema,
}));
vi.mock("../integrations/vercel-installation", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../integrations/vercel-installation")>()),
  readVercelTokenKeyringEnvironment: () => ({}),
}));
vi.mock("./native-target-onboarding-service", () => ({
  createNativeTargetOnboardingService: () => mock.genericService,
}));

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-fixture",
  workspaceId: "workspace-fixture",
};
const historyOwner = operatorOwnerContextSchema.parse({
  adapterGeneration: 1,
  adapterSessionId: "saved-adapter",
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: "saved-session",
});
const appId = "signup-pilot";
const teamId = "team-fixture";
const description = {
  app: { id: appId, routes: ["/"], workspacePath: `apps/${appId}` },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: { browser: null, check: { task: "mise run app:check signup-pilot" }, test: null },
  version: 1,
};
const source = {
  branch: "pilot",
  changeSetDigest: "c".repeat(64),
  gitSha: "d".repeat(40),
  gitTree: "e".repeat(40),
  repositoryId: "repo-fixture",
  reviewDigest: "f".repeat(64),
};
const authDatabase = {
  database: "pilot_auth",
  migratorRole: "pilot_migrator",
  resourceId: "isolated-auth",
  runtimeRole: "pilot_runtime",
};
const authSchema = {
  artifactRef: "auth-artifact",
  installer: { reference: "auth-worker", sha256: "4".repeat(64) },
  planDigest: "2".repeat(64),
  targetDigest: "3".repeat(64),
};
const registration = {
  branch: source.branch,
  ownerUserId: authority.ownerUserId,
  projectId: "prj-created",
  sessionId: historyOwner.sessionId,
};
const profile = {
  authDatabase,
  authOnlyApplications: { [appId]: { accessRoles: ["pilot_user"], registration } },
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "preview-fixture",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    projectId: "gateway-fixture",
    publicOrigin: "https://apps.example",
    workload: { projectId: "gateway-fixture" },
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
        audience: "https://vercel.com/fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/fixture",
        ownerId: teamId,
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
    projectId: "operator-fixture",
  },
  sandbox: {
    authWorker: { id: authSchema.installer.reference, sha256: authSchema.installer.sha256 },
    resourcesWorker: { id: "neon-resource-bootstrap-v1", sha256: "5".repeat(64) },
  },
  teamId,
};
const selected = profile as unknown as HostedOperatorSourceConfiguration;
const plan = planNativeTargetAuthOnly({
  authAuthorityBinding: {
    authDatabase,
    gateway: profile.gateway,
    nativeNeon: profile.nativeNeon,
    operator: profile.operator,
  },
  authSchema,
  capturedDescription: description,
  configuredAppRoles: ["pilot_user"],
  owner: {
    adapterGeneration: 1,
    adapterSessionId: historyOwner.adapterSessionId,
    authority,
    publicSessionId: historyOwner.sessionId,
  },
  proposal: {
    appId,
    appRole: "pilot_user",
    appSpecDigest: "a".repeat(64),
    authProfileId: "pilot-auth",
    branch: source.branch,
    project: { installationId: "install-fixture", name: appId, teamId },
  },
  publishedSource: source,
  selectedPhysicalEndpointId: profile.nativeNeon.scope.endpointId,
  selectedProfile: { appId, authority, configuration: { authDatabase }, id: "pilot-auth" },
  sharedAuthResourceId: "shared-auth",
  sharedPhysicalEndpointId: "shared-endpoint",
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const operationRef = nativeTargetAuthOnlyCredentialOperationRef(plan);
const resourceBytes = buildNativeTargetAuthOnlyResourcePlanBytes({ plan, registration, selected });
const resourcePlanDigest = nativeTargetAuthOnlyResourcePlanDigest(resourceBytes);
const resourcePlan = JSON.parse(resourceBytes.toString("utf-8"));
const schemaApproval = {
  callId: "original-schema-call",
  observedAt: "2026-11-06T12:00:00.000Z",
  outcome: "approved" as const,
  planDigest,
  publicSessionId: historyOwner.sessionId,
  requestId: "schema-request",
  responderPrincipalId: authority.ownerUserId,
  sourceDigest: nativeTargetAuthOnlySchemaEffectDigest(plan, source),
};
const resourceApproval = {
  ...schemaApproval,
  callId: "original-resource-call",
  requestId: "resource-request",
  sourceDigest: resourcePlanDigest,
};
const common = {
  adapterSessionId: historyOwner.adapterSessionId,
  callId: "different-retry-call",
  ownerContext: historyOwner,
};
const resourceInput = { appId, operationRef, planDigest, resourcePlan, resourcePlanDigest };
const verifyWorkload = vi.fn();
const assertCanonicalAppOwner = vi.fn();

interface JournalRow {
  requestId: string;
  revision: number;
  record: unknown;
  state: string;
}
const journalRows = new Map<string, JournalRow>();
const rowId = (where: SQL) => String(new PgDialect().sqlToQuery(where).params[4]);
const deploy = () =>
  createNativeTargetOnboardingDeployment({
    builderOrigin: "https://builder.example",
    configuration: { applications: {} } as HostedOperatorSourceConfiguration,
    database: {
      select: () => ({
        from: () => ({
          where: (where: SQL) => ({
            limit: async () => {
              const row = journalRows.get(rowId(where));
              return row === undefined ? [] : [row];
            },
          }),
        }),
      }),
      insert: () => ({
        values: (row: JournalRow) => ({
          onConflictDoNothing: async () => {
            if (!journalRows.has(row.requestId)) journalRows.set(row.requestId, row);
          },
        }),
      }),
      update: () => ({
        set: (update: Partial<JournalRow>) => ({
          where: (where: SQL) => ({
            returning: async () => {
              const row = journalRows.get(rowId(where));
              if (row === undefined) return [];
              const next = { ...row, ...update };
              journalRows.set(row.requestId, next);
              return [next];
            },
          }),
        }),
      }),
    } as never,
    environment: {},
    owner: {
      assertCanonicalAppOwner,
      assertNoStandardBuilderDestination: async () => {},
      verifyWorkload,
    },
  });

const request = async (input: NativeTargetRequest) =>
  await deploy()(
    new Request("https://operator.example/v1/native-target", {
      headers: { authorization: "Bearer workload-fixture" },
      method: "POST",
    }),
    input,
  );

beforeEach(() => {
  vi.resetAllMocks();
  journalRows.clear();
  mock.readDispatch.mockResolvedValue({
    state: {
      approval: schemaApproval,
      plan,
      planDigest,
      projectId: registration.projectId,
      stage: "created",
    },
  });
  mock.readPlan.mockResolvedValue(plan);
  mock.readResource.mockResolvedValue({ bytes: resourceBytes, plan: resourcePlan });
  mock.resolveRegistered.mockResolvedValue(selected);
  mock.resolveProfile.mockReturnValue(selected);
  mock.readResourceApproval.mockResolvedValue(resourceApproval);
  mock.readSchemaApproval.mockResolvedValue(schemaApproval);
  mock.readDescription.mockResolvedValue(description);
  mock.readPublishedSource.mockResolvedValue(source);
  mock.readArtifact.mockResolvedValue({
    artifactRef: authSchema.artifactRef,
    content: Buffer.from(
      JSON.stringify({
        schemaPlan: { planDigest: authSchema.planDigest, targetDigest: authSchema.targetDigest },
      }),
    ),
  });
  mock.findReference.mockResolvedValue(null);
  mock.seal.mockResolvedValue({ opaque: "sealed" });
  mock.readSecrets.mockResolvedValue({
    migratorPassword: "m".repeat(32),
    runtimePassword: "r".repeat(32),
  });
  mock.readCredentials.mockResolvedValue({ migrationUrl: "private-migration-url" });
  mock.verifyReadiness.mockResolvedValue({ catalogFingerprint: "catalog-readback" });
  let row: Awaited<ReturnType<NativeTargetAuthOnlyRuntimeStore["read"]>> = {
    revision: 1,
    state: {
      kind: "native-target-auth-only-runtime",
      plan,
      planDigest,
      source,
      stage: "planned",
      version: 1,
    },
  };
  const store: NativeTargetAuthOnlyRuntimeStore = {
    compareAndSet: async () => {
      throw new Error("unexpected CAS port");
    },
    read: async () => row,
    write: async (_key, revision, state) => {
      if (row?.revision !== revision) throw new Error("unexpected revision");
      return (row = { revision: (revision ?? 0) + 1, state });
    },
  };
  mock.runtimeStore.mockReturnValue(store);
});

describe("Auth-only resource normal deployment route", () => {
  it("reads the original project approval before retrying instead of falling through", async () => {
    const response = await request({
      ...common,
      action: "native-target-auth-only-approval-read",
      input: { appId, operationRef: planDigest, plan, planDigest },
    });
    expect(await response.json()).toEqual({ status: "approved" });
    expect(mock.readSchemaApproval).toHaveBeenCalledWith(
      expect.objectContaining({ callId: schemaApproval.callId }),
    );
    expect(mock.genericService).not.toHaveBeenCalled();
    expect(mock.runResources).not.toHaveBeenCalled();
  });

  it("reads an exact resource approval without acquiring credentials or dispatching workers", async () => {
    const response = await request({
      ...common,
      action: "native-target-auth-only-resource-approval-read",
      input: resourceInput,
    });
    expect(await response.json()).toEqual({ status: "approved" });
    expect(mock.readResourceApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        operationRef,
        resourcePlanBytes: resourceBytes,
        resourcePlanDigest,
      }),
    );
    expect(mock.runtimeStore).not.toHaveBeenCalled();
    expect(mock.runResources).not.toHaveBeenCalled();
  });

  it("rejects an unapproved resource before opening its runtime", async () => {
    mock.readResourceApproval.mockResolvedValue(null);
    await expect(
      request({ ...common, action: "native-target-auth-only-resources", input: resourceInput }),
    ).rejects.toThrow("authorization_required");
    expect(mock.runtimeStore).not.toHaveBeenCalled();
  });

  it("prepares just the registered Auth resource, applies the exact approved schema and verifies readiness", async () => {
    mock.runResources
      .mockResolvedValueOnce({ status: "absent" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: "applied" });
    const response = await request({
      ...common,
      action: "native-target-auth-only-resources",
      input: resourceInput,
    });
    expect(await response.json()).toEqual({
      authSchema: {
        artifactRef: authSchema.artifactRef,
        planDigest: authSchema.planDigest,
        targetDigest: authSchema.targetDigest,
      },
      readiness: "catalog-readback",
      resourcePlanDigest,
      status: "prepared",
    });
    expect(verifyWorkload).toHaveBeenCalled();
    expect(assertCanonicalAppOwner).toHaveBeenCalledWith(expect.objectContaining({ authority }));
    expect(mock.seal).toHaveBeenCalledOnce();
    expect(mock.runResources).toHaveBeenCalledTimes(3);
    expect(mock.runResources.mock.calls.map(([, call]) => call.readbackOnly === true)).toEqual([
      true,
      false,
      true,
    ]);
    expect(mock.runSchema).toHaveBeenCalledWith(
      selected.sandbox,
      expect.objectContaining({
        approvalDigest: resourcePlanDigest,
        approvedPlanBytes: resourceBytes,
        fenceGeneration: 3,
        operationRef,
        workerAttemptId: expect.any(String),
      }),
    );
    expect(mock.verifyReadiness).toHaveBeenCalledOnce();
    expect(mock.genericService).not.toHaveBeenCalled();
  });
  it("reconciles a lost schema response without replaying the workers or rotating credentials", async () => {
    mock.runResources.mockResolvedValue({ status: "applied" });
    const contextDigest = "6".repeat(64);
    mock.runSchema.mockImplementationOnce(async (_configuration, call) => {
      const checkpoint = await call.bindWorkerContext({ contextDigest });
      await checkpoint({
        contextDigest,
        effectId: "auth:apply-schema-plan",
        fenceGeneration: call.fenceGeneration,
        operationId: operationRef,
        receipt: { readbackSha256: "7".repeat(64), state: "applied" },
        resourceId: authDatabase.resourceId,
        sequence: 1,
        tenantId: null,
      });
      throw new Error("lost schema response");
    });
    const invocation = {
      ...common,
      action: "native-target-auth-only-resources" as const,
      input: resourceInput,
    };
    await expect(request(invocation)).rejects.toThrow("lost schema response");
    mock.findReference.mockResolvedValue({ opaque: "sealed" });
    const response = await request({ ...invocation, callId: "second-retry-call" });
    expect(await response.json()).toMatchObject({
      readiness: "catalog-readback",
      status: "prepared",
    });
    expect(mock.runResources).toHaveBeenCalledOnce();
    expect(mock.runSchema).toHaveBeenCalledOnce();
    expect(mock.seal).toHaveBeenCalledOnce();
    expect(mock.verifyReadiness).toHaveBeenCalledOnce();
    expect(mock.readResourceApproval).toHaveBeenLastCalledWith(
      expect.objectContaining({
        retainedApproval: resourceApproval,
      }),
    );
  });
});
