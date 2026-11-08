/* oxlint-disable eslint/require-await -- Typed callback ports are private local fixtures, with no provider effects. */
import { generateKeyPairSync } from "node:crypto";
import { expect, it, vi } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  retainedOperatorAuthSchema,
} from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import {
  publicReleasePlanSchema,
  publicReleasePlanDigest,
  publicReleaseOperationRef,
} from "./public-release-contract";
import { publicRealmLinkConfigurationSchema } from "./public-realm-link-configuration";
import { createPublicRealmCallbackResolver } from "./public-realm-callback-resolution";
import type { PublicRealmCallbackCandidate } from "./public-realm-callback-resolution";
import { initialPublicReleaseRecord } from "./public-release-store";
import {
  ownedAppPublicEnvironmentKeys,
  ownedAppPublicEnvironmentManifest,
} from "./owned-app-auth-environment";
import { plan as basePlan, authority } from "./public-release-test-fixture";

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const fixture = () => {
  const sourcePlan = hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("first"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "source-auth-artifact",
      installer: { reference: "auth-worker", sha256: "a".repeat(64) },
      planDigest: "b".repeat(64),
      targetDigest: "c".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "fixture",
    deploymentBoundary: {
      composition: "single-project-services",
      authority,
      teamId: basePlan.project.teamId,
      app: { branch: "preview", environment: "preview", projectId: basePlan.project.projectId },
      gateway: { branch: "preview", environment: "preview", projectId: basePlan.project.projectId },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator-infrastructure",
      },
      verification: {
        gatewayOrigin: basePlan.publicOrigin,
        publicOrigin: basePlan.publicOrigin,
        jwksUrl: `${basePlan.publicOrigin}/_platform/jwks.json`,
      },
    },
    cost: { class: "shared-recovery-group", description: "synthetic fixture", owner: "owner" },
    effects: [
      { description: "Auth", id: "auth-resources", kind: "resources", resourceId: "auth-resource" },
      { description: "App", id: "app-resources", kind: "resources", resourceId: "first-resource" },
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "d".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "owner-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "synthetic-project",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: "preview",
      origin: basePlan.publicOrigin,
      projectId: basePlan.project.projectId,
    },
    release: { artifactRef: "source-release", id: "release", sha256: "f".repeat(64) },
    resourcesInstaller: { reference: "resource-worker", sha256: "e".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    selection: {
      appId: basePlan.selection.appId,
      sessionId: basePlan.selection.sessionId,
      projectId: basePlan.project.projectId,
      branch: "preview",
      environment: "preview",
    },
    stage: "auth-bootstrap",
    version: 1,
  });
  const retained = retainedOperatorAuthSchema.parse({
    approvalId: "source-approval",
    approvedByCallId: "source-call",
    operationRef: basePlan.runtime.operationRef,
    plan: sourcePlan,
    planDigest: operatorPlanDigest(sourcePlan),
    authPreparation: {
      assetSha256: "9".repeat(64),
      catalogFingerprint: "b".repeat(64),
      database: "auth",
      observedAt: "2026-11-03T00:00:00Z",
      runtimeRole: "auth_runtime",
      targetDigest: sourcePlan.authSchema?.targetDigest,
    },
    receipts: sourcePlan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-11-03T00:00:00Z",
      resourceVersion: "observed",
    })),
  });
  const enrollmentRef = "88888888-8888-4888-a888-888888888888";
  const physical = {
    version: 1,
    environment: "preview",
    hostname: sourcePlan.neon.endpoint,
    port: 5432,
    database: "auth",
    schema: "public",
    runtimeRole: "auth_runtime",
    migratorRole: "auth_owner",
    neon: { projectId: sourcePlan.neon.projectId, branchId: sourcePlan.neon.branchId },
  };
  const sender = {
    issuer: "https://oidc.vercel.com/team",
    audience: "https://vercel.com/team",
    subject: "native-production",
    environment: "production",
    projectId: basePlan.project.projectId,
    ownerId: basePlan.project.teamId,
  };
  const link = publicRealmLinkConfigurationSchema.parse({
    publicEnrollment: {
      version: 1,
      kind: "public-isolated-realm-v1",
      enrollmentRef,
      appId: basePlan.selection.appId,
      ownerSessionId: basePlan.selection.sessionId,
      authority,
      publicOrigin: basePlan.publicOrigin,
      project: {
        projectId: basePlan.project.projectId,
        ownerId: basePlan.project.teamId,
        environment: "production",
      },
      sourceBootstrap: {
        authResourceId: "auth-resource",
        operationRef: retained.operationRef,
        planDigest: retained.planDigest,
      },
      resource: physical,
    },
    browserOrigin: basePlan.publicOrigin,
    builderCallbackOrigin: "https://builder.example",
    builderCallbackPath: "/api/hosted-operator/realm-identity",
    operatorOrigin: "https://operator.example",
    identityHandoff: { sender },
    browserSessionCapture: { path: "/api/hosted-operator/realm-browser-session", sender },
    readonlyAttesters: {
      builderProduction: { ...sender },
      operatorPreview: { ...sender, environment: "preview" },
    },
  });
  const values: Record<string, string> = Object.fromEntries(
    ownedAppPublicEnvironmentKeys(basePlan.selection.appId).map((key) => [key, `fixture-${key}`]),
  );
  values.INVOICE_APP_DATABASE_URL =
    "postgresql://first_runtime:fixture@ep-fixture.neon.tech/first?sslmode=verify-full";
  values.PLATFORM_AUTH_DATABASE_URL =
    "postgresql://auth_runtime:fixture@ep-fixture.neon.tech/auth?sslmode=verify-full";
  values.PLATFORM_REALM_OPERATOR_LINK_CONFIG = JSON.stringify(link);
  values.PLATFORM_GATEWAY_IDENTITY_PRIVATE_KEY = generateKeyPairSync("ed25519").privateKey.export({
    format: "pem",
    type: "pkcs8",
  });
  const plan = publicReleasePlanSchema.parse({
    ...basePlan,
    purpose: "auth-bootstrap",
    runtime: {
      ...basePlan.runtime,
      planDigest: retained.planDigest,
      realmEnrollmentRef: enrollmentRef,
    },
    environment: ownedAppPublicEnvironmentManifest(basePlan.selection.appId, values),
  });
  const context = {
    authority,
    target: {
      ...sourcePlan.selection,
      installationId: "installation",
      scopeId: "team",
      scopeType: "team" as const,
    },
  };
  const runtime = hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "source-call",
    request: context.target,
    status: "pending",
    step: "reserved",
    retainedAuth: retained,
  });
  const record = initialPublicReleaseRecord(plan);
  record.approvalReceipts = [{ approvalId: "public-approval", approvedByCallId: "public-call" }];
  record.effects = { "bind-production-runtime": "applied", "publish-release-source": "applied" };
  record.bindings = Object.fromEntries(
    plan.environment.map(({ key }) => [
      key,
      { state: "applied" as const, acceptedEnvId: `owned-${key}` },
    ]),
  );
  record.observation = {
    status: "ready",
    projectId: plan.project.projectId,
    deploymentId: "native-deployment",
    environment: "production",
    publicOrigin: plan.publicOrigin,
    releaseId: plan.runtime.releaseId,
  };
  const candidate = {
    requestId: publicReleaseOperationRef(plan),
    requestDigest: publicReleasePlanDigest(plan),
    record,
  };
  let rows: PublicRealmCallbackCandidate[] = [candidate];
  const deps = {
    configuration: {
      standardRuntime: {
        profileId: "isolated",
        authOwnership: { kind: "dedicated-app-development" as const, resource: resource("auth") },
        publicRealmWorkload: link.identityHandoff.sender,
        productionDatabaseIdentity: "ep-customer.neon.tech/auth",
        provisioningRequestId: plan.project.provisioningRequestId,
        provisioningDigest: plan.project.provisioningDigest,
        appSpecDigest: "e".repeat(64),
        capturedReleaseId: plan.runtime.releaseId,
      },
    },
    readReleases: vi.fn(async () => structuredClone(rows)),
    readRuntime: vi.fn(async () => runtime),
    readEnrollment: vi.fn(async () => link),
    readValues: vi.fn(async () => values),
    assertCurrentOwner: vi.fn(async () => {}),
    assertSourceApproval: vi.fn(async () => {}),
    assertPublicApproval: vi.fn(async () => {}),
  };
  return {
    context,
    plan,
    record,
    candidate,
    values,
    link,
    deps,
    resolve: createPublicRealmCallbackResolver(deps),
    setRows: (v: PublicRealmCallbackCandidate[]) => {
      rows = v;
    },
  };
};
it("requires unique READY approved public release, exact original Auth and sealed key evidence", async () => {
  const f = fixture();
  const result = await f.resolve(f.context);
  expect(result.binding).toEqual({
    enrollmentRef: f.plan.runtime.realmEnrollmentRef,
    operationRef: f.candidate.requestId,
    planDigest: f.candidate.requestDigest,
  });
  expect(result.publicJwk).toMatchObject({
    crv: "Ed25519",
    kid: f.values.PLATFORM_GATEWAY_IDENTITY_KEY_ID,
    kty: "OKP",
  });
  expect(f.deps.assertSourceApproval).toHaveBeenCalledOnce();
  expect(f.deps.assertPublicApproval).toHaveBeenCalledOnce();
  expect(f.deps.readReleases).toHaveBeenCalledTimes(2);
});
it.each(["duplicate", "not-ready", "missing-consent", "wrong-release", "wrong-owner"])(
  "rejects %s without reading enrollment or runtime credentials",
  async (kind) => {
    const f = fixture();
    if (kind === "duplicate") {
      f.setRows([f.candidate, structuredClone(f.candidate)]);
    }
    if (kind === "not-ready") {
      f.record.observation = { status: "pending" };
    }
    if (kind === "missing-consent") {
      f.record.approvalReceipts = [];
    }
    if (kind === "wrong-release" && f.record.observation?.status === "ready") {
      f.record.observation.releaseId = "another-release";
    }
    if (kind === "wrong-owner") {
      f.context.authority = { ...f.context.authority, ownerUserId: "another-owner" };
    }
    await expect(f.resolve(f.context)).rejects.toThrow();
    expect(f.deps.readEnrollment).not.toHaveBeenCalled();
    expect(f.deps.readValues).not.toHaveBeenCalled();
  },
);
it("refuses revoked public consent before unsealing enrollment", async () => {
  const f = fixture();
  f.deps.assertPublicApproval.mockRejectedValue(new Error("consent-revoked"));
  await expect(f.resolve(f.context)).rejects.toThrow("consent-revoked");
  expect(f.deps.readEnrollment).not.toHaveBeenCalled();
});
it("refuses a changed frozen row during final canonical readback", async () => {
  const f = fixture();
  f.deps.readReleases
    .mockImplementationOnce(async () => [structuredClone(f.candidate)])
    .mockImplementationOnce(async () => []);
  await expect(f.resolve(f.context)).rejects.toThrow("public_realm_callback_unavailable");
});
it("refuses sealed enrollment or environment value substitution", async () => {
  const f = fixture();
  f.values.PLATFORM_REALM_OPERATOR_LINK_CONFIG = JSON.stringify({
    ...f.link,
    browserOrigin: "https://other.example",
  });
  await expect(f.resolve(f.context)).rejects.toThrow("public_realm_callback_unavailable");
});
it("refuses original installer approval revocation before unsealing public enrollment", async () => {
  const f = fixture();
  f.deps.assertSourceApproval.mockRejectedValue(new Error("source-consent-revoked"));
  await expect(f.resolve(f.context)).rejects.toThrow("source-consent-revoked");
  expect(f.deps.readEnrollment).not.toHaveBeenCalled();
});

it("rejects a different actual Auth database tuple despite matching release and enrollment references", async () => {
  const f = fixture();
  f.link.publicEnrollment.resource.runtimeRole = "another_runtime";
  await expect(f.resolve(f.context)).rejects.toThrow("public_realm_callback_unavailable");
  expect(f.deps.readValues).not.toHaveBeenCalled();
});
