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
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  workspaceId: "workspace_fixture",
  ownerUserId: "owner_fixture",
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
  resourceId: "isolated-auth-resource",
  database: "auth_identity",
  migratorRole: "auth_migrator",
  runtimeRole: "auth_runtime",
};
const selectedProfile = {
  authDatabase,
  authOnlyApplications: { "signup-reset-pilot": { accessRoles: ["pilot_user"] } },
  nativeNeon: { scope: { endpointId: "isolated-endpoint", hostname: "auth-preview.neon.tech" } },
  gateway: {
    projectId: "gateway-fixture",
    environment: "preview",
    branch: "preview-fixture",
    authBrowserOrigin: "https://auth.example",
    gatewayOrigin: "https://gateway.example",
    publicOrigin: "https://apps.example",
    workload: { projectId: "gateway-fixture" },
  },
  operator: {
    projectId: "operator-fixture",
    environment: "preview",
    origin: "https://operator.example",
  },
};
const authorityBinding = {
  authDatabase,
  nativeNeon: selectedProfile.nativeNeon,
  gateway: selectedProfile.gateway,
  operator: selectedProfile.operator,
};
const plan = planNativeTargetAuthOnly({
  owner: {
    authority,
    publicSessionId: "public_original",
    adapterSessionId: "adapter_original",
    adapterGeneration: 1,
  },
  proposal: {
    appId: "signup-reset-pilot",
    authProfileId: "signup-reset-pilot-auth-preview",
    project: {
      name: "signup-reset-pilot",
      teamId: "team_fixture",
      installationId: "installation_fixture",
    },
    branch: "main",
    appSpecDigest: "a".repeat(64),
    appRole: "pilot_user",
  },
  capturedDescription: description,
  selectedProfile: {
    id: "signup-reset-pilot-auth-preview",
    appId: "signup-reset-pilot",
    authority,
    configuration: { authDatabase },
  },
  sharedAuthResourceId: "shared-auth-resource",
  sharedPhysicalEndpointId: "shared-endpoint",
  selectedPhysicalEndpointId: "isolated-endpoint",
  authAuthorityBinding: authorityBinding,
  configuredAppRoles: ["pilot_user"],
  publishedSource: source,
  authSchema: {
    artifactRef: "artifact_fixture",
    planDigest: "1".repeat(64),
    targetDigest: "2".repeat(64),
    installer: { reference: "auth-worker", sha256: "3".repeat(64) },
  },
});
const planDigest = nativeTargetAuthOnlyPlanDigest(plan);
const sourceDigest = nativeTargetAuthOnlySchemaEffectDigest(plan, source);
const approval = {
  requestId: "approval_fixture",
  callId: "call_fixture",
  planDigest,
  sourceDigest,
  responderPrincipalId: authority.ownerUserId,
  publicSessionId: plan.origin.publicSessionId,
  outcome: "approved" as const,
  observedAt: "2026-11-06T12:00:00.000Z",
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
  version: 1 as const,
  stage: "planned" as const,
  plan,
  planDigest,
  source,
};

const makeStore = (): NativeTargetAuthOnlyRuntimeStore => {
  let row: Awaited<ReturnType<NativeTargetAuthOnlyRuntimeStore["read"]>>;
  return {
    read: async () => row,
    write: async (_key, expectedRevision, state) => {
      if (expectedRevision === undefined ? row !== undefined : row?.revision !== expectedRevision) {
        throw new Error("native_target_auth_only_runtime_conflict");
      }
      row = { revision: (row?.revision ?? 0) + 1, state };
      return row;
    },
    compareAndSet: async (_key, expectedRevision, state) => {
      if (row?.revision !== expectedRevision) return undefined;
      row = { revision: expectedRevision + 1, state };
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
    database: {} as never,
    store,
    configuration: { applications: {} } as HostedOperatorSourceConfiguration,
    environment: {},
    assertCurrentOwner: async () => undefined,
    readPublishedSource: async () => source,
    readCapturedDescription: async () => description,
    readAuthSchemaSelection: async () => plan.authSchema,
    readApproval: async ({ effectDigest }) => ({ ...approval, sourceDigest: effectDigest }),
    prepareAuthSchema: async (input) =>
      await prepareAuthSchema({ assertCurrent: input.assertCurrent }),
    reconcileAuthSchema: async (input) => await reconcileAuthSchema({ attemptId: input.attemptId }),
    now,
    leaseMs: 1_000,
  });
  return { runtime, store, prepareAuthSchema, reconcileAuthSchema, now };
};

describe("Auth-only schema runtime", () => {
  it("requires a private exact-source approval before claiming a worker lease", async () => {
    const { runtime, store, prepareAuthSchema } = makeRuntime();
    await store.write(
      { authority, appId: plan.appId, sessionId: plan.origin.publicSessionId },
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
        status: "prepared",
        authSchema,
        readiness: "auth_schema_ready",
      }),
    });
    const key = { authority, appId: plan.appId, sessionId: plan.origin.publicSessionId };
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
    const key = { authority, appId: plan.appId, sessionId: plan.origin.publicSessionId };
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
    const key = { authority, appId: plan.appId, sessionId: plan.origin.publicSessionId };
    nestedPrepare = async () => await runtime.prepare(context, plan, planDigest);
    await store.write(key, undefined, initialState);
    await expect(runtime.prepare(context, plan, planDigest)).resolves.toMatchObject({
      stage: "prepared",
    });
    expect(prepareAuthSchema).toHaveBeenCalledOnce();
    expect(reconcileAuthSchema).not.toHaveBeenCalled();
  });
});
