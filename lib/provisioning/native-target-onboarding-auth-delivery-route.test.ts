import { beforeEach, expect, it, vi } from "vitest";
import { createHash } from "node:crypto";
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
import {
  buildNativeTargetAuthOnlyDeliveryPlanBytes,
  nativeTargetAuthOnlyDeliveryPlanDigest,
} from "./native-target-auth-only-delivery-plan";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { NativeTargetRequest } from "./native-target-onboarding-transport";
import type { NativeTargetAuthOnlyFinalRoutingAuthority } from "./native-target-auth-only-final-routing-deployment";
import type { NativeTargetAuthOnlyEntryAuthority } from "./native-target-auth-only-entry-deployment";
import { nativeTargetAuthOnlyOwnerLinkBindingSchema } from "./native-target-auth-only-owner-link";
import {
  authOnlyOrganizationPlanSchema,
  authOnlySignupPolicyPlanSchema,
} from "./hosted-operator-sandbox-launcher";
import { nativeTargetAuthOnlyEntryApprovalInputSchema } from "./native-target-auth-only-entry-plan-store";

import type {
  NativeTargetAuthOnlyDeliveryEnvironmentInput,
  NativeTargetAuthOnlyAfterGatewayReadyInput,
} from "./native-target-auth-only-delivery-runtime";
import type { NativeTargetAuthOnlyPreviewDeliveryInput } from "./native-target-auth-only-preview-delivery";

const mock = vi.hoisted(() => ({
  environment: vi.fn(),
  gate: vi.fn(),
  genericService: vi.fn(),
  readApproval: vi.fn(),
  readDescription: vi.fn(),
  readDispatch: vi.fn(),
  readEntryApproval: vi.fn(),
  readPlan: vi.fn(),
  readPublishedSource: vi.fn(),
  readResource: vi.fn(),
  readRoutingApproval: vi.fn(),
  readRuntime: vi.fn(),
  reconcile: vi.fn(),
  resolveRegistered: vi.fn(),
  runOrganization: vi.fn(),
  runRouting: vi.fn(),
  runSignupPolicy: vi.fn(),
}));
vi.mock("./native-target-auth-only-dispatch", async (original) => ({
  ...(await original<typeof import("./native-target-auth-only-dispatch")>()),
  createPostgresNativeTargetAuthOnlyDispatchStore: () => ({ read: mock.readDispatch }),
}));
vi.mock("./native-target-auth-only-plan-store", () => ({
  createNativeTargetAuthOnlyPlanStore: () => ({ read: mock.readPlan }),
}));
vi.mock("./native-target-auth-only-resource-plan-store", async (original) => ({
  ...(await original<typeof import("./native-target-auth-only-resource-plan-store")>()),
  createNativeTargetAuthOnlyResourcePlanStore: () => ({ read: mock.readResource }),
}));
vi.mock("./native-target-configuration-resolver", () => ({
  resolveNativeTargetAuthOnlyRegistration: mock.resolveRegistered,
}));
vi.mock("./captured-app-description", () => ({
  createCapturedAppDescriptionStore: () => ({ read: mock.readDescription }),
}));
vi.mock("./hosted-operator-auth-only-runtime", async (original) => ({
  ...(await original<typeof import("./hosted-operator-auth-only-runtime")>()),
  createPostgresNativeTargetAuthOnlyRuntimeStore: () => ({ read: mock.readRuntime }),
  readNativeTargetAuthOnlyPublishedSource: mock.readPublishedSource,
}));
vi.mock("../eve/private-native-target-auth-only-delivery-approval", async (original) => ({
  ...(await original<typeof import("../eve/private-native-target-auth-only-delivery-approval")>()),
  readPrivateNativeTargetAuthOnlyDeliveryApproval: mock.readApproval,
}));
vi.mock("../eve/private-native-target-auth-only-entry-approval", async (original) => ({
  ...(await original<typeof import("../eve/private-native-target-auth-only-entry-approval")>()),
  readPrivateNativeTargetAuthOnlyEntryApproval: mock.readEntryApproval,
}));
vi.mock("../eve/private-native-target-auth-only-final-routing-approval", async (original) => ({
  ...(await original<
    typeof import("../eve/private-native-target-auth-only-final-routing-approval")
  >()),
  readPrivateNativeTargetAuthOnlyFinalRoutingApproval: mock.readRoutingApproval,
}));
vi.mock("./native-target-auth-only-final-routing", async (original) => ({
  ...(await original<typeof import("./native-target-auth-only-final-routing")>()),
  createNativeTargetAuthOnlyFinalRouting: (deps: unknown) => (value: unknown) =>
    mock.runRouting(deps, value),
}));
vi.mock("./hosted-operator-sandbox-launcher", async (original) => ({
  ...(await original<typeof import("./hosted-operator-sandbox-launcher")>()),
  runAuthOrganizationFileSpool: mock.runOrganization,
  runAuthSignupPolicyFileSpool: mock.runSignupPolicy,
}));
vi.mock("../integrations/vercel-installation", async (original) => ({
  ...(await original<typeof import("../integrations/vercel-installation")>()),
  readVercelTokenKeyringEnvironment: () => ({}),
}));
vi.mock("./native-target-onboarding-service", () => ({
  createNativeTargetOnboardingService: () => mock.genericService,
}));
vi.mock("./native-target-auth-only-preview-delivery", async (original) => ({
  ...(await original<typeof import("./native-target-auth-only-preview-delivery")>()),
  createNativeTargetAuthOnlyPreviewDelivery: (deps: {
    target: string;
    assertEnvironment: () => Promise<void>;
  }) => ({
    deliver: async () => {
      throw new Error("unexpected provider create");
    },
    reconcile: async (context: NativeTargetAuthOnlyPreviewDeliveryInput) => {
      await context.assertCurrent();
      await deps.assertEnvironment();
      return await mock.reconcile(deps.target, context);
    },
  }),
}));
vi.mock("../integrations/postgres-vercel-installation", () => ({
  readActiveVercelInstallationToken: async () => ({
    binding: { active: true, scopeId: "team-fixture", scopeType: "team" },
    token: "fixture-token",
  }),
}));
vi.mock("./native-target-vercel-provider", () => ({
  observeNativeTargetVercelProject: async () => ({ status: "verified" }),
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
    gitSha: "8".repeat(40),
    projectId: "gateway-fixture",
    publicOrigin: "https://apps.example",
    repoId: "gateway-repo",
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
const common = {
  adapterSessionId: historyOwner.adapterSessionId,
  callId: "different-retry-call",
  ownerContext: historyOwner,
};
const verifyWorkload = vi.fn();
const assertCanonicalAppOwner = vi.fn();

const deliveryBytes = buildNativeTargetAuthOnlyDeliveryPlanBytes({
  plan,
  registration,
  resourcePlanBytes: resourceBytes,
  resourcePlanDigest,
  selected,
});
const deliveryPlanDigest = nativeTargetAuthOnlyDeliveryPlanDigest(deliveryBytes);
const deliveryInput = {
  appId,
  deliveryPlan: JSON.parse(deliveryBytes.toString("utf8")),
  deliveryPlanDigest,
  operationRef,
  planDigest,
  resourcePlanDigest,
};
const deliveryApproval = {
  ...schemaApproval,
  callId: "original-delivery-call",
  planDigest: deliveryPlanDigest,
  requestId: "delivery-approval",
  sourceDigest: deliveryPlanDigest,
};
interface JournalRow {
  requestId: string;
  requestDigest: string;
  revision: number;
  record: unknown;
  state: string;
}
const rows = new Map<string, JournalRow>();
const params = (where: SQL) => new PgDialect().sqlToQuery(where).params;
const database = {
  insert: () => ({
    values: (row: JournalRow) => ({
      onConflictDoNothing: async () => {
        expect(row.requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(["pending", "settled"]).toContain(row.state);
        if (!rows.has(row.requestId)) rows.set(row.requestId, structuredClone(row));
      },
    }),
  }),
  select: () => ({
    from: () => ({
      where: (where: SQL) => ({
        limit: async () => {
          const row = rows.get(String(params(where)[4]));
          return row === undefined ? [] : [structuredClone(row)];
        },
      }),
    }),
  }),
  update: () => ({
    set: (change: Partial<JournalRow>) => ({
      where: (where: SQL) => ({
        returning: async () => {
          const values = params(where);
          const row = rows.get(String(values[4]));
          if (row === undefined || row.revision !== values[5] || row.requestDigest !== values[6])
            return [];
          const next = { ...row, ...change };
          rows.set(row.requestId, structuredClone(next));
          return [structuredClone(next)];
        },
      }),
    }),
  }),
};
const routePlanBytes = (value: { gateway: unknown; app: { deploymentId: string } }) =>
  Buffer.from(
    JSON.stringify({
      app: value.app,
      bootstrap: value.gateway,
      deliveryOperationRef: operationRef,
      deliveryPlanDigest,
      gateway: {
        branch: selected.gateway.branch,
        gitRef: selected.gateway.branch,
        gitSha: selected.gateway.gitSha,
        projectId: selected.gateway.projectId,
        publicOrigin: selected.gateway.publicOrigin,
        repoId: selected.gateway.repoId,
      },
      kind: "native-target-auth-only-final-routing",
      operationRef: "33333333-3333-4333-a333-333333333333",
      projection: {
        appDeploymentId: value.app.deploymentId,
        deliveryPlanDigest,
        gatewayProjectId: selected.gateway.projectId,
        nextSha256: "2".repeat(64),
        operationRef,
        physicalBranch: selected.gateway.branch,
        priorSha256: "1".repeat(64),
        rowId: "env-projection",
      },
      source: {
        audience: "https://vercel.com/fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/fixture",
        ownerId: teamId,
        projectId: selected.gateway.projectId,
        publicOrigin: selected.gateway.publicOrigin,
        subject: "gateway",
      },
      target: deliveryInput.deliveryPlan.target,
      version: 1,
    }),
  );
const request = async (
  action: NativeTargetRequest,
  ports = true,
  authOnlyEntryAuthority?: NativeTargetAuthOnlyEntryAuthority,
  authOnlyFinalRoutingAuthority?: NativeTargetAuthOnlyFinalRoutingAuthority,
) =>
  await createNativeTargetOnboardingDeployment({
    authOnlyEntryAuthority,
    authOnlyFinalRoutingAuthority,
    builderOrigin: "https://builder.example",
    configuration: { applications: {} } as HostedOperatorSourceConfiguration,
    database: database as never,
    environment: {},
    owner: {
      assertCanonicalAppOwner,
      assertNoStandardBuilderDestination: async () => {},
      verifyWorkload,
    },
    ...(ports
      ? {
          authOnlyAfterGatewayReady: async (value: NativeTargetAuthOnlyAfterGatewayReadyInput) =>
            await mock.gate(value),
          authOnlyDeliveryEnvironment: async (
            value: NativeTargetAuthOnlyDeliveryEnvironmentInput,
          ) => await mock.environment(value),
          authOnlyPrepareFinalRoutingPlan: async (value) => routePlanBytes(value),
        }
      : {}),
  })(
    new Request("https://operator.example/v1/native-target", {
      headers: { authorization: "Bearer workload-fixture" },
      method: "POST",
    }),
    action,
  );
const planRequest = async () =>
  request({
    ...common,
    action: "native-target-auth-only-delivery-plan",
    input: { appId, operationRef, planDigest, resourcePlanDigest },
  });
beforeEach(() => {
  vi.resetAllMocks();
  rows.clear();
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
  mock.readDescription.mockResolvedValue(description);
  mock.readPublishedSource.mockResolvedValue(source);
  mock.readRuntime.mockResolvedValue({
    state: {
      authSchema: {
        artifactRef: authSchema.artifactRef,
        planDigest: authSchema.planDigest,
        targetDigest: authSchema.targetDigest,
      },
      plan,
      planDigest,
      stage: "prepared",
    },
  });
  mock.readApproval.mockImplementation(async (input) => {
    await input.assertOwner();
    return deliveryApproval;
  });
  mock.gate.mockResolvedValue({
    organizationId: "pilot-org",
    signupPolicyDigest: "f".repeat(64),
    status: "ready",
  });
  mock.reconcile.mockImplementation(
    async (target: string, context: NativeTargetAuthOnlyPreviewDeliveryInput) => {
      const source = target === "gateway" ? context.plan.gatewayDelivery! : context.plan.delivery!;
      const selected = {
        branch: source.branch,
        deploymentId: `dpl-${target}`,
        operationRef: context.operationRef,
        origin: `https://${target}.example`,
        projectId: source.projectId,
        readyState: "READY",
        repoId: source.repoId,
      };
      await context.checkpointDelivery([selected]);
      return { candidates: [selected], selected, status: "applied" };
    },
  );
});
it("retains the exact registered delivery plan without invoking a provider or approval gate", async () => {
  const response = await planRequest();
  expect(await response.json()).toEqual(deliveryInput);
  expect(mock.environment).not.toHaveBeenCalled();
  expect(mock.reconcile).not.toHaveBeenCalled();
  expect(mock.readApproval).not.toHaveBeenCalled();
  expect(mock.genericService).not.toHaveBeenCalled();
});
it("reads delivery approval independently and denies execution without approval or composition ports", async () => {
  await planRequest();
  mock.readApproval.mockResolvedValue(null);
  expect(
    await (
      await request({
        ...common,
        action: "native-target-auth-only-delivery-approval-read",
        input: deliveryInput,
      })
    ).json(),
  ).toEqual({ status: "pending" });
  await expect(
    request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }),
  ).rejects.toThrow("authorization_required");
  mock.readApproval.mockResolvedValue(deliveryApproval);
  await expect(
    request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }, false),
  ).rejects.toThrow("operator_unavailable");
  expect(mock.reconcile).not.toHaveBeenCalled();
});
it("returns verified Gateway/app receipts after the real route preserves owner, source, approval and readiness fences", async () => {
  await planRequest();
  const response = await request({
    ...common,
    action: "native-target-auth-only-delivery",
    input: deliveryInput,
  });
  expect(await response.json()).toMatchObject({
    app: { projectId: registration.projectId, readyState: "READY" },
    deliveryPlanDigest,
    gateway: { projectId: selected.gateway.projectId, readyState: "READY" },
    status: "routing-required",
  });
  expect(mock.environment.mock.calls.map(([value]) => value.effect)).toEqual(["gateway", "app"]);
  expect(mock.gate.mock.calls[0][0]).toMatchObject({
    deliveryPlanDigest,
    gateway: { projectId: selected.gateway.projectId, readyState: "READY" },
    operationRef,
  });
  expect(
    mock.environment.mock.calls.every(([value]) => !("appDatabase" in value.deliveryPlan)),
  ).toBe(true);
  expect(assertCanonicalAppOwner).toHaveBeenCalled();
  expect(verifyWorkload).toHaveBeenCalled();
});
it("publishes only owner-link fields and never enters app delivery before confirmation", async () => {
  await planRequest();
  const pending = {
    authIdentityLink: "https://gateway.example/confirm",
    authIdentityLinkExpiresAt: new Date(Date.now() + 60000).toISOString(),
    status: "pending-owner",
  };
  mock.gate.mockResolvedValue(pending);
  expect(
    await (
      await request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput })
    ).json(),
  ).toEqual({ ...pending, deliveryPlanDigest });
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway"]);
});
it.each(["source", "registration", "resource", "runtime", "owner"])(
  "denies %s drift before provider delivery",
  async (kind) => {
    await planRequest();
    if (kind === "source") {
      mock.readPublishedSource.mockResolvedValue({ ...source, gitSha: "9".repeat(40) });
    }
    if (kind === "registration") {
      mock.resolveRegistered.mockResolvedValue({
        ...selected,
        authOnlyApplications: {
          [appId]: {
            ...selected.authOnlyApplications![appId],
            registration: { ...registration, projectId: "unrelated" },
          },
        },
      });
    }
    if (kind === "resource") {
      mock.readResource.mockResolvedValue(undefined);
    }
    if (kind === "runtime") {
      mock.readRuntime.mockResolvedValue({ state: { stage: "unknown" } });
    }
    if (kind === "owner") {
      assertCanonicalAppOwner.mockRejectedValue(new Error("owner revoked"));
    }
    await expect(
      request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }),
    ).rejects.toThrow();
    expect(mock.reconcile).not.toHaveBeenCalled();
  },
);
it("requires the retained delivery bytes even when supplied approval input looks valid", async () => {
  await expect(
    request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }),
  ).rejects.toThrow("resource_mismatch");
  expect(mock.reconcile).not.toHaveBeenCalled();
});

const startOwnerPending = async () => {
  await planRequest();
  mock.gate.mockResolvedValue({
    authIdentityLink: "https://gateway.example/confirm",
    authIdentityLinkExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending-owner",
  });
  await request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput });
};
const childRequest = {
  appId,
  deliveryOperationRef: operationRef,
  deliveryPlanDigest,
  effect: "organization" as const,
};
const policyDigest = "4".repeat(64);
const childAuthority =
  (consumed: boolean, policyApplied = () => false): NativeTargetAuthOnlyEntryAuthority =>
  async (value) => {
    const proof = "private-proof-fixture";
    const proofSha256 = createHash("sha256").update(proof).digest("hex");
    const binding = nativeTargetAuthOnlyOwnerLinkBindingSchema.parse({
      audience: selected.operator.origin,
      authOnlyPlanDigest: planDigest,
      authResourceId: authDatabase.resourceId,
      authority,
      bootstrapResource: {
        database: authDatabase.database,
        environment: "preview",
        hostname: profile.nativeNeon.scope.hostname,
        migratorRole: authDatabase.migratorRole,
        neon: {
          branchId: profile.nativeNeon.scope.branchId,
          projectId: profile.nativeNeon.scope.projectId,
        },
        port: 5432,
        runtimeRole: authDatabase.runtimeRole,
        schema: "public",
        version: 1,
      },
      browserOrigin: selected.gateway.authBrowserOrigin,
      gateway: value.gateway,
      gatewayDeliveryPlanDigest: deliveryPlanDigest,
      issuer: selected.gateway.publicOrigin,
      operationRef,
      resourcePlanDigest,
      sender: {
        audience: "https://vercel.com/fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/fixture",
        ownerId: teamId,
        projectId: value.gateway.projectId,
        subject: "owner:fixture:project:gateway:environment:preview",
      },
      target: value.target,
    });
    const captured = {
      audience: binding.audience,
      authResourceId: binding.authResourceId,
      bootstrapPlanDigest: resourcePlanDigest,
      browserOrigin: binding.browserOrigin,
      consumedAt: schemaApproval.observedAt,
      endpointOrigin: value.gateway.origin,
      expiresAt: schemaApproval.observedAt,
      issuer: binding.issuer,
      nonceSha256: "e".repeat(64),
      organizationId: null,
      ownerSessionId: binding.target.sessionId,
      proofRef: "private-reference",
      proofSha256,
    };
    const identity = { actorId: "realm-owner", realmSessionId: "realm-session" };
    const jwksUrl = `${value.gateway.origin}/_platform/jwks.json`;
    return {
      ownerLink: {
        prepare: async () => ({
          status: "linked",
          operationRef,
          sessionId: historyOwner.sessionId,
        }),
        readCaptured: async () => (consumed ? captured : undefined),
      },
      readCredentials: async () => ({ migrationUrl: "private-migrator" }),
      readCurrentOwnerProof: async () => ({
        ...identity,
        reference: captured.proofRef,
        proof,
        oidcToken: "private-oidc",
      }),
      readOrganizationPlan: async () =>
        authOnlyOrganizationPlanSchema.parse({
          version: 1,
          action: "prepare",
          authDatabase,
          neon: { ...binding.bootstrapResource.neon, endpoint: binding.bootstrapResource.hostname },
          selection: { sessionId: historyOwner.sessionId, workspaceId: authority.workspaceId },
          deploymentBoundary: {
            teamId,
            operator: { projectId: "operator-fixture", environment: "preview" },
            verification: {
              publicOrigin: binding.issuer,
              gatewayOrigin: value.gateway.origin,
              jwksUrl,
            },
          },
          authMembership: {
            kind: "create-owned-organization",
            name: "Pilot",
            slug: "pilot",
            organizationId: "pilot-org",
            actorId: identity.actorId,
            bootstrapPlanDigest: resourcePlanDigest,
            identityCapture: {
              capturedAt: captured.consumedAt,
              realmSessionId: identity.realmSessionId,
            },
            identityNonceSha256: captured.nonceSha256,
            identityProof: { reference: captured.proofRef, sha256: proofSha256 },
            identityVerification: {
              audience: binding.audience,
              issuer: binding.issuer,
              jwksUrl,
              transportSource: {
                audience: "https://vercel.com/fixture",
                issuer: "https://oidc.vercel.com/fixture",
                projectId: "operator-fixture",
                ownerId: teamId,
                environment: "preview",
              },
            },
          },
          effects: [
            { kind: "auth-membership", id: "auth-membership", resourceId: authDatabase.resourceId },
          ],
          membershipInstaller: { reference: "auth-owned-organization-v1", sha256: "f".repeat(64) },
        }),
      readReadyBinding: async () => ({
        binding,
        sandbox: { image: "fixture", teamId, projectId: "operator-fixture", workers: {} },
      }),
      readSignupPolicy: async () =>
        policyApplied() ? { status: "applied", policyDigest } : { status: "absent" },
      readSignupPolicyPlan: async (_scope, organizationId) =>
        authOnlySignupPolicyPlanSchema.parse({
          version: 1,
          action: "prepare",
          authDatabase,
          neon: { ...binding.bootstrapResource.neon, endpoint: binding.bootstrapResource.hostname },
          selection: { sessionId: historyOwner.sessionId, workspaceId: authority.workspaceId },
          deploymentBoundary: {
            teamId,
            operator: { projectId: "operator-fixture", environment: "preview" },
            verification: {
              publicOrigin: binding.issuer,
              gatewayOrigin: value.gateway.origin,
              jwksUrl,
            },
          },
          authSignupPolicy: {
            version: 1,
            policyId: "pilot-policy",
            authResourceId: authDatabase.resourceId,
            appId,
            origin: binding.issuer,
            appPath: "/",
            organizationId,
            eligibility: "approved-email",
            allowedEmails: ["private-pilot@example.test"],
            membershipRole: "member",
            appRoles: [plan.appRole],
          },
          normalActorProgram: {
            appId,
            origin: binding.issuer,
            organizations: [{ organizationId }],
            appAccess: [{ appId, organizationId, roles: [plan.appRole] }],
          },
          effects: [
            {
              kind: "auth-signup-policy",
              id: "auth-signup-policy",
              resourceId: authDatabase.resourceId,
            },
          ],
          signupPolicyInstaller: {
            reference: "auth-owned-organization-v1",
            sha256: "f".repeat(64),
          },
        }),
    };
  };
const planChild = async (ports: NativeTargetAuthOnlyEntryAuthority) =>
  nativeTargetAuthOnlyEntryApprovalInputSchema.parse(
    await (
      await request(
        { ...common, action: "native-target-auth-only-entry-plan", input: childRequest },
        true,
        ports,
      )
    ).json(),
  );
it("plans only after READY and consumed proof, returns a stable digest-only child, and denies execution without its approval", async () => {
  await startOwnerPending();
  await expect(planChild(childAuthority(false))).rejects.toThrow("auth_identity_required");
  const ports = childAuthority(true);
  const child = await planChild(ports);
  expect(await planChild(ports)).toEqual(child);
  expect(child).toMatchObject(childRequest);
  expect(JSON.stringify(child)).not.toContain("private");
  mock.readEntryApproval.mockResolvedValue(null);
  const pending = await request(
    { ...common, action: "native-target-auth-only-entry-approval-read", input: child },
    true,
    ports,
  );
  expect(await pending.json()).toEqual({ status: "pending" });
  await expect(
    request({ ...common, action: "native-target-auth-only-entry", input: child }, true, ports),
  ).rejects.toThrow("authorization_required");
  expect(mock.runOrganization).not.toHaveBeenCalled();
  expect(await planChild(ports)).toEqual(child);
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway"]);
});

it("returns the approved organization only after worker readback, with no signup policy or deployment work", async () => {
  await startOwnerPending();
  const ports = childAuthority(true);
  const child = await planChild(ports);
  mock.readEntryApproval.mockResolvedValue({
    ...deliveryApproval,
    callId: "original-child-call",
    requestId: "child-request",
    sourceDigest: child.childPlanDigest,
  });
  mock.runOrganization
    .mockResolvedValueOnce({ status: "absent" })
    .mockResolvedValueOnce(null)
    .mockResolvedValue({ status: "applied" });
  const response = await request(
    { ...common, action: "native-target-auth-only-entry", input: child },
    true,
    ports,
  );
  expect(await response.json()).toEqual({
    childOperationRef: child.childOperationRef,
    childPlanDigest: child.childPlanDigest,
    effect: child.effect,
    status: "prepared",
  });
  expect(mock.runOrganization.mock.calls.map(([, worker]) => worker.readbackOnly === true)).toEqual(
    [true, false, true],
  );
  expect(mock.runSignupPolicy).not.toHaveBeenCalled();
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway"]);
});

it("requires the independently observed organization before the signup child can write", async () => {
  await startOwnerPending();
  let policyApplied = false;
  const ports = childAuthority(true, () => policyApplied);
  const organization = await planChild(ports);
  const signupResponse = await request(
    {
      ...common,
      action: "native-target-auth-only-entry-plan",
      input: { ...childRequest, effect: "signup-policy" },
    },
    true,
    ports,
  );
  const signup = nativeTargetAuthOnlyEntryApprovalInputSchema.parse(await signupResponse.json());
  expect(JSON.stringify(signup)).not.toContain("private-pilot");
  mock.readEntryApproval.mockImplementation(async ({ approvalInput }) => ({
    ...deliveryApproval,
    callId: `call-${approvalInput.effect}`,
    requestId: `request-${approvalInput.effect}`,
    sourceDigest: approvalInput.childPlanDigest,
  }));
  const runSignup = async () =>
    request(
      {
        ...common,
        action: "native-target-auth-only-entry",
        input: signup,
      },
      true,
      ports,
    );
  await expect(runSignup()).rejects.toThrow("authorization_required");
  expect(mock.runOrganization).not.toHaveBeenCalled();
  expect(mock.runSignupPolicy).not.toHaveBeenCalled();

  mock.runOrganization.mockResolvedValue({ status: "applied" });
  await request(
    { ...common, action: "native-target-auth-only-entry", input: organization },
    true,
    ports,
  );
  const attestation = createHash("sha256")
    .update(JSON.stringify({ appId, organizationId: "pilot-org", policyDigest }))
    .digest("hex");
  mock.runSignupPolicy.mockImplementation(async (_sandbox, worker) => {
    if (worker.readbackOnly === true) {
      return { readback_sha256: attestation, status: "applied" };
    }
    policyApplied = true;
    return null;
  });
  expect(await (await runSignup()).json()).toEqual({
    childOperationRef: signup.childOperationRef,
    childPlanDigest: signup.childPlanDigest,
    effect: "signup-policy",
    status: "prepared",
  });
  expect(mock.runOrganization.mock.calls.every(([, worker]) => worker.readbackOnly === true)).toBe(
    true,
  );
  expect(mock.runSignupPolicy.mock.calls.map(([, worker]) => worker.readbackOnly === true)).toEqual(
    [false, true],
  );
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway"]);
});

it("keeps a competing child request outside the saved delivery lease", async () => {
  await startOwnerPending();
  const ports = childAuthority(true);
  const child = await planChild(ports);
  mock.readEntryApproval.mockResolvedValue({
    ...deliveryApproval,
    callId: "original-child-call",
    requestId: "child-request",
    sourceDigest: child.childPlanDigest,
  });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  mock.runOrganization.mockImplementationOnce(async () => {
    entered.resolve();
    await resume.promise;
    return { status: "applied" };
  });
  const run = async () =>
    request({ ...common, action: "native-target-auth-only-entry", input: child }, true, ports);
  const first = run();
  await entered.promise;
  try {
    await expect(run()).rejects.toThrow("reconciliation_required");
    expect(mock.runOrganization).toHaveBeenCalledOnce();
  } finally {
    resume.resolve();
  }
  expect((await first).ok).toBe(true);
  expect(await planChild(ports)).toEqual(child);
});

const routingAuthority = (): NativeTargetAuthOnlyFinalRoutingAuthority => ({
  assertCatalogApp: async (value) => {
    await value.environment.assertCurrent();
  },
  preparePlan: async (value) => routePlanBytes(value),
  withGatewayLease: async (value, run) => {
    await value.environment.assertCurrent();
    const snapshot = await value.readCurrentFence();
    return await run(async () => {
      expect(await value.readCurrentFence()).toEqual(snapshot);
    });
  },
});
const startRoutingPending = async () => {
  await planRequest();
  return await (
    await request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput })
  ).json();
};
const approveRouting = () =>
  mock.readRoutingApproval.mockImplementation(async (input) => {
    await input.assertOwner();
    return {
      ...deliveryApproval,
      callId: "routing-call",
      planDigest: input.approvalInput.routingPlanDigest,
      requestId: "routing-approval",
      sourceDigest: input.approvalInput.routingPlanDigest,
    };
  });
const routingRecord = () =>
  [...rows.values()].find(
    (row) => (row.record as { kind?: string }).kind === "native-target-auth-only-delivery",
  )!;
const mountSuccessfulRouting = () =>
  mock.runRouting.mockImplementation(async (deps, input) => {
    await input.assertCurrent();
    const retained = await deps.store.read();
    const plan = JSON.parse(input.routingPlanBytes.toString());
    expect(await deps.readRetainedParent()).toEqual({ app: plan.app, bootstrap: plan.bootstrap });
    await deps.assertCatalogApp(input.projection);
    const gateway = {
      ...plan.bootstrap,
      deploymentId: "dpl-final-gateway",
      operationRef: plan.operationRef,
      origin: "https://final-gateway.vercel.app",
    };
    await deps.store.compareAndSet(retained.revision, {
      ...retained.record,
      projectionAttempt: plan.projection,
      refreshAttempted: true,
      refreshCandidates: [gateway],
      refreshReceipt: gateway,
    });
    await input.assertCurrent();
    return {
      app: plan.app,
      gateway,
      projectionDigest: plan.projection.nextSha256,
      status: "prepared",
    };
  });
it("normal delivery retains one digest-only routing invitation and final plan/approval reads never revisit bootstrap", async () => {
  mock.readRoutingApproval.mockResolvedValue(null);
  const initial = await startRoutingPending();
  expect(initial.status).toBe("routing-required");
  expect(JSON.stringify(initial)).not.toContain("base64");
  const original = structuredClone(routingRecord());
  expect((original.record as { phase: string }).phase).toBe("routing-pending");
  const plan = await (
    await request({
      ...common,
      action: "native-target-auth-only-final-routing-plan",
      input: { appId, deliveryPlanDigest, operationRef },
    })
  ).json();
  expect(plan).toEqual(initial.finalRoutingPlan);
  expect(
    await (
      await request({
        ...common,
        action: "native-target-auth-only-final-routing-approval-read",
        input: plan,
      })
    ).json(),
  ).toEqual({ status: "pending" });
  await expect(
    request({ ...common, action: "native-target-auth-only-final-routing", input: plan }),
  ).rejects.toThrow("authorization_required");
  await expect(
    request({
      ...common,
      action: "native-target-auth-only-final-routing",
      input: { ...plan, routingOperationRef: "44444444-4444-4444-a444-444444444444" },
    }),
  ).rejects.toThrow("resource_mismatch");
  expect(mock.runRouting).not.toHaveBeenCalled();
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway", "app"]);
  expect(routingRecord()).toEqual(original);
});
it("mounts the separately approved routing coordinator, retains final receipt, and normal prepared replay preserves bootstrap", async () => {
  const initial = await startRoutingPending();
  approveRouting();
  mountSuccessfulRouting();
  const authority = routingAuthority();
  const execute = await (
    await request(
      {
        ...common,
        action: "native-target-auth-only-final-routing",
        input: initial.finalRoutingPlan,
      },
      true,
      undefined,
      authority,
    )
  ).json();
  expect(execute).toMatchObject({
    deliveryPlanDigest,
    gateway: {
      deploymentId: "dpl-final-gateway",
      operationRef: initial.finalRoutingPlan.routingOperationRef,
    },
    status: "prepared",
  });
  expect((routingRecord().record as { phase: string }).phase).toBe("prepared");
  expect(
    (routingRecord().record as { gateway: { receipt: { deploymentId: string } } }).gateway.receipt
      .deploymentId,
  ).toBe("dpl-gateway");
  const replay = await (
    await request(
      { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
      true,
      undefined,
      authority,
    )
  ).json();
  expect(replay).toEqual({ ...execute, finalRoutingPlan: initial.finalRoutingPlan });
  expect(mock.runRouting).toHaveBeenCalledTimes(2);
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway", "app"]);
  mock.readRoutingApproval.mockResolvedValue({ ...deliveryApproval, outcome: "cancelled" });
  await expect(
    request(
      { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
      true,
      undefined,
      authority,
    ),
  ).rejects.toThrow("authorization_required");
  expect(mock.runRouting).toHaveBeenCalledTimes(2);
});
it.each(["unknown-final", "running-final"])(
  "normal %s recovery reconciles the retained final plan without original provider loop",
  async (phase) => {
    const initial = await startRoutingPending();
    approveRouting();
    mock.runRouting.mockRejectedValueOnce(new Error("lost final provider response"));
    const authority = routingAuthority();
    await expect(
      request(
        {
          ...common,
          action: "native-target-auth-only-final-routing",
          input: initial.finalRoutingPlan,
        },
        true,
        undefined,
        authority,
      ),
    ).rejects.toThrow("lost final provider response");
    expect((routingRecord().record as { phase: string }).phase).toBe("unknown-final");
    const row = routingRecord();
    const record = row.record as { phase: string; lease?: { id: string; expiresAt: string } };
    record.phase = phase;
    if (phase === "running-final") {
      record.lease = {
        id: "55555555-5555-4555-a555-555555555555",
        expiresAt: "2020-01-01T00:00:00.000Z",
      };
    }
    mountSuccessfulRouting();
    expect(
      await (
        await request(
          { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
          true,
          undefined,
          authority,
        )
      ).json(),
    ).toMatchObject({ status: "prepared" });
    expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway", "app"]);
    const { calls } = mock.runRouting.mock;
    expect(calls[0][1].routingPlanBytes.equals(calls[1][1].routingPlanBytes)).toBe(true);
    expect(calls[0][1].approval).toEqual(calls[1][1].approval);
  },
);
