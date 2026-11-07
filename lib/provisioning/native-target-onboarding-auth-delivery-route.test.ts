import { nativeTargetAuthOnlyFinalRoutingPlanSchema } from "./native-target-auth-only-final-routing";
import { nativeTargetAuthOnlyFinalRoutingApprovalInputSchema } from "../eve/private-native-target-auth-only-final-routing-approval";
import {
  nativeTargetAuthOnlyDeliveryResultSchema,
  nativeTargetAuthOnlyFinalRoutingResultSchema,
} from "./native-target-onboarding-transport";
import { drizzle } from "drizzle-orm/postgres-js";
import { z } from "zod";
import { appDescriptionSchema } from "../repository/app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyDispatch from "./native-target-auth-only-dispatch";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyPlanStore from "./native-target-auth-only-plan-store";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyResourcePlanStore from "./native-target-auth-only-resource-plan-store";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyRegistration from "./native-target-auth-only-registration";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleCapturedAppDescription from "./captured-app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorAuthOnlyRuntime from "./hosted-operator-auth-only-runtime";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePrivateNativeTargetAuthOnlyDeliveryApproval from "../eve/private-native-target-auth-only-delivery-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePrivateNativeTargetAuthOnlyEntryApproval from "../eve/private-native-target-auth-only-entry-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePrivateNativeTargetAuthOnlyFinalRoutingApproval from "../eve/private-native-target-auth-only-final-routing-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyFinalRouting from "./native-target-auth-only-final-routing";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorSandboxLauncher from "./hosted-operator-sandbox-launcher";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleVercelInstallation from "../integrations/vercel-installation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetOnboardingService from "./native-target-onboarding-service";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyPreviewDelivery from "./native-target-auth-only-preview-delivery";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePostgresVercelInstallation from "../integrations/postgres-vercel-installation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetVercelProvider from "./native-target-vercel-provider";
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
  nativeTargetAuthOnlyDeliveryPlanSchema,
} from "./native-target-auth-only-delivery-plan";
import { hostedOperatorSourceConfigurationSchema } from "./hosted-operator-source-configuration-schema";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-maintenance";
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

const readBody = async (response: Promise<Response>) => {
  const resolved = await response;
  return z.json().parse(await resolved.json());
};

const mock = vi.hoisted(() => ({
  environment:
    vi.fn<
      NonNullable<
        Parameters<typeof createNativeTargetOnboardingDeployment>[0]["authOnlyDeliveryEnvironment"]
      >
    >(),
  gate: vi.fn<
    NonNullable<
      Parameters<typeof createNativeTargetOnboardingDeployment>[0]["authOnlyAfterGatewayReady"]
    >
  >(),
  genericService:
    vi.fn<
      ReturnType<typeof ModuleNativeTargetOnboardingService.createNativeTargetOnboardingService>
    >(),
  readApproval:
    vi.fn<
      typeof ModulePrivateNativeTargetAuthOnlyDeliveryApproval.readPrivateNativeTargetAuthOnlyDeliveryApproval
    >(),
  readDescription:
    vi.fn<
      ReturnType<typeof ModuleCapturedAppDescription.createCapturedAppDescriptionStore>["read"]
    >(),
  readDispatch:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyDispatch.createPostgresNativeTargetAuthOnlyDispatchStore
      >["read"]
    >(),
  readEntryApproval:
    vi.fn<
      typeof ModulePrivateNativeTargetAuthOnlyEntryApproval.readPrivateNativeTargetAuthOnlyEntryApproval
    >(),
  readPlan:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyPlanStore.createNativeTargetAuthOnlyPlanStore
      >["read"]
    >(),
  readPublishedSource:
    vi.fn<typeof ModuleHostedOperatorAuthOnlyRuntime.readNativeTargetAuthOnlyPublishedSource>(),
  readResource:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyResourcePlanStore.createNativeTargetAuthOnlyResourcePlanStore
      >["read"]
    >(),
  readRoutingApproval:
    vi.fn<
      typeof ModulePrivateNativeTargetAuthOnlyFinalRoutingApproval.readPrivateNativeTargetAuthOnlyFinalRoutingApproval
    >(),
  readRuntime:
    vi.fn<
      ReturnType<
        typeof ModuleHostedOperatorAuthOnlyRuntime.createPostgresNativeTargetAuthOnlyRuntimeStore
      >["read"]
    >(),
  reconcile:
    vi.fn<
      (
        target: "gateway" | "app",
        context: NativeTargetAuthOnlyPreviewDeliveryInput,
      ) => ReturnType<
        ReturnType<
          typeof ModuleNativeTargetAuthOnlyPreviewDelivery.createNativeTargetAuthOnlyPreviewDelivery
        >["reconcile"]
      >
    >(),
  resolveRegistered:
    vi.fn<typeof ModuleNativeTargetAuthOnlyRegistration.resolveNativeTargetAuthOnlyRegistration>(),
  runOrganization: vi.fn<typeof ModuleHostedOperatorSandboxLauncher.runAuthOrganizationFileSpool>(),
  runRouting:
    vi.fn<
      (
        deps: Parameters<
          typeof ModuleNativeTargetAuthOnlyFinalRouting.createNativeTargetAuthOnlyFinalRouting
        >[0],
        input: Parameters<
          ReturnType<
            typeof ModuleNativeTargetAuthOnlyFinalRouting.createNativeTargetAuthOnlyFinalRouting
          >
        >[0],
      ) => ReturnType<
        ReturnType<
          typeof ModuleNativeTargetAuthOnlyFinalRouting.createNativeTargetAuthOnlyFinalRouting
        >
      >
    >(),
  runSignupPolicy: vi.fn<typeof ModuleHostedOperatorSandboxLauncher.runAuthSignupPolicyFileSpool>(),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply persisted project-dispatch state; the real route still checks its plan and owner.
vi.mock("./native-target-auth-only-dispatch", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyDispatch>()),
  createPostgresNativeTargetAuthOnlyDispatchStore: () => ({ read: mock.readDispatch }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the retained plan from private persistence; preserve real route digest comparisons.
vi.mock("./native-target-auth-only-plan-store", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyPlanStore>()),
  createNativeTargetAuthOnlyPlanStore: () => ({ read: mock.readPlan }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply exact private resource bytes; exercise the real route mismatch and approval checks.
vi.mock("./native-target-auth-only-resource-plan-store", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyResourcePlanStore>()),
  createNativeTargetAuthOnlyResourcePlanStore: () => ({ read: mock.readResource }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply deployment-owned registration; the unrelated-project case exercises the real route guard.
vi.mock("./native-target-auth-only-registration", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyRegistration>()),
  resolveNativeTargetAuthOnlyRegistration: mock.resolveRegistered,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the captured description from private artifact storage; keep real static-app validation.
vi.mock("./captured-app-description", async (original) => ({
  ...(await original<typeof ModuleCapturedAppDescription>()),
  createCapturedAppDescriptionStore: () => ({ read: mock.readDescription }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Isolate retained source/runtime reads; keep the real Auth-only runtime and route implementations.
vi.mock("./hosted-operator-auth-only-runtime", async (original) => ({
  ...(await original<typeof ModuleHostedOperatorAuthOnlyRuntime>()),
  createPostgresNativeTargetAuthOnlyRuntimeStore: () => ({ read: mock.readRuntime }),
  readNativeTargetAuthOnlyPublishedSource: mock.readPublishedSource,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control private history approval observations; the real route must deny missing approval.
vi.mock("../eve/private-native-target-auth-only-delivery-approval", async (original) => ({
  ...(await original<typeof ModulePrivateNativeTargetAuthOnlyDeliveryApproval>()),
  readPrivateNativeTargetAuthOnlyDeliveryApproval: mock.readApproval,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control independently observed child approvals; retain real child plan and parent-lease checks.
vi.mock("../eve/private-native-target-auth-only-entry-approval", async (original) => ({
  ...(await original<typeof ModulePrivateNativeTargetAuthOnlyEntryApproval>()),
  readPrivateNativeTargetAuthOnlyEntryApproval: mock.readEntryApproval,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control private final-routing approval observations; preserve normal replay denial and digest checks.
vi.mock("../eve/private-native-target-auth-only-final-routing-approval", async (original) => ({
  ...(await original<typeof ModulePrivateNativeTargetAuthOnlyFinalRoutingApproval>()),
  readPrivateNativeTargetAuthOnlyFinalRoutingApproval: mock.readRoutingApproval,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Isolate provider refresh execution; assert real route receipt retention and uncertain replay with identical bytes.
vi.mock("./native-target-auth-only-final-routing", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyFinalRouting>()),
  createNativeTargetAuthOnlyFinalRouting:
    (
      deps: Parameters<
        typeof ModuleNativeTargetAuthOnlyFinalRouting.createNativeTargetAuthOnlyFinalRouting
      >[0],
    ) =>
    (
      value: Parameters<
        ReturnType<
          typeof ModuleNativeTargetAuthOnlyFinalRouting.createNativeTargetAuthOnlyFinalRouting
        >
      >[0],
    ) =>
      mock.runRouting(deps, value),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Replace external worker transport with typed readback/checkpoint fixtures; retain real route dispatch ordering.
vi.mock("./hosted-operator-sandbox-launcher", async (original) => ({
  ...(await original<typeof ModuleHostedOperatorSandboxLauncher>()),
  runAuthOrganizationFileSpool: mock.runOrganization,
  runAuthSignupPolicyFileSpool: mock.runSignupPolicy,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Use fixture token-key custody; these route tests never read machine credentials.
vi.mock("../integrations/vercel-installation", async (original) => ({
  ...(await original<typeof ModuleVercelInstallation>()),
  readVercelTokenKeyringEnvironment: () => ({}),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Detect accidental fallback to the generic onboarding service from the real Auth-only route.
vi.mock("./native-target-onboarding-service", async (original) => ({
  ...(await original<typeof ModuleNativeTargetOnboardingService>()),
  createNativeTargetOnboardingService: () => mock.genericService,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Reconcile controlled provider candidates while enforcing the real route owner and environment callbacks.
vi.mock("./native-target-auth-only-preview-delivery", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyPreviewDelivery>()),
  createNativeTargetAuthOnlyPreviewDelivery: (deps: {
    target: "gateway" | "app";
    assertEnvironment: () => Promise<void>;
  }) => ({
    deliver: () => Promise.reject(new Error("unexpected provider create")),
    reconcile: async (context: NativeTargetAuthOnlyPreviewDeliveryInput) => {
      await context.assertCurrent();
      await deps.assertEnvironment();
      return await mock.reconcile(deps.target, context);
    },
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply a controlled installation grant without reading private token storage.
vi.mock("../integrations/postgres-vercel-installation", async (original) => ({
  ...(await original<typeof ModulePostgresVercelInstallation>()),
  readActiveVercelInstallationToken: () =>
    Promise.resolve({
      binding: { active: true, scopeId: "team-fixture", scopeType: "team" },
      token: "fixture-token",
    }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply verified project metadata at the external provider boundary; route ownership remains real.
vi.mock("./native-target-vercel-provider", async (original) => ({
  ...(await original<typeof ModuleNativeTargetVercelProvider>()),
  observeNativeTargetVercelProject: () => Promise.resolve({ status: "verified" }),
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
const description = appDescriptionSchema.parse({
  app: { id: appId, routes: ["/"], workspacePath: `apps/${appId}` },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: { browser: null, check: { task: "mise run app:check signup-pilot" }, test: null },
  version: 1,
});
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
    workload: {
      audience: "https://vercel.com/fixture",
      environment: "preview",
      issuer: "https://oidc.vercel.com/fixture",
      ownerId: teamId,
      projectId: "gateway-fixture",
      subject: "gateway",
    },
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
const plan = planNativeTargetAuthOnly({
  authAuthorityBinding: {
    authDatabase,
    gateway: {
      authBrowserOrigin: profile.gateway.authBrowserOrigin,
      branch: profile.gateway.branch,
      environment: profile.gateway.environment,
      gatewayOrigin: profile.gateway.gatewayOrigin,
      projectId: profile.gateway.projectId,
      publicOrigin: profile.gateway.publicOrigin,
      workload: profile.gateway.workload,
    },
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
const selected = hostedOperatorSourceConfigurationSchema.parse({
  ...profile,
  applications: {},
  authOnlyApplications: {
    [appId]: {
      accessRoles: ["pilot_user"],
      registration: {
        ...registration,
        projectSettings: plan.project.projectSettings,
        planDigest,
        authResource: plan.authResource,
        appRole: plan.appRole,
      },
    },
  },
  builderCallbackOrigin: "https://builder.example",
  catalogAppIds: [appId],
  gateway: {
    ...profile.gateway,
    gitSha: "8".repeat(40),
    repoId: "gateway-repo",
    protectedApplicationIds: [appId],
    workload: {
      ...profile.nativeNeon.configuration.operator,
      projectId: profile.gateway.projectId,
      subject: "gateway",
    },
  },
  operator: { ...profile.operator, deploymentId: "dpl-operator" },
  sandbox: {
    image: "fixture",
    projectId: profile.operator.projectId,
    teamId,
    workers: {},
    authProposal: {
      executablePath: "/fixture/proposal",
      id: "auth-proposal",
      sha256: "6".repeat(64),
    },
    accessWorker: {
      executablePath: "/fixture/access",
      id: "access-worker",
      operationScope: "generated-app-access-v1",
      subcommand: "protected-generated-app-access",
      sha256: "7".repeat(64),
    },
    authWorker: {
      ...profile.sandbox.authWorker,
      executablePath: "/fixture/auth",
      operationScope: "auth-protected-schema-v1",
      subcommand: "auth-protected-schema",
    },
    resourcesWorker: {
      ...profile.sandbox.resourcesWorker,
      executablePath: "/fixture/resources",
      operationScope: "neon-resource-bootstrap-v1",
      subcommand: "neon-resource-bootstrap",
    },
  },
  workloadPolicy: { ...profile.nativeNeon.configuration.operator, subject: "operator" },
});

const operationRef = nativeTargetAuthOnlyCredentialOperationRef(plan);
const workerReadback = (status: "absent" | "applied") => ({
  version: 1 as const,
  operation_id: operationRef,
  context_digest: "6".repeat(64),
  fence_generation: 1,
  status,
  readback_sha256: "7".repeat(64),
});

const resourceBytes = buildNativeTargetAuthOnlyResourcePlanBytes({ plan, registration, selected });
const resourcePlanDigest = nativeTargetAuthOnlyResourcePlanDigest(resourceBytes);
const resourcePlan = nativeTargetAuthOnlyResourceApprovalPlanSchema.parse(
  JSON.parse(resourceBytes.toString("utf-8")),
);
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
  deliveryPlan: nativeTargetAuthOnlyDeliveryPlanSchema.parse(
    JSON.parse(deliveryBytes.toString("utf-8")),
  ),
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
const journalDatabase = {
  insert: () => ({
    values: (row: JournalRow) => ({
      onConflictDoNothing: () => {
        expect(row.requestId).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
        );
        expect(["pending", "settled"]).toContain(row.state);
        if (!rows.has(row.requestId)) {
          rows.set(row.requestId, structuredClone(row));
        }
        return Promise.resolve();
      },
    }),
  }),
  select: () => ({
    from: () => ({
      where: (where: SQL) => ({
        limit: () => {
          const row = rows.get(String(params(where)[4]));
          return Promise.resolve(row === undefined ? [] : [structuredClone(row)]);
        },
      }),
    }),
  }),
  update: () => ({
    set: (change: Partial<JournalRow>) => ({
      where: (where: SQL) => ({
        returning: () => {
          const values = params(where);
          const row = rows.get(String(values[4]));
          if (row === undefined || row.revision !== values[5] || row.requestDigest !== values[6]) {
            return Promise.resolve([]);
          }
          const next = { ...row, ...change };
          rows.set(row.requestId, structuredClone(next));
          return Promise.resolve([structuredClone(next)]);
        },
      }),
    }),
  }),
};
const mockDatabase: Parameters<typeof createNativeTargetOnboardingDeployment>[0]["database"] =
  drizzle.mock();
const database = Object.assign(mockDatabase, journalDatabase);
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
    configuration: selected,
    database,
    environment: {},
    owner: {
      assertCanonicalAppOwner,
      assertNoStandardBuilderDestination: () => Promise.resolve(),
      verifyWorkload,
    },
    ...(ports
      ? {
          authOnlyAfterGatewayReady: async (value: NativeTargetAuthOnlyAfterGatewayReadyInput) =>
            await mock.gate(value),
          authOnlyDeliveryEnvironment: async (
            value: NativeTargetAuthOnlyDeliveryEnvironmentInput,
          ) => {
            await mock.environment(value);
          },
          authOnlyPrepareFinalRoutingPlan: (value) => Promise.resolve(routePlanBytes(value)),
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
  await request({
    ...common,
    action: "native-target-auth-only-delivery-plan",
    input: { appId, operationRef, planDigest, resourcePlanDigest },
  });
beforeEach(() => {
  vi.resetAllMocks();
  rows.clear();
  mock.readDispatch.mockResolvedValue({
    revision: 1,
    state: {
      kind: "native-target-auth-only-dispatch",
      version: 1,
      approval: schemaApproval,
      plan,
      planDigest,
      projectId: registration.projectId,
      stage: "created",
    },
  });
  mock.readPlan.mockResolvedValue(plan);
  mock.readResource.mockResolvedValue({
    bytes: resourceBytes,
    plan: resourcePlan,
    revision: 1,
    workerContexts: {},
  });
  mock.resolveRegistered.mockResolvedValue(selected);
  mock.readDescription.mockResolvedValue(description);
  mock.readPublishedSource.mockResolvedValue(source);
  mock.readRuntime.mockResolvedValue({
    revision: 1,
    state: {
      kind: "native-target-auth-only-runtime",
      version: 1,
      source,
      approval: schemaApproval,
      effectDigest: schemaApproval.sourceDigest,
      attemptId: "11111111-1111-4111-a111-111111111111",
      leaseId: "22222222-2222-4222-a222-222222222222",
      leaseExpiresAt: schemaApproval.observedAt,
      readiness: "catalog-readback",
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
      const deploymentSource =
        target === "gateway" ? context.plan.gatewayDelivery : context.plan.delivery;
      if (deploymentSource === undefined) {
        throw new Error("Expected approved deployment source");
      }
      const selectedCandidate = {
        branch: deploymentSource.branch,
        deploymentId: `dpl-${target}`,
        operationRef: context.operationRef,
        origin: `https://${target}.example`,
        projectId: deploymentSource.projectId,
        readyState: "READY",
        repoId: deploymentSource.repoId,
      };
      await context.checkpointDelivery([selectedCandidate]);
      return { candidates: [selectedCandidate], selected: selectedCandidate, status: "applied" };
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
    await readBody(
      request({
        ...common,
        action: "native-target-auth-only-delivery-approval-read",
        input: deliveryInput,
      }),
    ),
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
    authIdentityLinkExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    status: "pending-owner" as const,
  };
  mock.gate.mockResolvedValue(pending);
  expect(
    await readBody(
      request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }),
    ),
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
      const appRegistration = selected.authOnlyApplications?.[appId];
      if (appRegistration?.registration === undefined) {
        throw new Error("Expected app registration");
      }
      mock.resolveRegistered.mockResolvedValue({
        ...selected,
        authOnlyApplications: {
          [appId]: {
            ...appRegistration,
            registration: { ...appRegistration.registration, projectId: "unrelated" },
          },
        },
      });
    }
    if (kind === "resource") {
      // oxlint-disable-next-line unicorn/no-useless-undefined -- A missing typed store row is undefined, not Promise<void>.
      mock.readResource.mockResolvedValue(undefined);
    }
    if (kind === "runtime") {
      mock.readRuntime.mockResolvedValue({
        revision: 1,
        state: {
          kind: "native-target-auth-only-runtime",
          version: 1,
          source,
          plan,
          planDigest,
          approval: schemaApproval,
          effectDigest: schemaApproval.sourceDigest,
          attemptId: "11111111-1111-4111-a111-111111111111",
          leaseId: "22222222-2222-4222-a222-222222222222",
          leaseExpiresAt: schemaApproval.observedAt,
          stage: "unknown",
        },
      });
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
  (value) => {
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
    return Promise.resolve({
      ownerLink: {
        prepare: () =>
          Promise.resolve({
            status: "linked",
            operationRef,
            sessionId: historyOwner.sessionId,
          }),
        readCaptured: () => Promise.resolve(consumed ? captured : undefined),
      },
      readCredentials: () => Promise.resolve({ migrationUrl: "private-migrator" }),
      readCurrentOwnerProof: () =>
        Promise.resolve({
          ...identity,
          reference: captured.proofRef,
          proof,
          oidcToken: "private-oidc",
        }),
      readOrganizationPlan: () =>
        Promise.resolve(
          authOnlyOrganizationPlanSchema.parse({
            version: 1,
            action: "prepare",
            authDatabase,
            neon: {
              ...binding.bootstrapResource.neon,
              endpoint: binding.bootstrapResource.hostname,
            },
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
              {
                kind: "auth-membership",
                id: "auth-membership",
                resourceId: authDatabase.resourceId,
              },
            ],
            membershipInstaller: {
              reference: "auth-owned-organization-v1",
              sha256: "f".repeat(64),
            },
          }),
        ),
      readReadyBinding: () =>
        Promise.resolve({
          binding,
          sandbox: { image: "fixture", teamId, projectId: "operator-fixture", workers: {} },
        }),
      readSignupPolicy: () =>
        Promise.resolve(
          policyApplied() ? { status: "applied", policyDigest } : { status: "absent" },
        ),
      readSignupPolicyPlan: (_scope, organizationId) =>
        Promise.resolve(
          authOnlySignupPolicyPlanSchema.parse({
            version: 1,
            action: "prepare",
            authDatabase,
            neon: {
              ...binding.bootstrapResource.neon,
              endpoint: binding.bootstrapResource.hostname,
            },
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
        ),
    });
  };
const planChild = async (ports: NativeTargetAuthOnlyEntryAuthority) =>
  nativeTargetAuthOnlyEntryApprovalInputSchema.parse(
    await readBody(
      request(
        { ...common, action: "native-target-auth-only-entry-plan", input: childRequest },
        true,
        ports,
      ),
    ),
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
    .mockResolvedValueOnce(workerReadback("absent"))
    .mockResolvedValueOnce(null)
    .mockResolvedValue(workerReadback("applied"));
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
  mock.readEntryApproval.mockImplementation(({ approvalInput }) =>
    Promise.resolve({
      ...deliveryApproval,
      callId: `call-${approvalInput.effect}`,
      requestId: `request-${approvalInput.effect}`,
      sourceDigest: approvalInput.childPlanDigest,
    }),
  );
  const runSignup = async () =>
    await request(
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

  mock.runOrganization.mockResolvedValue(workerReadback("applied"));
  await request(
    { ...common, action: "native-target-auth-only-entry", input: organization },
    true,
    ports,
  );
  const attestation = createHash("sha256")
    .update(JSON.stringify({ appId, organizationId: "pilot-org", policyDigest }))
    .digest("hex");
  mock.runSignupPolicy.mockImplementation((_sandbox, worker) => {
    if (worker.readbackOnly === true) {
      return Promise.resolve({ ...workerReadback("applied"), readback_sha256: attestation });
    }
    policyApplied = true;
    return Promise.resolve(null);
  });
  expect(await readBody(runSignup())).toEqual({
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
  const entered = Promise.withResolvers<null>();
  const resume = Promise.withResolvers<null>();
  mock.runOrganization.mockImplementationOnce(async () => {
    entered.resolve(null);
    await resume.promise;
    return workerReadback("applied");
  });
  const run = async () =>
    await request(
      { ...common, action: "native-target-auth-only-entry", input: child },
      true,
      ports,
    );
  const first = run();
  await entered.promise;
  try {
    await expect(run()).rejects.toThrow("reconciliation_required");
    expect(mock.runOrganization).toHaveBeenCalledOnce();
  } finally {
    resume.resolve(null);
  }
  const firstResponse = await first;
  expect(firstResponse.ok).toBe(true);
  expect(await planChild(ports)).toEqual(child);
});

const routingAuthority = (): NativeTargetAuthOnlyFinalRoutingAuthority => ({
  assertCatalogApp: async (value) => {
    await value.environment.assertCurrent();
  },
  preparePlan: (value) => Promise.resolve(routePlanBytes(value)),
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
  const body = nativeTargetAuthOnlyDeliveryResultSchema.parse(
    await readBody(
      request({ ...common, action: "native-target-auth-only-delivery", input: deliveryInput }),
    ),
  );
  if (body.status !== "routing-required") {
    throw new Error("Expected retained final routing invitation");
  }
  return body;
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
const routingRecordSchema = z.looseObject({
  kind: z.literal("native-target-auth-only-delivery"),
  phase: z.enum(["routing-pending", "prepared", "unknown-final", "running-final"]),
  lease: z.object({ id: z.uuid(), expiresAt: z.iso.datetime() }).optional(),
  gateway: z.looseObject({ receipt: z.looseObject({ deploymentId: z.string() }) }),
});
const routingRecord = () => {
  const row = [...rows.values()].find(
    (entry) => routingRecordSchema.safeParse(entry.record).success,
  );
  if (row === undefined) {
    throw new Error("Expected a retained delivery journal");
  }
  return { ...row, record: routingRecordSchema.parse(row.record) };
};
const mountSuccessfulRouting = () =>
  mock.runRouting.mockImplementation(async (deps, input) => {
    await input.assertCurrent();
    const retained = await deps.store.read();
    if (retained === undefined) {
      throw new Error("Expected retained routing plan");
    }
    const routingPlan = nativeTargetAuthOnlyFinalRoutingPlanSchema.parse(
      JSON.parse(input.routingPlanBytes.toString("utf-8")),
    );
    expect(await deps.readRetainedParent()).toEqual({
      app: routingPlan.app,
      bootstrap: routingPlan.bootstrap,
    });
    await deps.assertCatalogApp(input.projection);
    const gateway = {
      ...routingPlan.bootstrap,
      deploymentId: "dpl-final-gateway",
      operationRef: routingPlan.operationRef,
      origin: "https://final-gateway.vercel.app",
    };
    await deps.store.compareAndSet(retained.revision, {
      ...retained.record,
      projectionAttempt: routingPlan.projection,
      refreshAttempted: true,
      refreshCandidates: [gateway],
      refreshReceipt: gateway,
    });
    await input.assertCurrent();
    return {
      app: routingPlan.app,
      gateway,
      projectionDigest: routingPlan.projection.nextSha256,
      status: "prepared",
    };
  });
it("normal delivery retains one digest-only routing invitation and final plan/approval reads never revisit bootstrap", async () => {
  mock.readRoutingApproval.mockResolvedValue(null);
  const initial = await startRoutingPending();
  expect(initial.status).toBe("routing-required");
  expect(JSON.stringify(initial)).not.toContain("base64");
  const original = structuredClone(routingRecord());
  expect(original.record.phase).toBe("routing-pending");
  const routingInput = nativeTargetAuthOnlyFinalRoutingApprovalInputSchema.parse(
    await readBody(
      request({
        ...common,
        action: "native-target-auth-only-final-routing-plan",
        input: { appId, deliveryPlanDigest, operationRef },
      }),
    ),
  );
  expect(routingInput).toEqual(initial.finalRoutingPlan);
  expect(
    await readBody(
      request({
        ...common,
        action: "native-target-auth-only-final-routing-approval-read",
        input: routingInput,
      }),
    ),
  ).toEqual({ status: "pending" });
  await expect(
    request({ ...common, action: "native-target-auth-only-final-routing", input: routingInput }),
  ).rejects.toThrow("authorization_required");
  await expect(
    request({
      ...common,
      action: "native-target-auth-only-final-routing",
      input: { ...routingInput, routingOperationRef: "44444444-4444-4444-a444-444444444444" },
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
  const routingPorts = routingAuthority();
  const execute = nativeTargetAuthOnlyFinalRoutingResultSchema.parse(
    await readBody(
      request(
        {
          ...common,
          action: "native-target-auth-only-final-routing",
          input: initial.finalRoutingPlan,
        },
        true,
        undefined,
        routingPorts,
      ),
    ),
  );
  expect(execute).toMatchObject({
    deliveryPlanDigest,
    gateway: {
      deploymentId: "dpl-final-gateway",
      operationRef: initial.finalRoutingPlan.routingOperationRef,
    },
    status: "prepared",
  });
  expect(routingRecord().record.phase).toBe("prepared");
  expect(routingRecord().record.gateway.receipt.deploymentId).toBe("dpl-gateway");
  const replay = nativeTargetAuthOnlyDeliveryResultSchema.parse(
    await readBody(
      request(
        { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
        true,
        undefined,
        routingPorts,
      ),
    ),
  );
  expect(replay).toEqual({ ...execute, finalRoutingPlan: initial.finalRoutingPlan });
  expect(mock.runRouting).toHaveBeenCalledTimes(2);
  expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway", "app"]);
  mock.readRoutingApproval.mockResolvedValue({ ...deliveryApproval, outcome: "cancelled" });
  await expect(
    request(
      { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
      true,
      undefined,
      routingPorts,
    ),
  ).rejects.toThrow("authorization_required");
  expect(mock.runRouting).toHaveBeenCalledTimes(2);
});
it.each(["unknown-final", "running-final"] as const)(
  "normal %s recovery reconciles the retained final plan without original provider loop",
  async (phase) => {
    const initial = await startRoutingPending();
    approveRouting();
    mock.runRouting.mockRejectedValueOnce(new Error("lost final provider response"));
    const routingPorts = routingAuthority();
    await expect(
      request(
        {
          ...common,
          action: "native-target-auth-only-final-routing",
          input: initial.finalRoutingPlan,
        },
        true,
        undefined,
        routingPorts,
      ),
    ).rejects.toThrow("lost final provider response");
    expect(routingRecord().record.phase).toBe("unknown-final");
    const row = routingRecord();
    const record = row.record;
    record.phase = phase;
    if (phase === "running-final") {
      record.lease = {
        id: "55555555-5555-4555-a555-555555555555",
        expiresAt: "2020-01-01T00:00:00.000Z",
      };
    }
    rows.set(row.requestId, { ...row, record });
    mountSuccessfulRouting();
    expect(
      await readBody(
        request(
          { ...common, action: "native-target-auth-only-delivery", input: deliveryInput },
          true,
          undefined,
          routingPorts,
        ),
      ),
    ).toMatchObject({ status: "prepared" });
    expect(mock.reconcile.mock.calls.map(([target]) => target)).toEqual(["gateway", "app"]);
    const { calls } = mock.runRouting.mock;
    const originalCall = calls.at(0);
    const retryCall = calls.at(1);
    if (originalCall === undefined || retryCall === undefined) {
      throw new Error("Expected both final routing attempts");
    }
    expect(originalCall[1].routingPlanBytes.equals(retryCall[1].routingPlanBytes)).toBe(true);
    expect(originalCall[1].approval).toEqual(retryCall[1].approval);
  },
);
