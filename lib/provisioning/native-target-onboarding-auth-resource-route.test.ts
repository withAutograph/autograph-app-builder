import { drizzle } from "drizzle-orm/postgres-js";
import { appDescriptionSchema } from "../repository/app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyDispatch from "./native-target-auth-only-dispatch";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyPlanStore from "./native-target-auth-only-plan-store";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyResourcePlanStore from "./native-target-auth-only-resource-plan-store";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePrivateNativeTargetAuthOnlyResourceApproval from "../eve/private-native-target-auth-only-resource-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModulePrivateNativeTargetAuthOnlyApproval from "../eve/private-native-target-auth-only-approval";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetConfigurationResolver from "./native-target-configuration-resolver";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetResourceProfile from "./native-target-resource-profile";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleCapturedAppDescription from "./captured-app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorAuthOnlyRuntime from "./hosted-operator-auth-only-runtime";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorArtifacts from "./hosted-operator-artifacts";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyMaintenance from "./native-target-auth-only-maintenance";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetAuthOnlyCredentialStore from "./native-target-auth-only-credential-store";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorAuthReadiness from "./hosted-operator-auth-readiness";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleHostedOperatorSandboxLauncher from "./hosted-operator-sandbox-launcher";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleVercelInstallation from "../integrations/vercel-installation";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Type the partial boundary mock against every real module export.
import type * as ModuleNativeTargetOnboardingService from "./native-target-onboarding-service";
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
import { hostedOperatorSourceConfigurationSchema } from "./hosted-operator-source-configuration-schema";
import { nativeTargetAuthOnlyResourceApprovalPlanSchema } from "./native-target-auth-only-maintenance";
import type { NativeTargetRequest } from "./native-target-onboarding-transport";

const mock = vi.hoisted(() => ({
  findReference:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyCredentialStore.createNativeTargetAuthOnlyCredentialCustody
      >["findReference"]
    >(),
  genericService:
    vi.fn<
      ReturnType<typeof ModuleNativeTargetOnboardingService.createNativeTargetOnboardingService>
    >(),
  readArtifact:
    vi.fn<
      ReturnType<
        typeof ModuleHostedOperatorArtifacts.createOperatorArtifactPublication
      >["readAuthPlan"]
    >(),
  readCredentials:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyCredentialStore.createNativeTargetAuthOnlyCredentialCustody
      >["read"]
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
  readResourceApproval:
    vi.fn<
      typeof ModulePrivateNativeTargetAuthOnlyResourceApproval.readPrivateNativeTargetAuthOnlyResourceApproval
    >(),
  readSchemaApproval:
    vi.fn<
      typeof ModulePrivateNativeTargetAuthOnlyApproval.readPrivateNativeTargetAuthOnlyApproval
    >(),
  readSecrets:
    vi.fn<
      ReturnType<
        typeof ModuleNativeTargetAuthOnlyCredentialStore.createNativeTargetAuthOnlyCredentialCustody
      >["readSecrets"]
    >(),
  resolveProfile:
    vi.fn<typeof ModuleNativeTargetResourceProfile.resolveNativeTargetResourceProfile>(),
  resolveRegistered:
    vi.fn<typeof ModuleNativeTargetConfigurationResolver.resolveNativeTargetAuthOnlyRegistration>(),
  runResources: vi.fn<typeof ModuleHostedOperatorSandboxLauncher.runAuthResourceFileSpool>(),
  runSchema: vi.fn<typeof ModuleHostedOperatorSandboxLauncher.runAuthSchemaFileSpool>(),
  runtimeStore:
    vi.fn<
      typeof ModuleHostedOperatorAuthOnlyRuntime.createPostgresNativeTargetAuthOnlyRuntimeStore
    >(),
  seal: vi.fn<
    ReturnType<
      typeof ModuleNativeTargetAuthOnlyCredentialStore.createNativeTargetAuthOnlyCredentialCustody
    >["seal"]
  >(),
  verifyReadiness:
    vi.fn<
      ReturnType<
        typeof ModuleHostedOperatorAuthReadiness.createHostedOperatorAuthReadiness
      >["verify"]
    >(),
}));

// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply persisted project-dispatch state; the real route still checks its plan and owner.
vi.mock("./native-target-auth-only-dispatch", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleNativeTargetAuthOnlyDispatch>()),
  createPostgresNativeTargetAuthOnlyDispatchStore: () => ({ read: mock.readDispatch }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the retained plan from private persistence; preserve real route digest comparisons.
vi.mock("./native-target-auth-only-plan-store", async (original) => ({
  ...(await original<typeof ModuleNativeTargetAuthOnlyPlanStore>()),
  createNativeTargetAuthOnlyPlanStore: () => ({ read: mock.readPlan }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply exact private resource bytes; exercise the real route mismatch and approval checks.
vi.mock("./native-target-auth-only-resource-plan-store", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleNativeTargetAuthOnlyResourcePlanStore>()),
  createNativeTargetAuthOnlyResourcePlanStore: () => ({ read: mock.readResource }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Control private resource approval observations; assert rejection before credentials or worker dispatch.
vi.mock("../eve/private-native-target-auth-only-resource-approval", async (importOriginal) => ({
  ...(await importOriginal<typeof ModulePrivateNativeTargetAuthOnlyResourceApproval>()),
  readPrivateNativeTargetAuthOnlyResourceApproval: mock.readResourceApproval,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the original private project approval; verify the real retry route reads that approval.
vi.mock("../eve/private-native-target-auth-only-approval", async (original) => ({
  ...(await original<typeof ModulePrivateNativeTargetAuthOnlyApproval>()),
  readPrivateNativeTargetAuthOnlyApproval: mock.readSchemaApproval,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply deployment-owned registration; the unrelated-project case exercises the real route guard.
vi.mock("./native-target-configuration-resolver", async (original) => ({
  ...(await original<typeof ModuleNativeTargetConfigurationResolver>()),
  resolveNativeTargetAuthOnlyRegistration: mock.resolveRegistered,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the private Auth resource profile; preserve the real runtime authority-digest check.
vi.mock("./native-target-resource-profile", async (original) => ({
  ...(await original<typeof ModuleNativeTargetResourceProfile>()),
  resolveNativeTargetResourceProfile: mock.resolveProfile,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the captured description from private artifact storage; keep real static-app validation.
vi.mock("./captured-app-description", async (original) => ({
  ...(await original<typeof ModuleCapturedAppDescription>()),
  createCapturedAppDescriptionStore: () => ({ read: mock.readDescription }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Isolate retained source/runtime reads; keep the real Auth-only runtime and route implementations.
vi.mock("./hosted-operator-auth-only-runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleHostedOperatorAuthOnlyRuntime>()),
  createPostgresNativeTargetAuthOnlyRuntimeStore: mock.runtimeStore,
  readNativeTargetAuthOnlyPublishedSource: mock.readPublishedSource,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply the retained schema artifact from private storage; keep real runtime schema-selection checks.
vi.mock("./hosted-operator-artifacts", async (original) => ({
  ...(await original<typeof ModuleHostedOperatorArtifacts>()),
  createOperatorArtifactPublication: () => ({ readAuthPlan: mock.readArtifact }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Provide synthetic maintenance credential custody; no provider secret or live database is opened.
vi.mock("./native-target-auth-only-maintenance", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleNativeTargetAuthOnlyMaintenance>()),
  createNativeTargetAuthOnlyMaintenanceReader: () => ({
    withMaintenanceCredential: async <T>(
      consume: (material: { maintenanceUrl: string }) => Promise<T>,
    ): Promise<T> => await consume({ maintenanceUrl: "private-maintenance-url" }),
  }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Observe credential sealing and reuse across retries without accessing private credential storage.
vi.mock("./native-target-auth-only-credential-store", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleNativeTargetAuthOnlyCredentialStore>()),
  createNativeTargetAuthOnlyCredentialCustody: () => ({
    findReference: mock.findReference,
    seal: mock.seal,
    readSecrets: mock.readSecrets,
    read: mock.readCredentials,
  }),
  nativeTargetAuthOnlyCredentialContextForPlan: () => ({}),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Supply catalog readback from the database boundary; verify the real route waits for readiness.
vi.mock("./hosted-operator-auth-readiness", async (original) => ({
  ...(await original<typeof ModuleHostedOperatorAuthReadiness>()),
  createHostedOperatorAuthReadiness: () => ({ verify: mock.verifyReadiness }),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Replace external worker transport with typed readback/checkpoint fixtures; retain real route dispatch ordering.
vi.mock("./hosted-operator-sandbox-launcher", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleHostedOperatorSandboxLauncher>()),
  runAuthResourceFileSpool: mock.runResources,
  runAuthSchemaFileSpool: mock.runSchema,
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Use fixture token-key custody; these route tests never read machine credentials.
vi.mock("../integrations/vercel-installation", async (importOriginal) => ({
  ...(await importOriginal<typeof ModuleVercelInstallation>()),
  readVercelTokenKeyringEnvironment: () => ({}),
}));
// oxlint-disable-next-line anti-slop/no-module-mocking -- Detect accidental fallback to the generic onboarding service from the real Auth-only route.
vi.mock("./native-target-onboarding-service", async (original) => ({
  ...(await original<typeof ModuleNativeTargetOnboardingService>()),
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
    projectId: "gateway-fixture",
    publicOrigin: "https://apps.example",
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
const journalDatabase = {
  select: () => ({
    from: () => ({
      where: (where: SQL) => ({
        limit: () => {
          const row = journalRows.get(rowId(where));
          return Promise.resolve(row === undefined ? [] : [row]);
        },
      }),
    }),
  }),
  insert: () => ({
    values: (row: JournalRow) => ({
      onConflictDoNothing: () => {
        if (!journalRows.has(row.requestId)) {
          journalRows.set(row.requestId, row);
        }
        return Promise.resolve();
      },
    }),
  }),
  update: () => ({
    set: (update: Partial<JournalRow>) => ({
      where: (where: SQL) => ({
        returning: () => {
          const row = journalRows.get(rowId(where));
          if (row === undefined) {
            return Promise.resolve([]);
          }
          const next = { ...row, ...update };
          journalRows.set(row.requestId, next);
          return Promise.resolve([next]);
        },
      }),
    }),
  }),
};
const mockDatabase: Parameters<typeof createNativeTargetOnboardingDeployment>[0]["database"] =
  drizzle.mock();
const database = Object.assign(mockDatabase, journalDatabase);
const deploy = () =>
  createNativeTargetOnboardingDeployment({
    builderOrigin: "https://builder.example",
    configuration: selected,
    database,
    environment: {},
    owner: {
      assertCanonicalAppOwner,
      assertNoStandardBuilderDestination: () => Promise.resolve(),
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
  mock.seal.mockResolvedValue({
    kind: "auth-only-credentials",
    version: 1,
    contextDigest: "8".repeat(64),
    recordDigest: "9".repeat(64),
  });
  mock.readSecrets.mockResolvedValue({
    migratorPassword: "m".repeat(32),
    runtimePassword: "r".repeat(32),
  });
  mock.readCredentials.mockResolvedValue({
    migrationUrl: "private-migration-url",
    runtimeUrl: "private-runtime-url",
  });
  mock.verifyReadiness.mockResolvedValue({
    catalogFingerprint: "catalog-readback",
    assetSha256: "4".repeat(64),
    database: authDatabase.database,
    observedAt: schemaApproval.observedAt,
    runtimeRole: authDatabase.runtimeRole,
    targetDigest: authSchema.targetDigest,
  });
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
    compareAndSet: () => Promise.reject(new Error("unexpected CAS port")),
    read: () => Promise.resolve(row),
    write: (_key, revision, state) => {
      if (row?.revision !== revision) {
        return Promise.reject(new Error("unexpected revision"));
      }
      row = { revision: (revision ?? 0) + 1, state };
      return Promise.resolve(row);
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
      .mockResolvedValueOnce(workerReadback("absent"))
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(workerReadback("applied"));
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
    const workerAttemptMatcher: unknown = expect.any(String);
    expect(mock.runSchema).toHaveBeenCalledWith(
      selected.sandbox,
      expect.objectContaining({
        approvalDigest: resourcePlanDigest,
        approvedPlanBytes: resourceBytes,
        fenceGeneration: 3,
        operationRef,
        workerAttemptId: workerAttemptMatcher,
      }),
    );
    expect(mock.verifyReadiness).toHaveBeenCalledOnce();
    expect(mock.genericService).not.toHaveBeenCalled();
  });
  it("reconciles a lost schema response without replaying the workers or rotating credentials", async () => {
    mock.runResources.mockResolvedValue(workerReadback("applied"));
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
    mock.findReference.mockResolvedValue({
      kind: "auth-only-credentials",
      version: 1,
      contextDigest: "8".repeat(64),
      recordDigest: "9".repeat(64),
    });
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
