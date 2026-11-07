import { describe, expect, it, vi } from "vitest";

const resolveProfileMock = vi.hoisted(() => vi.fn());
vi.mock("./native-target-resource-profile", () => ({
  resolveNativeTargetResourceProfile: resolveProfileMock,
}));

import type { OperatorArtifactContext } from "./hosted-operator-artifact-store";
import { createNativeTargetAuthOnlyRuntime } from "./hosted-operator-auth-only-runtime";
import type { NativeTargetAuthOnlyRuntimeStore } from "./hosted-operator-auth-only-runtime";
import {
  nativeTargetAuthOnlyPlanDigest,
  nativeTargetAuthOnlySchemaEffectDigest,
} from "./native-target-auth-only-plan-schema";
import {
  nativeTargetAuthOnlyAuthorityDigest,
  planNativeTargetAuthOnly,
} from "./native-target-auth-only-planner";
import { nativeTargetRequiredProjectProtection } from "./native-target-onboarding-plan-schema";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration-schema";

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
const selectedProfile = {
  authDatabase,
  authOnlyApplications: { "signup-reset-pilot": { accessRoles: ["pilot_user"] } },
  gateway: {
    authBrowserOrigin: "https://auth.example",
    branch: "preview-fixture",
    environment: "preview",
    gatewayOrigin: "https://gateway.example",
    projectId: "gateway-fixture",
    publicOrigin: "https://apps.example",
    workload: { projectId: "gateway-fixture" },
  },
  nativeNeon: { scope: { endpointId: "isolated-endpoint", hostname: "auth-preview.neon.tech" } },
  operator: {
    environment: "preview",
    origin: "https://operator.example",
    projectId: "operator-fixture",
  },
};
const authorityBinding = {
  authDatabase,
  gateway: selectedProfile.gateway,
  nativeNeon: selectedProfile.nativeNeon,
  operator: selectedProfile.operator,
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
    compareAndSet: async (_key, expectedRevision, state) => {
      if (row?.revision !== expectedRevision) return undefined;
      row = { revision: expectedRevision + 1, state };
      return row;
    },
    read: async () => row,
    write: async (_key, expectedRevision, state) => {
      if (expectedRevision === undefined ? row !== undefined : row?.revision !== expectedRevision) {
        throw new Error("native_target_auth_only_runtime_conflict");
      }
      row = { revision: (row?.revision ?? 0) + 1, state };
      return row;
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
    overrides.prepareAuthSchema ?? (async () => ({ authSchema, readiness: "auth_schema_ready" })),
  );
  const reconcileAuthSchema = vi.fn(
    overrides.reconcileAuthSchema ?? (async () => ({ status: "uncertain" as const })),
  );
  resolveProfileMock.mockReturnValue(selectedProfile);
  const runtime = createNativeTargetAuthOnlyRuntime({
    assertCurrentOwner: async () => undefined,
    configuration: { applications: {} } as HostedOperatorSourceConfiguration,
    database: {} as never,
    environment: {},
    leaseMs: 1_000,
    now,
    prepareAuthSchema: async (input) =>
      await prepareAuthSchema({ assertCurrent: input.assertCurrent }),
    readApproval: async ({ effectDigest }) => ({ ...approval, sourceDigest: effectDigest }),
    readAuthSchemaSelection: async () => plan.authSchema,
    readCapturedDescription: async () => description,
    readPublishedSource: async () => source,
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
      prepareAuthSchema: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transport_lost_after_dispatch");
        }
        return { authSchema, readiness: "auth_schema_ready" };
      },
      reconcileAuthSchema: async () => ({
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
    expect((await store.read(key))?.state.stage).toBe("unknown");
    const recovered = await runtime.prepare(context, plan, planDigest);
    expect(recovered.stage).toBe("prepared");
    expect(prepareAuthSchema).toHaveBeenCalledTimes(1);
    expect(reconcileAuthSchema).toHaveBeenCalledTimes(1);
  });

  it("retries only after reconciliation proves the prior attempt was not applied", async () => {
    let failOnce = true;
    const { runtime, store, prepareAuthSchema, reconcileAuthSchema } = makeRuntime({
      prepareAuthSchema: async () => {
        if (failOnce) {
          failOnce = false;
          throw new Error("transport_lost_before_result");
        }
        return { authSchema, readiness: "auth_schema_ready" };
      },
      reconcileAuthSchema: async () => ({ status: "not-applied" }),
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
    let nestedPrepare: (() => Promise<unknown>) | undefined;
    const { runtime, store, prepareAuthSchema, reconcileAuthSchema } = makeRuntime({
      prepareAuthSchema: async () => {
        await expect(nestedPrepare?.()).rejects.toThrow("native_target_auth_only_busy");
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
