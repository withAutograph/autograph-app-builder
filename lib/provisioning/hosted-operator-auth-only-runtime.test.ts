import { describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";

import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import { createNativeTargetAuthOnlyRuntime } from "./hosted-operator-auth-only-runtime";
import type { NativeTargetAuthOnlyRuntimeStore } from "./hosted-operator-auth-only-runtime";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import { planNativeTargetAuthOnly } from "./native-target-auth-only-planner";
import { hostedOperatorSourceConfigurationSchema } from "./hosted-operator-source-configuration-schema";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- The typed partial mock retains the resource profile module's other exports.
import type * as ResourceProfileModule from "./native-target-resource-profile";

const resolveProfileMock = vi.hoisted(() =>
  vi.fn<typeof ResourceProfileModule.resolveNativeTargetResourceProfile>(),
);
// oxlint-disable-next-line anti-slop/no-module-mocking -- Isolate deployment-owned profile lookup; the real runtime compares its exact authority digest and roles before leasing.
vi.mock("./native-target-resource-profile", async (original) => ({
  ...(await original<typeof ResourceProfileModule>()),
  resolveNativeTargetResourceProfile: resolveProfileMock,
}));

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_fixture",
  workspaceId: "workspace_fixture",
};
const description = {
  app: { id: "signup-reset-pilot", routes: ["/"], workspacePath: "apps/signup-reset-pilot" },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: {
    browser: null,
    check: { task: "mise run app:check signup-reset-pilot" },
    test: null,
  },
  version: 1,
};
const source = {
  branch: "main",
  changeSetDigest: "c".repeat(64),
  gitSha: "d".repeat(40),
  gitTree: "e".repeat(40),
  repositoryId: "repo_fixture",
  reviewDigest: "f".repeat(64),
};
const authDatabase = {
  database: "auth_identity",
  migratorRole: "auth_migrator",
  resourceId: "isolated-auth-resource",
  runtimeRole: "auth_runtime",
};
const workload = {
  audience: "https://vercel.com/fixture",
  environment: "preview",
  issuer: "https://oidc.vercel.com/fixture",
  ownerId: "team_fixture",
  projectId: "operator-fixture",
};
const selectedProfile = hostedOperatorSourceConfigurationSchema.parse({
  applications: {},
  authDatabase,
  authOnlyApplications: { "signup-reset-pilot": { accessRoles: ["pilot_user"] } },
  builderCallbackOrigin: "https://builder.example",
  catalogAppIds: ["signup-reset-pilot"],
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "preview-fixture",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    gitSha: "8".repeat(40),
    projectId: "gateway-fixture",
    protectedApplicationIds: ["signup-reset-pilot"],
    publicOrigin: "https://apps.example",
    repoId: "gateway-repo",
    workload: { ...workload, projectId: "gateway-fixture", subject: "gateway" },
  },
  nativeNeon: {
    configuration: {
      connector: "neon-owned",
      nativeStore: {
        configurationId: "icfg-neon",
        resourceId: "store-neon",
        sourceProjectId: "prj-anchor",
      },
      operator: workload,
    },
    scope: {
      branchId: "pilot-branch",
      endpointId: "isolated-endpoint",
      hostname: "auth-preview.neon.tech",
      maintenanceDatabase: "neondb",
      maintenanceRole: "bootstrap_owner",
      projectId: "pilot-project",
    },
  },
  operator: {
    deploymentId: "dpl-operator",
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator-fixture",
  },
  sandbox: {
    accessWorker: {
      executablePath: "/fixture/access",
      id: "access-worker",
      operationScope: "generated-app-access-v1",
      sha256: "7".repeat(64),
      subcommand: "protected-generated-app-access",
    },
    authProposal: {
      executablePath: "/fixture/proposal",
      id: "auth-proposal",
      sha256: "6".repeat(64),
    },
    authWorker: {
      executablePath: "/fixture/auth",
      id: "auth-worker",
      operationScope: "auth-protected-schema-v1",
      sha256: "3".repeat(64),
      subcommand: "auth-protected-schema",
    },
    image: "fixture",
    projectId: "operator-fixture",
    resourcesWorker: {
      executablePath: "/fixture/resources",
      id: "neon-resource-bootstrap-v1",
      operationScope: "neon-resource-bootstrap-v1",
      sha256: "5".repeat(64),
      subcommand: "neon-resource-bootstrap",
    },
    teamId: "team_fixture",
    workers: {},
  },
  teamId: "team_fixture",
  workloadPolicy: { ...workload, subject: "operator" },
});
const authorityBinding = {
  authDatabase,
  gateway: {
    authBrowserOrigin: selectedProfile.gateway.authBrowserOrigin,
    branch: selectedProfile.gateway.branch,
    environment: selectedProfile.gateway.environment,
    gatewayOrigin: selectedProfile.gateway.gatewayOrigin,
    projectId: selectedProfile.gateway.projectId,
    publicOrigin: selectedProfile.gateway.publicOrigin,
    workload: selectedProfile.gateway.workload,
  },
  nativeNeon: selectedProfile.nativeNeon,
  operator: {
    environment: selectedProfile.operator.environment,
    origin: selectedProfile.operator.origin,
    projectId: selectedProfile.operator.projectId,
  },
};
const plan = planNativeTargetAuthOnly({
  authAuthorityBinding: authorityBinding,
  authSchema: {
    artifactRef: "artifact_fixture",
    installer: { reference: "auth-worker", sha256: "3".repeat(64) },
    planDigest: "1".repeat(64),
    targetDigest: "2".repeat(64),
  },
  capturedDescription: description,
  configuredAppRoles: ["pilot_user"],
  owner: {
    adapterGeneration: 1,
    adapterSessionId: "adapter_original",
    authority,
    publicSessionId: "public_original",
  },
  proposal: {
    appId: "signup-reset-pilot",
    appRole: "pilot_user",
    appSpecDigest: "a".repeat(64),
    authProfileId: "signup-reset-pilot-auth-preview",
    branch: "main",
    project: {
      installationId: "installation_fixture",
      name: "signup-reset-pilot",
      teamId: "team_fixture",
    },
  },
  publishedSource: source,
  selectedPhysicalEndpointId: "isolated-endpoint",
  selectedProfile: {
    appId: "signup-reset-pilot",
    authority,
    configuration: { authDatabase },
    id: "signup-reset-pilot-auth-preview",
  },
  sharedAuthResourceId: "shared-auth-resource",
  sharedPhysicalEndpointId: "shared-endpoint",
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const sourceDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, source);
const approval = {
  callId: "call_fixture",
  observedAt: "2026-11-06T12:00:00.000Z",
  outcome: "approved" as const,
  planDigest,
  publicSessionId: plan.origin.publicSessionId,
  requestId: "approval_fixture",
  responderPrincipalId: authority.ownerUserId,
  sourceDigest,
};
const context: OperatorArtifactContext = {
  authority,
  target: { appId: plan.appId, sessionId: plan.origin.publicSessionId },
};
const authSchema = {
  artifactRef: "artifact_fixture",
  planDigest: "1".repeat(64),
  targetDigest: "2".repeat(64),
};
const initialState = {
  kind: "native-target-auth-only-runtime" as const,
  plan,
  planDigest,
  source,
  stage: "planned" as const,
  version: 1 as const,
};

const makeStore = (): NativeTargetAuthOnlyRuntimeStore => {
  let row: Awaited<ReturnType<NativeTargetAuthOnlyRuntimeStore["read"]>>;
  return {
    compareAndSet: (_key, expectedRevision, state) => {
      if (row?.revision !== expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS conflicts resolve an absent row; resolve() would infer void outside the store contract.
        return Promise.resolve(undefined);
      }
      row = { revision: expectedRevision + 1, state };
      return Promise.resolve(row);
    },
    read: () => Promise.resolve(row),
    write: (_key, expectedRevision, state) => {
      if (expectedRevision === undefined ? row !== undefined : row?.revision !== expectedRevision) {
        return Promise.reject(new Error("native_target_auth_only_runtime_conflict"));
      }
      row = { revision: (row?.revision ?? 0) + 1, state };
      return Promise.resolve(row);
    },
  };
};

const makeRuntime = (
  overrides: {
    prepareAuthSchema?: (input: {
      assertCurrent: () => Promise<void>;
    }) => Promise<{ authSchema: typeof authSchema; readiness: string }>;
    reconcileAuthSchema?: (input: {
      attemptId: string;
    }) => Promise<
      | { status: "prepared"; authSchema: typeof authSchema; readiness: string }
      | { status: "not-applied" }
      | { status: "uncertain" }
    >;
    now?: () => Date;
  } = {},
) => {
  const store = makeStore();
  const now = overrides.now ?? (() => new Date("2026-11-06T12:00:00.000Z"));
  const prepareAuthSchema = vi.fn(
    overrides.prepareAuthSchema ??
      (() => Promise.resolve({ authSchema, readiness: "auth_schema_ready" })),
  );
  const reconcileAuthSchema = vi.fn(
    overrides.reconcileAuthSchema ?? (() => Promise.resolve({ status: "uncertain" as const })),
  );
  resolveProfileMock.mockReturnValue(selectedProfile);
  const runtime = createNativeTargetAuthOnlyRuntime({
    assertCurrentOwner: () => Promise.resolve(),
    configuration: selectedProfile,
    database: drizzle.mock(),
    environment: {},
    leaseMs: 1000,
    now,
    prepareAuthSchema: async (input) =>
      await prepareAuthSchema({ assertCurrent: input.assertCurrent }),
    readApproval: ({ effectDigest }) =>
      Promise.resolve({ ...approval, sourceDigest: effectDigest }),
    readAuthSchemaSelection: () => Promise.resolve(plan.authSchema),
    readCapturedDescription: () => Promise.resolve(description),
    readPublishedSource: () => Promise.resolve(source),
    reconcileAuthSchema: async (input) => await reconcileAuthSchema({ attemptId: input.attemptId }),
    store,
  });
  return { now, prepareAuthSchema, reconcileAuthSchema, runtime, store };
};

describe("Auth-only schema runtime", () => {
  it("requires a private exact-source approval before claiming a worker lease", async () => {
    const { runtime, store, prepareAuthSchema } = makeRuntime();
    await store.write(
      { appId: plan.appId, authority, sessionId: plan.origin.publicSessionId },
      undefined,
      initialState,
    );
    resolveProfileMock.mockReturnValue({
      ...selectedProfile,
      authOnlyApplications: { "signup-reset-pilot": { accessRoles: ["different_role"] } },
    });
    await expect(runtime.prepare(context, plan, planDigest)).rejects.toThrow(
      "native_target_auth_only_resource_mismatch",
    );
    expect(prepareAuthSchema).not.toHaveBeenCalled();
  });

  it("records an uncertain attempt and reconciles it as applied without replay", async () => {
    let failOnce = true;
    const { runtime, store, prepareAuthSchema, reconcileAuthSchema } = makeRuntime({
      prepareAuthSchema: () => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("transport_lost_after_dispatch"));
        }
        return Promise.resolve({ authSchema, readiness: "auth_schema_ready" });
      },
      reconcileAuthSchema: () =>
        Promise.resolve({
          authSchema,
          readiness: "auth_schema_ready",
          status: "prepared",
        }),
    });
    const key = { appId: plan.appId, authority, sessionId: plan.origin.publicSessionId };
    await store.write(key, undefined, initialState);
    await expect(runtime.prepare(context, plan, planDigest)).rejects.toThrow(
      "transport_lost_after_dispatch",
    );
    const interrupted = await store.read(key);
    expect(interrupted?.state.stage).toBe("unknown");
    const recovered = await runtime.prepare(context, plan, planDigest);
    expect(recovered.stage).toBe("prepared");
    expect(prepareAuthSchema).toHaveBeenCalledTimes(1);
    expect(reconcileAuthSchema).toHaveBeenCalledTimes(1);
  });

  it("retries only after reconciliation proves the prior attempt was not applied", async () => {
    let failOnce = true;
    const { runtime, store, prepareAuthSchema, reconcileAuthSchema } = makeRuntime({
      prepareAuthSchema: () => {
        if (failOnce) {
          failOnce = false;
          return Promise.reject(new Error("transport_lost_before_result"));
        }
        return Promise.resolve({ authSchema, readiness: "auth_schema_ready" });
      },
      reconcileAuthSchema: () => Promise.resolve({ status: "not-applied" }),
    });
    const key = { appId: plan.appId, authority, sessionId: plan.origin.publicSessionId };
    await store.write(key, undefined, initialState);
    await expect(runtime.prepare(context, plan, planDigest)).rejects.toThrow(
      "transport_lost_before_result",
    );
    const recovered = await runtime.prepare(context, plan, planDigest);
    expect(recovered.stage).toBe("prepared");
    expect(reconcileAuthSchema).toHaveBeenCalledTimes(1);
    expect(prepareAuthSchema).toHaveBeenCalledTimes(2);
  });

  it("rejects a concurrent continuation while the worker attempt lease is live", async () => {
    let nestedPrepare: () => ReturnType<
      ReturnType<typeof createNativeTargetAuthOnlyRuntime>["prepare"]
    > = () => Promise.reject(new Error("Concurrent test continuation is not initialized"));
    const { runtime, store, prepareAuthSchema, reconcileAuthSchema } = makeRuntime({
      prepareAuthSchema: async () => {
        await expect(nestedPrepare()).rejects.toThrow("native_target_auth_only_busy");
        return { authSchema, readiness: "auth_schema_ready" };
      },
    });
    const key = { appId: plan.appId, authority, sessionId: plan.origin.publicSessionId };
    nestedPrepare = async () => await runtime.prepare(context, plan, planDigest);
    await store.write(key, undefined, initialState);
    await expect(runtime.prepare(context, plan, planDigest)).resolves.toMatchObject({
      stage: "prepared",
    });
    expect(prepareAuthSchema).toHaveBeenCalledOnce();
    expect(reconcileAuthSchema).not.toHaveBeenCalled();
  });
});
