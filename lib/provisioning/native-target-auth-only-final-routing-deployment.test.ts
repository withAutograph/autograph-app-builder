/* oxlint-disable eslint/require-await -- Faithful read-only configuration/provider/lock fakes preserve async ports. */
import { expect, it, vi } from "vitest";
import { createNativeTargetAuthOnlyFinalRoutingAuthority } from "./native-target-auth-only-final-routing-deployment";
import { nativeTargetAuthOnlyFinalRoutingPlanSchema } from "./native-target-auth-only-final-routing";
import {
  nativeTargetAuthOnlyDeliveryPlanSchema,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "./native-target-auth-only-delivery-plan";
import { nativeTargetAuthOnlyTestPlan } from "./native-target-auth-only-plan-schema.test";
import { nativeTargetAuthOnlyPlanDigest } from "./native-target-auth-only-plan-schema";
import type { NativeTargetAuthOnlyDeliveryEnvironmentInput } from "./native-target-auth-only-delivery-runtime";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { createPostgresPhysicalResourceLease } from "./postgres-physical-resource-lease";

const fixture = () => {
  const assertCurrent = vi.fn(async () => {});
  const plan = nativeTargetAuthOnlyTestPlan();
  const source = {
    audience: "https://vercel.com/team",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: plan.project.teamId,
    projectId: "gateway",
    subject: "gateway-preview",
  };
  const configuration: Pick<HostedOperatorSourceConfiguration, "catalogAppIds" | "gateway"> = {
    catalogAppIds: [plan.appId],
    gateway: {
      authBrowserOrigin: "https://auth.example",
      branch: "preview",
      environment: "preview",
      gatewayOrigin: "https://bootstrap.vercel.app",
      gitSha: "a".repeat(40),
      projectId: "gateway",
      protectedApplicationIds: [plan.appId],
      publicOrigin: "https://pilot.example",
      repoId: "repo",
      workload: source,
    },
  };
  const operationRef = "11111111-1111-4111-a111-111111111111";
  const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    delivery: {
      action: "prepare",
      delivery: {
        branch: plan.branch,
        gitSha: plan.publishedSource.gitSha,
        projectId: "app",
        repoId: plan.publishedSource.repositoryId,
      },
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      gatewayDelivery: {
        branch: "preview",
        gitSha: "a".repeat(40),
        projectId: "gateway",
        repoId: "repo",
      },
      publicGateway: {
        authBrowserOrigin: "https://auth.example",
        branch: "preview",
        gatewayOrigin: "https://bootstrap.vercel.app",
        origin: "https://pilot.example",
        projectId: "gateway",
      },
      stage: "app",
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    kind: "native-target-auth-only-delivery",
    resourcePlanDigest: "b".repeat(64),
    source: {
      branch: plan.branch,
      gitSha: plan.publishedSource.gitSha,
      repositoryId: plan.publishedSource.repositoryId,
    },
    target: {
      appId: plan.appId,
      branch: plan.branch,
      environment: "preview",
      installationId: plan.project.installationId,
      projectId: "app",
      scopeId: plan.project.teamId,
      scopeType: "team",
      sessionId: plan.origin.publicSessionId,
    },
    version: 1,
  });
  const digest = nativeTargetAuthOnlyDeliveryPlanDigest(Buffer.from(JSON.stringify(deliveryPlan)));
  const environment: NativeTargetAuthOnlyDeliveryEnvironmentInput = {
    approval: {
      callId: "call",
      observedAt: "2026-11-06T12:00:00.000Z",
      outcome: "approved",
      planDigest: digest,
      publicSessionId: plan.origin.publicSessionId,
      requestId: "request",
      responderPrincipalId: plan.origin.authority.ownerUserId,
      sourceDigest: digest,
    },
    assertCurrent,
    authority: plan.origin.authority,
    deliveryPlan,
    effect: "gateway",
    fenceGeneration: 3,
    operationRef,
    plan,
    signal: new AbortController().signal,
    target: deliveryPlan.target,
  };
  const row = {
    physicalBranch: "preview",
    projectId: "gateway",
    rowId: "owned-env-row",
    value: JSON.stringify({
      version: 1,
      provenance: "trusted-operator-published-provider-projection",
      source: { ...source, publicOrigin: "https://pilot.example" },
      bindings: [],
    }),
  };
  const readConfiguration = vi.fn(async () => configuration);
  const read = vi.fn(async () => row);
  const lockCalls: string[][] = [];
  const lock: ReturnType<typeof createPostgresPhysicalResourceLease> = async (value, run) => {
    lockCalls.push([...value.lockKeys]);
    await value.readCurrentFence();
    return await run(assertCurrent);
  };
  const authority = createNativeTargetAuthOnlyFinalRoutingAuthority({
    openProjection: async () => ({
      read,
      patch: async () => {
        throw new Error("planning cannot write");
      },
    }),
    readConfiguration,
    withPhysicalLease: lock,
  });
  const gateway = {
    branch: "preview",
    deploymentId: "bootstrap",
    operationRef,
    origin: "https://bootstrap.vercel.app",
    projectId: "gateway",
    readyState: "READY" as const,
    repoId: "repo",
  };
  const app = {
    branch: plan.branch,
    deploymentId: "app-ready",
    operationRef,
    origin: "https://app-ready.vercel.app",
    projectId: "app",
    projectName: plan.project.name,
    readyState: "READY" as const,
    repoId: plan.publishedSource.repositoryId,
    scopeSlug: "team",
  };
  return {
    app,
    assertCurrent,
    authority,
    configuration,
    environment,
    gateway,
    lockCalls,
    readConfiguration,
    row,
    source,
  };
};
it("freezes exact parent receipts and the owned projection preimage using the registered source workload", async () => {
  const f = fixture();
  const bytes = await f.authority.preparePlan({
    app: f.app,
    environment: f.environment,
    gateway: f.gateway,
    routingOperationRef: "22222222-2222-4222-a222-222222222222",
  });
  const result = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(bytes.toString("utf-8")),
  );
  expect(result).toMatchObject({
    app: f.app,
    bootstrap: f.gateway,
    deliveryOperationRef: f.environment.operationRef,
    operationRef: "22222222-2222-4222-a222-222222222222",
    projection: { appDeploymentId: f.app.deploymentId, rowId: f.row.rowId },
    source: { ...f.source, publicOrigin: "https://pilot.example" },
  });
  expect(f.lockCalls).toEqual([]);
});
it("uses the normal physical Gateway lock and rechecks the exact configured source", async () => {
  const f = fixture();
  const readCurrentFence = vi.fn(async () => ({
    fenceGeneration: 8,
    leaseId: "lease",
    operationRef: "op",
  }));
  await expect(
    f.authority.withGatewayLease(
      { environment: f.environment, readCurrentFence },
      async (assertFence) => {
        await assertFence();
        return "ready";
      },
    ),
  ).resolves.toBe("ready");
  expect(readCurrentFence).toHaveBeenCalled();
  expect(f.lockCalls).toEqual([
    [
      JSON.stringify([
        "hosted_protected_operator_vercel_project_v1",
        f.environment.target.scopeId,
        "gateway",
      ]),
    ],
  ]);
  await f.authority.assertCatalogApp({
    appReceipt: f.app,
    environment: f.environment,
    source: { ...f.source, publicOrigin: "https://pilot.example" },
  });
  await expect(
    f.authority.assertCatalogApp({
      appReceipt: f.app,
      environment: f.environment,
      source: { ...f.source, publicOrigin: "https://foreign.example" },
    }),
  ).rejects.toThrow("resource_mismatch");
});
it.each(["catalog", "protected", "source", "sha"])(
  "refuses a changed %s boundary before planning or locking",
  async (boundary) => {
    const f = fixture();
    if (boundary === "catalog") {
      f.configuration.catalogAppIds = [];
    }
    if (boundary === "protected") {
      f.configuration.gateway.protectedApplicationIds = [];
    }
    if (boundary === "source") {
      f.configuration.gateway.workload = {
        ...f.configuration.gateway.workload,
        ownerId: "foreign-team",
      };
    }
    if (boundary === "sha") {
      f.configuration.gateway.gitSha = "b".repeat(40);
    }
    await expect(
      f.authority.preparePlan({
        app: f.app,
        environment: f.environment,
        gateway: f.gateway,
        routingOperationRef: "22222222-2222-4222-a222-222222222222",
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(f.lockCalls).toEqual([]);
  },
);
