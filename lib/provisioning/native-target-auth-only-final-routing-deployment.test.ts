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
    environment: "preview" as const,
    ownerId: plan.project.teamId,
    projectId: "gateway",
    issuer: "https://oidc.vercel.com/team",
    audience: "https://vercel.com/team",
    subject: "gateway-preview",
  };
  const configuration: Pick<HostedOperatorSourceConfiguration, "catalogAppIds" | "gateway"> = {
    catalogAppIds: [plan.appId],
    gateway: {
      workload: source,
      projectId: "gateway",
      environment: "preview",
      branch: "preview",
      repoId: "repo",
      gitSha: "a".repeat(40),
      publicOrigin: "https://pilot.example",
      authBrowserOrigin: "https://auth.example",
      gatewayOrigin: "https://bootstrap.vercel.app",
      protectedApplicationIds: [plan.appId],
    },
  };
  const operationRef = "11111111-1111-4111-a111-111111111111";
  const deliveryPlan = nativeTargetAuthOnlyDeliveryPlanSchema.parse({
    kind: "native-target-auth-only-delivery",
    version: 1,
    authOnlyPlanDigest: nativeTargetAuthOnlyPlanDigest(plan),
    resourcePlanDigest: "b".repeat(64),
    target: {
      appId: plan.appId,
      sessionId: plan.origin.publicSessionId,
      installationId: plan.project.installationId,
      projectId: "app",
      scopeId: plan.project.teamId,
      scopeType: "team",
      environment: "preview",
      branch: plan.branch,
    },
    source: {
      branch: plan.branch,
      gitSha: plan.publishedSource.gitSha,
      repositoryId: plan.publishedSource.repositoryId,
    },
    effects: [
      { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
      { id: "auth-only-app-preview", kind: "delivery" },
    ],
    delivery: {
      action: "prepare",
      stage: "app",
      effects: [
        { id: "auth-only-gateway-preview", kind: "gateway-delivery" },
        { id: "auth-only-app-preview", kind: "delivery" },
      ],
      gatewayDelivery: {
        projectId: "gateway",
        branch: "preview",
        repoId: "repo",
        gitSha: "a".repeat(40),
      },
      publicGateway: {
        projectId: "gateway",
        branch: "preview",
        origin: "https://pilot.example",
        authBrowserOrigin: "https://auth.example",
        gatewayOrigin: "https://bootstrap.vercel.app",
      },
      delivery: {
        projectId: "app",
        branch: plan.branch,
        repoId: plan.publishedSource.repositoryId,
        gitSha: plan.publishedSource.gitSha,
      },
    },
  });
  const digest = nativeTargetAuthOnlyDeliveryPlanDigest(Buffer.from(JSON.stringify(deliveryPlan)));
  const environment: NativeTargetAuthOnlyDeliveryEnvironmentInput = {
    authority: plan.origin.authority,
    target: deliveryPlan.target,
    plan,
    deliveryPlan,
    operationRef,
    fenceGeneration: 3,
    effect: "gateway",
    assertCurrent,
    signal: new AbortController().signal,
    approval: {
      requestId: "request",
      callId: "call",
      planDigest: digest,
      sourceDigest: digest,
      responderPrincipalId: plan.origin.authority.ownerUserId,
      publicSessionId: plan.origin.publicSessionId,
      outcome: "approved",
      observedAt: "2026-11-06T12:00:00.000Z",
    },
  };
  const row = {
    projectId: "gateway",
    rowId: "owned-env-row",
    physicalBranch: "preview",
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
    readConfiguration,
    openProjection: async () => ({
      read,
      patch: async () => {
        throw new Error("planning cannot write");
      },
    }),
    withPhysicalLease: lock,
  });
  const gateway = {
    operationRef,
    projectId: "gateway",
    repoId: "repo",
    branch: "preview",
    deploymentId: "bootstrap",
    origin: "https://bootstrap.vercel.app",
    readyState: "READY" as const,
  };
  const app = {
    operationRef,
    projectId: "app",
    repoId: plan.publishedSource.repositoryId,
    branch: plan.branch,
    deploymentId: "app-ready",
    origin: "https://app-ready.vercel.app",
    projectName: plan.project.name,
    scopeSlug: "team",
    readyState: "READY" as const,
  };
  return {
    authority,
    configuration,
    environment,
    source,
    row,
    assertCurrent,
    readConfiguration,
    lockCalls,
    gateway,
    app,
  };
};
it("freezes exact parent receipts and the owned projection preimage using the registered source workload", async () => {
  const f = fixture();
  const bytes = await f.authority.preparePlan({
    environment: f.environment,
    gateway: f.gateway,
    app: f.app,
    routingOperationRef: "22222222-2222-4222-a222-222222222222",
  });
  const result = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
    JSON.parse(bytes.toString("utf-8")),
  );
  expect(result).toMatchObject({
    operationRef: "22222222-2222-4222-a222-222222222222",
    deliveryOperationRef: f.environment.operationRef,
    bootstrap: f.gateway,
    app: f.app,
    source: { ...f.source, publicOrigin: "https://pilot.example" },
    projection: { rowId: f.row.rowId, appDeploymentId: f.app.deploymentId },
  });
  expect(f.lockCalls).toEqual([]);
});
it("uses the normal physical Gateway lock and rechecks the exact configured source", async () => {
  const f = fixture();
  const readCurrentFence = vi.fn(async () => ({
    operationRef: "op",
    leaseId: "lease",
    fenceGeneration: 8,
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
    environment: f.environment,
    source: { ...f.source, publicOrigin: "https://pilot.example" },
    appReceipt: f.app,
  });
  await expect(
    f.authority.assertCatalogApp({
      environment: f.environment,
      source: { ...f.source, publicOrigin: "https://foreign.example" },
      appReceipt: f.app,
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
        environment: f.environment,
        gateway: f.gateway,
        app: f.app,
        routingOperationRef: "22222222-2222-4222-a222-222222222222",
      }),
    ).rejects.toThrow("resource_mismatch");
    expect(f.lockCalls).toEqual([]);
  },
);
