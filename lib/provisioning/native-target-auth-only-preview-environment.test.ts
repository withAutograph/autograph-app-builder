import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";

import { nativeTargetAuthOnlyTestPlan } from "./native-target-auth-only-plan-schema.test";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import { nativeTargetAuthOnlyDeliveryPlanSchema } from "./native-target-auth-only-delivery-plan";
import { nativeTargetAuthOnlyResourcePlanDigest } from "./native-target-auth-only-resource-plan-store";
import {
  composeNativeTargetAuthOnlyPreviewEnvironment,
  createNativeTargetAuthOnlyPreviewEnvironmentPort,
} from "./native-target-auth-only-preview-environment";

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
const plan = nativeTargetAuthOnlyTestPlan();
const target = {
  appId: plan.appId,
  branch: plan.branch,
  environment: "preview" as const,
  installationId: plan.project.installationId,
  projectId: "app-preview-project",
  scopeId: plan.project.teamId,
  scopeType: "team" as const,
  sessionId: plan.origin.publicSessionId,
};
const resourcePlan = {
  action: "prepare" as const,
  authDatabase: {
    database: plan.authResource.database,
    migratorRole: "auth_migrator",
    resourceId: plan.authResource.resourceId,
    runtimeRole: "auth_runtime",
  },
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  authSchema: plan.authSchema,
  bootstrap: {
    endpointId: plan.authResource.endpointId,
    maintenanceDatabase: "neondb",
    role: "neondb_owner",
  },
  effects: [{ id: "auth-resources", kind: "resources", resourceId: plan.authResource.resourceId }],
  nativeNeonConfiguration: {
    connector: "connector",
    nativeStore: {
      configurationId: "store-config",
      resourceId: "store-resource",
      sourceProjectId: "operator",
    },
    operator: {
      audience: "https://vercel.com/team",
      environment: "preview" as const,
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team_fixture",
      projectId: "operator",
    },
  },
  neon: {
    branchId: "auth-neon-branch",
    endpoint: plan.authResource.hostname,
    projectId: "auth-neon-project",
  },
  resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "a".repeat(64) },
  target,
  version: 1 as const,
};
const resourcePlanBytes = Buffer.from(JSON.stringify(resourcePlan));
const resourcePlanDigest = nativeTargetAuthOnlyResourcePlanDigest(resourcePlanBytes);
const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
  authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
  delivery: {
    action: "prepare",
    delivery: {
      branch: plan.branch,
      gitSha: plan.publishedSource.gitSha,
      projectId: target.projectId,
      projectSettings: plan.project.projectSettings,
      repoId: plan.publishedSource.repositoryId,
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    gatewayDelivery: {
      branch: "gateway-preview",
      gitRef: "gateway-preview",
      gitSha: "9".repeat(40),
      projectId: "gateway-preview-project",
      repoId: "gateway-repository",
    },
    publicGateway: {
      authBrowserOrigin: "https://auth-browser.example.test",
      branch: "gateway-preview",
      gatewayOrigin: "https://gateway-native.example.test",
      origin: "https://gateway.example.test",
      projectId: "gateway-preview-project",
      protectedApplicationIds: ["sibling-app"],
    },
    stage: "app",
  },
  effects: [
    { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
    { id: "auth-only-app-preview", kind: "delivery" },
  ],
  kind: "native-target-auth-only-delivery",
  resourcePlanDigest,
  source: {
    branch: plan.publishedSource.branch,
    gitSha: plan.publishedSource.gitSha,
    repositoryId: plan.publishedSource.repositoryId,
  },
  target,
  version: 1,
});
const deliveryPlanBytes = Buffer.from(JSON.stringify(deliveryPlan));
const deliveryPlanDigest = sha256(deliveryPlanBytes);
const runtimeUrl =
  "postgresql://auth_runtime:private@auth-preview.neon.tech/auth_identity?sslmode=verify-full";
const emailVerification: Parameters<
  typeof composeNativeTargetAuthOnlyPreviewEnvironment
>[0]["emailVerification"] = {
  required: "true" as const,
  sender: {
    apiKey: {
      id: "resend-secret-row",
      key: "AUTH_RECOVERY_RESEND_API_KEY" as const,
      physicalBranch: null,
      projectId: "gateway-preview-project",
      target: "preview" as const,
      type: "sensitive",
      updatedAt: 1_793_966_400_000,
    },
    environment: "preview" as const,
    from: "signup@example.test",
    ownerProjectId: "gateway-preview-project",
    provider: "resend" as const,
  },
};
const approval = {
  callId: "delivery-call",
  observedAt: "2026-11-06T12:00:00.000Z",
  outcome: "approved" as const,
  planDigest: deliveryPlanDigest,
  publicSessionId: plan.origin.publicSessionId,
  requestId: "delivery-request",
  responderPrincipalId: plan.origin.authority.ownerUserId,
  sourceDigest: deliveryPlanDigest,
};
const materials = () => ({
  appProjectMetadata: {
    link: {
      productionBranch: plan.branch,
      repoId: plan.publishedSource.repositoryId,
      type: "github",
    },
  },
  authRuntimeUrl: runtimeUrl,
  deliveryPlanBytes,
  emailVerification,
  gatewayProfileValues: {
    PLATFORM_GATEWAY_PROJECT_BINDINGS: JSON.stringify({ version: 1, bindings: [], source: {} }),
    PLATFORM_REALM_OPERATOR_LINK_CONFIG: JSON.stringify({ identityHandoff: {} }),
  },
  gatewayProjectMetadata: { link: { productionBranch: "gateway-preview" } },
  resourcePlan,
  resourcePlanBytes,
  resourcePlanDigest,
});
const compose = (
  overrides: Partial<{
    deliveryPlan: typeof deliveryPlan;
    authRuntimeUrl: string;
    gatewayProfileValues: Readonly<Record<string, string>>;
    observedGatewayValues: Readonly<Record<string, string>>;
    emailVerification: typeof emailVerification;
  }> = {},
) =>
  composeNativeTargetAuthOnlyPreviewEnvironment({
    appProjectMetadata: materials().appProjectMetadata,
    approval,
    authRuntimeUrl: runtimeUrl,
    deliveryPlan,
    deliveryPlanBytes,
    emailVerification,
    gatewayProfileValues: materials().gatewayProfileValues,
    gatewayProjectMetadata: materials().gatewayProjectMetadata,
    plan,
    resourcePlan,
    resourcePlanBytes,
    resourcePlanDigest,
    ...overrides,
  });

it("composes exact Gateway and static Next Preview manifests with no app database binding", () => {
  const result = compose();

  expect(Object.keys(result.gatewayValues).toSorted()).toEqual([
    "AUTH_DATABASE_RESOURCE",
    "AUTH_RECOVERY_EMAIL_FROM",
    "AUTH_REQUIRE_EMAIL_VERIFICATION",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  ]);
  expect(JSON.parse(result.gatewayValues.PLATFORM_GATEWAY_PROTECTED_APPLICATIONS)).toEqual([
    "sibling-app",
    "signup-reset-pilot",
  ]);
  expect(result.gatewayValues.PLATFORM_AUTH_DATABASE_URL).toBe(runtimeUrl);
  expect(result.appValues).toEqual({
    PLATFORM_JWKS_URL: "https://gateway-native.example.test/_platform/jwks.json",
    PLATFORM_ORIGIN: "https://gateway-native.example.test",
    PLATFORM_PUBLIC_ORIGIN: "https://gateway.example.test",
  });
  expect(result.manifest.gateway).toMatchObject({
    branch: "gateway-preview",
    physicalBranch: null,
    recoverySecret: emailVerification.sender.apiKey,
  });
  expect(result.manifest.gateway.values.map(({ key }) => key)).not.toContain(
    "AUTH_RECOVERY_RESEND_API_KEY",
  );
  expect(result.manifest.app).toMatchObject({ branch: plan.branch, physicalBranch: null });
  expect(JSON.stringify(result.manifest)).not.toContain("private");
  expect(result.appValues).not.toHaveProperty("DATABASE_URL");
  expect(result.appValues).not.toHaveProperty("BETTER_AUTH_SECRET");
  expect(result.appValues).not.toHaveProperty("AUTH_RECOVERY_RESEND_API_KEY");
});

it("fails closed on changed Auth resource credentials, source SHA, or missing Gateway binding key", () => {
  expect(() =>
    compose({
      authRuntimeUrl:
        "postgresql://auth_runtime:private@other.neon.tech/auth_identity?sslmode=verify-full",
    }),
  ).toThrow("resource_mismatch");
  const wrongSha = { ...deliveryPlan, source: { ...deliveryPlan.source, gitSha: "8".repeat(40) } };
  expect(() => compose({ deliveryPlan: wrongSha })).toThrow("binding_mismatch");
  const missing = {
    PLATFORM_GATEWAY_PROJECT_BINDINGS:
      materials().gatewayProfileValues.PLATFORM_GATEWAY_PROJECT_BINDINGS,
  };
  expect(() => compose({ gatewayProfileValues: missing })).toThrow("keys_mismatch");
  expect(() =>
    compose({ observedGatewayValues: { PLATFORM_AUTH_DATABASE_URL: "postgresql://conflict" } }),
  ).toThrow("environment_conflict");
  expect(compose({ observedGatewayValues: {} }).gatewayValues.PLATFORM_AUTH_DATABASE_URL).toBe(
    runtimeUrl,
  );
});

it("sends only the selected effect's exact project, branch and hashed approval to the verifier", async () => {
  const applyAndVerify = vi.fn(async () => {});
  const readMaterials = vi.fn(() => Promise.resolve(materials()));
  const assertCurrent = vi.fn(async () => {});
  const port = createNativeTargetAuthOnlyPreviewEnvironmentPort({ applyAndVerify, readMaterials });
  const { signal } = new AbortController();
  await port({
    approval,
    assertCurrent,
    authority: plan.origin.authority,
    deliveryPlan,
    effect: "app",
    fenceGeneration: 3,
    operationRef: "11111111-1111-4111-a111-111111111111",
    plan,
    signal,
    target,
  });
  expect(applyAndVerify).toHaveBeenCalledOnce();
  expect(applyAndVerify).toHaveBeenCalledWith(
    expect.objectContaining({
      approvedDeliveryDigest: deliveryPlanDigest,
      branch: plan.branch,
      effect: "app",
      physicalBranch: null,
      projectId: target.projectId,
    }),
  );
  expect(assertCurrent).toHaveBeenCalledTimes(3);
});

it.each(["wrong-branch", "wrong-project", "readable-key", "extra-value", "invalid-from"])(
  "rejects %s sender metadata before composing a Preview manifest",
  (kind) => {
    const apiKey = { ...emailVerification.sender.apiKey };
    const sender = { ...emailVerification.sender, apiKey };
    if (kind === "wrong-branch") {
      apiKey.physicalBranch = "other";
    }
    if (kind === "wrong-project") {
      apiKey.projectId = "other";
    }
    if (kind === "readable-key") {
      apiKey.type = "encrypted";
    }
    if (kind === "extra-value") {
      Object.assign(apiKey, { value: "fixture" });
    }
    if (kind === "invalid-from") {
      sender.from = "Pilot <pilot@example.test>";
    }
    expect(() => compose({ emailVerification: { ...emailVerification, sender } })).toThrow(
      "native_target_auth_only_preview_email_verification_unavailable",
    );
  },
);
