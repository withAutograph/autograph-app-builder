import { afterEach, describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import {
  privateHostedApprovalReceiptSchema,
  readPrivateHostedApproval,
} from "../eve/private-hosted-approval";
import type { PrivateHostedApprovalReceipt } from "../eve/private-hosted-approval";
import { publicApprovalDescription } from "../agent/approval-receipt";
import { createHash } from "node:crypto";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import {
  inspectParticipantBootstrapPreparation,
  inspectPlanningParticipantBootstrap,
} from "./hosted-operator-participant-bootstrap";
import { configuredBootstrapGatewayBindings } from "./hosted-operator-existing-auth-bootstrap";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type {
  ProtectedHostedOperatorDependencies,
  HostedOperatorContext,
  HostedOperatorDeploymentContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
} from "./hosted-operator-service";
import nativeEntryPoint from "./hosted-operator-function";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused read-only reconciliation boundary spy.
import * as authReadiness from "./hosted-operator-auth-readiness";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused planning boundary spies.
import * as authProposal from "./hosted-operator-auth-proposal";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused planning boundary spies.
import * as planningAuthority from "./hosted-operator-planning-authority";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused planning boundary spies.
import * as nativePlanning from "./hosted-operator-native-preview-authority";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused planning boundary spies.
import * as neonReader from "./hosted-operator-native-preview-neon-mcp";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Focused planning boundary spies.
import * as providerInventory from "./hosted-operator-provider-inventory";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import {
  createHostedOperatorControlPlane,
  createRetainedAppInstallationCustomerReader,
  matchesApprovedMembershipJwks,
  selectAuthPlanningResourceBindingRow,
} from "./hosted-operator-deployment";
import { requireFinalResourceBindingPhase } from "./hosted-operator-resource-binding-phase";
import {
  composeHostedOperatorDependencies,
  createDependencies,
  createConfiguredPreviewTargetResolver,
  resolveFullPlan,
} from "./hosted-operator-composition";
import { readHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import {
  initialNormalActorState,
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import type { NormalActorAccountPreparation } from "./hosted-operator-normal-actor-journal";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Exercise real composition with only the worker transport stubbed.
import * as membershipLauncher from "./hosted-operator-sandbox-launcher";

import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPublicResultSchema,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { OperatorRequest } from "./hosted-operator-contract";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on the provider adapter boundary while exercising real composition context routing.
import * as deploymentDelivery from "./hosted-operator-deployment-delivery";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Inspect the environment verification context without a provider request.
import * as gatewayBindingAdapter from "./hosted-operator-gateway-bindings";
import type { HostedOperatorNormalActorPlanningPorts } from "./hosted-operator-composition";
import type { CompiledOperatorReleaseSelection } from "./hosted-operator-artifact-selection";
import { appDescriptionSchema } from "../repository/app-description";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy only on the independent verified identity boundary.
import * as realmIdentity from "./hosted-operator-auth-identity";

const request = () =>
  new Request("https://operator.example/v1/runtime", {
    body: "{}",
    headers: { "content-type": "application/json" },
    method: "POST",
  });
afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
describe("actual native operator factory entrypoint", () => {
  it("loads the real source factory and remains unavailable without deployment-owned configuration", async () => {
    vi.stubEnv("PROTECTED_HOSTED_OPERATOR_CONFIGURATION", "");
    vi.stubEnv("PROTECTED_HOSTED_OPERATOR_AUTHORIZATION_CONFIGURATION", "");
    await expect(createDependencies()).rejects.toThrow();
    const result = await nativeEntryPoint.fetch(request());
    expect(result.status).toBe(503);
    expect(await result.text()).not.toMatch(/prepared|working|ready/iu);
  });
  it("rejects malformed deployment authority before opening private control-plane connections", async () => {
    vi.stubEnv(
      "PROTECTED_HOSTED_OPERATOR_CONFIGURATION",
      JSON.stringify({ operator: { projectId: "invented" } }),
    );
    const result = await nativeEntryPoint.fetch(request());
    expect(result.status).toBe(503);
  });
  it("uses the closed native path and method", async () => {
    const get = await nativeEntryPoint.fetch(new Request("https://operator.example/v1/runtime"));
    const other = await nativeEntryPoint.fetch(
      new Request("https://operator.example/other", { method: "POST" }),
    );
    expect(get.status).toBe(404);
    expect(other.status).toBe(404);
  });
  it("does not fabricate a default source configuration", () => {
    expect(() => readHostedOperatorSourceConfiguration({})).toThrow(
      "deployment configuration is unavailable",
    );
  });
});

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const currentSourceDescription = appDescriptionSchema.parse({
  app: { id: "actual", routes: ["/"], workspacePath: "apps/current-source" },
  backend: { kind: "static" },
  deployment: { framework: "nextjs", sourceFilesOutsideRootDirectory: true },
  validation: { browser: null, check: { task: "check" }, test: { shards: 1, task: "test" } },
  version: 1,
});
const currentPublishedSelection = {
  appId: "actual",
  appSpecDigest: "a".repeat(64),
  artifactRef: "current-source",
  manifestSha256: "b".repeat(64),
  releaseId: "current-release",
  schemaSha256: "c".repeat(64),
  version: 1,
  publishedSource: {
    branch: "current-branch",
    changeSetDigest: "d".repeat(64),
    gitSha: "e".repeat(40),
    gitTree: "f".repeat(40),
    repositoryId: "current-repository",
    reviewDigest: "b".repeat(64),
  },
} satisfies CompiledOperatorReleaseSelection;
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  target: {
    appId: "actual",
    branch: "feature/actual-publication",
    environment: "preview",
    installationId: "installation",
    projectId: "prj_actual",
    scopeId: "team",
    scopeType: "team",
    sessionId: "session",
  },
};
const bootstrapPlan = () =>
  hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("app"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "d".repeat(64) },
      planDigest: "e".repeat(64),
      targetDigest: "f".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "spec-digest",
    cost: { class: "shared-recovery-group", description: "Fixture bootstrap", owner: "owner" },
    effects: [
      {
        description: "Auth resources",
        id: "auth-resources",
        kind: "resources",
        resourceId: "auth-resource",
      },
      {
        description: "App resources",
        id: "app-resources",
        kind: "resources",
        resourceId: "app-resource",
      },
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "a".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "native-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon-fixture",
      source: "synthetic-only",
    },
    release: { artifactRef: "release-artifact", id: "release", sha256: "b".repeat(64) },
    resourcesInstaller: { reference: "resources-worker", sha256: "c".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    selection: {
      appId: context.target.appId,
      branch: context.target.branch,
      environment: "preview",
      projectId: context.target.projectId,
      sessionId: context.target.sessionId,
    },
    stage: "auth-bootstrap",
    version: 1,
  });

const bootstrapWithGatewayOrigin = (gatewayOrigin: string) =>
  hostedOperatorPlanSchema.parse({
    ...bootstrapPlan(),
    effects: [
      ...bootstrapPlan().effects,
      { description: "Gateway bindings", id: "gateway-bindings", kind: "gateway-bindings" },
      { description: "Gateway delivery", id: "gateway-delivery", kind: "gateway-delivery" },
    ],
    publicGateway: {
      branch: "gateway",
      origin: "https://apps.example",
      projectId: "gateway",
    },
    gatewayBindings: {
      authBrowserOrigin: "https://auth.example",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: ["actual"],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com/team",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team",
        ownerId: "team",
        projectId: "gateway",
        subject: "builder-workload",
      },
    },
    gatewayDelivery: {
      branch: "gateway",
      gitSha: "d".repeat(40),
      projectId: "gateway",
      repoId: "gateway-repository",
    },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        projectId: context.target.projectId,
        deploymentId: "app-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      gateway: {
        projectId: "gateway",
        deploymentId: "gateway-deployment",
        branch: "gateway",
        environment: "preview",
      },
      operator: {
        projectId: "operator",
        deploymentId: "operator-deployment",
        environment: "preview",
      },
      verification: {
        gatewayOrigin,
        jwksUrl: `${gatewayOrigin}/_platform/jwks.json`,
        publicOrigin: "https://apps.example",
      },
    },
  });

const publicationFixture = (binding: { repoId?: string; gitSha?: string } = {}) => {
  const workload = {
    audience: "https://vercel.com/team",
    environment: "preview",
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "builder",
    subject: "builder-workload",
  };
  const worker = {
    executablePath: "/worker",
    id: "worker",
    operationScope: "auth-protected-schema-v1",
    sha256: "a".repeat(64),
    subcommand: "auth-protected-schema",
  };
  const configuration = readHostedOperatorSourceConfiguration({
    PROTECTED_HOSTED_OPERATOR_CONFIGURATION: JSON.stringify({
      applications: {
        actual: {
          accessRoles: ["member"],
          appDatabase: resource("app"),
          branch: context.target.branch,
          projectId: context.target.projectId,
          ...binding,
        },
      },
      teamId: context.target.scopeId,
      authDatabase: resource("auth"),
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: ["actual"],
      gateway: {
        authBrowserOrigin: "https://auth.example",
        branch: "gateway-actual",
        environment: "preview",
        gatewayOrigin: "https://gateway.example",
        gitSha: "d".repeat(40),
        projectId: "gateway",
        protectedApplicationIds: ["actual"],
        publicOrigin: "https://apps.example",
        repoId: "gateway-repository",
        workload: { ...workload, projectId: "gateway" },
      },
      nativeNeon: {
        configuration: {
          connector: "fixture",
          nativeStore: {
            configurationId: "installation",
            resourceId: "store",
            sourceProjectId: "operator",
          },
          operator: {
            audience: workload.audience,
            environment: "preview",
            issuer: workload.issuer,
            ownerId: "team",
            projectId: "operator",
          },
        },
        scope: {
          branchId: "br-fixture",
          endpointId: "ep-fixture",
          hostname: "ep-fixture.neon.tech",
          maintenanceDatabase: "neondb",
          maintenanceRole: "neondb_owner",
          projectId: "neon-fixture",
        },
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        origin: "https://operator.example",
        projectId: "operator",
      },
      sandbox: {
        accessWorker: worker,
        authProposal: { executablePath: "/proposal", id: "proposal", sha256: "b".repeat(64) },
        authWorker: worker,
        image: "fixture",
        projectId: "operator",
        resourcesWorker: worker,
        teamId: "team",
        workers: { actual: worker },
      },
      workloadPolicy: workload,
    }),
  });
  const captured = {
    audience: "https://operator.example",
    endpointOrigin: "https://gateway.example",
  };
  const readCapturedRealmIdentity = vi.fn().mockResolvedValue(captured);
  const readCapturedRealmIdentityProof = vi.fn().mockResolvedValue({ link: {}, proof: "proof" });
  // oxlint-disable-next-line eslint/require-await -- Unused async ports fail immediately if planning reaches an unrelated boundary.
  const unexpectedPort = vi.fn(async (): Promise<never> => {
    throw new Error("Unexpected provider or effect port during planning");
  });
  const planningSession = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    appId: context.target.appId,
    createdAtEpochMs: 100,
    lastProgressAtEpochMs: 100,
    originAdapterSessionId: "adapter",
    principal: operatorOwnerContextSchema.parse(context.ownerContext).principal,
    resumability: "live",
    sessionId: context.target.sessionId,
    stage: "ready",
    status: "waiting",
    title: "Controlled planning owner",
    updatedAtEpochMs: 100,
    version: 2,
  });
  const readCurrentPlanningOwner = vi.fn<
    Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["readCurrentPlanningOwner"]
  >(() => Promise.resolve({ session: structuredClone(planningSession), target: context.target }));
  const controlPlane = {
    readCapturedRealmIdentity,
    readCapturedRealmIdentityProof,
    readCurrentPlanningOwner,
    assertPlanningAuthorized: unexpectedPort,
  };
  const verifiedIdentity = vi.spyOn(realmIdentity, "readVerifiedRealmAccess").mockResolvedValue({
    claims: realmIdentity.realmLinkClaimsSchema.parse({
      aud: "https://operator.example",
      authResourceId: "auth-resource",
      bootstrapPlanDigest: "a".repeat(64),
      exp: 1_800_000_000,
      iat: 1_799_999_900,
      iss: "https://apps.example",
      nonceSha256: "b".repeat(64),
      organizationId: "actual-organization",
      ownerSessionId: "session",
      purpose: "realm-operator-link-v1",
      sessionId: "actual-realm-session",
      sub: "actual-owner-actor",
      resource: {
        database: "auth",
        environment: "preview",
        hostname: "ep-fixture.neon.tech",
        migratorRole: "auth_owner",
        port: 5432,
        runtimeRole: "auth_runtime",
        schema: "public",
        version: 1,
      },
    }),
    identity: {
      actorId: "actual-owner-actor",
      expiresAt: "2027-01-01T00:00:00Z",
      organizationId: "actual-organization",
      sessionId: "actual-realm-session",
      version: 1,
    },
  });
  return {
    configuration,
    controlPlane,
    readCapturedRealmIdentity,
    readCapturedRealmIdentityProof,
    planningSession,
    unexpectedPort,
    verifiedIdentity,
  };
};

describe("final verifier entry diagnostics", () => {
  it("verifies the frozen operator deployment even after Config changes", async () => {
    const f = publicationFixture();
    f.configuration.operator.deploymentId = "stale-config-deployment";
    const plan = bootstrapWithGatewayOrigin("https://gateway.example");
    if (plan.deploymentBoundary === undefined) {
      throw new Error("Expected the approved deployment boundary.");
    }
    plan.deploymentBoundary.operator.deploymentId = "frozen-operator-deployment";
    const controlPlane = {
      ...f.controlPlane,
      assertAuthorized: vi.fn(async () => {
        await Promise.resolve();
      }),
      store: {
        read: vi.fn(async () => {
          await Promise.resolve();
          return {
            record: {
              operator: {
                deliveredDeploymentId: "app-delivered",
                deliveredGatewayDeploymentId: "gateway-delivered",
                deliveryCandidates: [
                  {
                    deploymentId: "app-delivered",
                    readyState: "READY",
                    branch: context.target.branch,
                    projectId: context.target.projectId,
                  },
                ],
                gatewayDeliveryCandidates: [
                  {
                    deploymentId: "gateway-delivered",
                    readyState: "READY",
                    branch: "gateway-actual",
                    projectId: "gateway",
                    origin: "https://gateway.example",
                  },
                ],
              },
            },
          };
        }),
      },
    };
    const stop = new Error("reached frozen inventory read");
    const read = vi
      .spyOn(providerInventory, "readHostedOperatorProviderInventory")
      .mockRejectedValue(stop);
    const dependencies = composeHostedOperatorDependencies(
      f.configuration,
      // SAFETY: This fixture stops at inventory; only the preceding ownership and journal ports execute.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The scoped fixture implements the reached verifier ports.
      controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
    );
    await expect(dependencies.verify({ ...context, plan })).rejects.toBe(stop);
    expect(
      read.mock.calls.some(
        ([inventoryRead]) =>
          inventoryRead.configuration.operator.deploymentId === "frozen-operator-deployment" &&
          inventoryRead.resolveOperatorByConfiguredOrigin === undefined,
      ),
    ).toBe(true);
  });

  it.each(["final_owner_authorization", "final_journal_read"] as const)(
    "reports the original %s failure before inventory or runtime verification",
    async (stage) => {
      const f = publicationFixture();
      const error = new TypeError("private-preflight-error");
      const assertAuthorized = vi.fn(() =>
        stage === "final_owner_authorization" ? Promise.reject(error) : Promise.resolve(),
      );
      const read = vi.fn(() => Promise.reject(error));
      const controlPlane = { ...f.controlPlane, assertAuthorized, store: { read } };
      const dependencies = composeHostedOperatorDependencies(
        f.configuration,
        // SAFETY: Both fail-fast scenarios reject at these two implemented entry ports, before any other control-plane capability is accessed.
        // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- The fixture deliberately implements only the entry boundary exercised by this test.
        controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
      );
      const log = vi.spyOn(console, "info").mockImplementation(() => {});
      await expect(dependencies.verify({ ...context, plan: bootstrapPlan() })).rejects.toBe(error);
      expect(log.mock.calls).toContainEqual([
        "[builder:hosted-neon-consent]",
        expect.objectContaining({ executionFailure: { stage, errorClass: "type_error" } }),
      ]);
      expect(JSON.stringify(log.mock.calls)).not.toContain(error.message);
      expect(read.mock.calls.length).toBe(stage === "final_owner_authorization" ? 0 : 1);
    },
  );
});

describe("app publication binding at plan renewal", () => {
  it("plans the actual described root for an older selected source with no target profile", async () => {
    const f = publicationFixture({ repoId: "initial-repository", gitSha: "c".repeat(40) });
    const legacyDescription = appDescriptionSchema.parse({
      ...currentSourceDescription,
      deployment: undefined,
    });
    const plan = await resolveFullPlan(
      bootstrapWithGatewayOrigin("https://gateway.example"),
      context,
      f.configuration,
      f.controlPlane,
      {},
      false,
      false,
      currentPublishedSelection,
      undefined,
      undefined,
      undefined,
      legacyDescription,
    );
    expect(plan.delivery?.projectSettings).toEqual({ rootDirectory: "apps/current-source" });
    expect(f.configuration.applications.actual?.projectSettings).toBeUndefined();
  });
  it("freezes the selected source profile into a new app plan without changing configured settings", async () => {
    const f = publicationFixture({ repoId: "initial-repository", gitSha: "c".repeat(40) });
    const application = f.configuration.applications.actual;
    if (application === undefined) {
      throw new Error("Fixture app is missing");
    }
    application.projectSettings = {
      framework: "vite",
      rootDirectory: "apps/initial-registration",
      sourceFilesOutsideRootDirectory: false,
    };
    const plan = await resolveFullPlan(
      bootstrapWithGatewayOrigin("https://gateway.example"),
      context,
      f.configuration,
      f.controlPlane,
      {},
      false,
      false,
      currentPublishedSelection,
      undefined,
      undefined,
      undefined,
      currentSourceDescription,
    );
    expect(plan.delivery?.projectSettings).toEqual({
      framework: "nextjs",
      rootDirectory: "apps/current-source",
      sourceFilesOutsideRootDirectory: true,
    });
    expect(plan.delivery?.gitSha).toBe(currentPublishedSelection.publishedSource.gitSha);
    expect(f.configuration.applications.actual?.projectSettings?.rootDirectory).toBe(
      "apps/initial-registration",
    );
  });
  it("keeps Auth bootstrap available without app publication fields before identity capture", async () => {
    const f = publicationFixture();
    f.readCapturedRealmIdentity.mockResolvedValue(null);
    const base = bootstrapPlan();
    const plan = await resolveFullPlan(base, context, f.configuration, f.controlPlane);
    expect(plan).toEqual(base);
    expect(plan.stage).toBe("auth-bootstrap");
    expect(plan.delivery).toBeUndefined();
    expect(plan.appTrustedSources).toBeUndefined();
    expect(plan.appDatabase).toEqual(resource("app"));
    expect(plan.authDatabase).toEqual(resource("auth"));
    expect(f.readCapturedRealmIdentityProof).not.toHaveBeenCalled();
    expect(f.unexpectedPort).not.toHaveBeenCalled();
  });

  it.each([{}, { repoId: "actual-repository-id" }, { gitSha: "c".repeat(40) }])(
    "rejects app renewal without both publication fields before proof or effects: %j",
    async (binding) => {
      const f = publicationFixture(binding);
      await expect(
        resolveFullPlan(bootstrapPlan(), context, f.configuration, f.controlPlane),
      ).rejects.toMatchObject({ code: "operator_unavailable" });
      expect(f.readCapturedRealmIdentityProof).not.toHaveBeenCalled();
      expect(f.verifiedIdentity).not.toHaveBeenCalled();
      expect(f.unexpectedPort).not.toHaveBeenCalled();
    },
  );

  it("renews the app plan with the exact actual repository, commit, branch, and project", async () => {
    const binding = { repoId: "actual-repository-id", gitSha: "c".repeat(40) };
    const f = publicationFixture(binding);
    const plan = await resolveFullPlan(
      bootstrapWithGatewayOrigin("https://gateway.example"),
      context,
      f.configuration,
      f.controlPlane,
    );
    expect(plan.stage).toBe("app");
    expect(plan.appTrustedSources).toEqual({
      gatewayPreview: {
        from: "preview",
        projectId: f.configuration.gateway.workload.projectId,
        to: "preview",
      },
    });
    expect(plan.effects.find((effect) => effect.kind === "bindings")?.description).toContain(
      "allow the configured Gateway Preview to reach this app Preview",
    );
    expect(plan.gatewayBindings?.trustedSources).toEqual({
      appPreview: { from: "preview", projectId: context.target.projectId, to: "preview" },
    });
    expect(plan.effects.find((effect) => effect.kind === "gateway-bindings")?.description).toBe(
      "Bind shared Gateway runtime and allow this app Preview to read the Gateway's public signing keys.",
    );
    expect(plan.delivery).toEqual({
      ...binding,
      branch: context.target.branch,
      projectId: context.target.projectId,
    });
    expect(plan.access).toEqual([
      { actorId: "actual-owner-actor", organizationId: "actual-organization", roles: ["member"] },
    ]);
    expect(f.readCapturedRealmIdentityProof).toHaveBeenCalledWith(context);
    expect(f.unexpectedPort).not.toHaveBeenCalled();
  });

  it("uses current captured release roles for a new grant and creates no grant for an empty role list", async () => {
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const base = bootstrapWithGatewayOrigin("https://gateway.example");
    const withRoles = await resolveFullPlan(
      base,
      context,
      f.configuration,
      f.controlPlane,
      {},
      false,
      false,
      undefined,
      undefined,
      undefined,
      ["reviewer"],
    );
    expect(withRoles.access).toEqual([
      { actorId: "actual-owner-actor", organizationId: "actual-organization", roles: ["reviewer"] },
    ]);
    const withoutRoles = await resolveFullPlan(
      base,
      context,
      f.configuration,
      f.controlPlane,
      {},
      false,
      false,
      undefined,
      undefined,
      undefined,
      [],
    );
    expect(withoutRoles.access).toEqual([]);
    expect(f.configuration.applications.actual?.accessRoles).toEqual(["member"]);
  });

  it("adds the app Preview grant without dropping existing Gateway trust sources", async () => {
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const base = bootstrapWithGatewayOrigin("https://gateway.example");
    const plan = await resolveFullPlan(
      hostedOperatorPlanSchema.parse({
        ...base,
        gatewayBindings: {
          ...base.gatewayBindings,
          trustedSources: {
            builderProduction: {
              from: "production",
              projectId: "builder-project",
              to: "preview",
            },
            operatorPreview: {
              from: "preview",
              projectId: "operator-project",
              to: "preview",
            },
          },
        },
      }),
      context,
      f.configuration,
      f.controlPlane,
    );
    expect(plan.gatewayBindings?.trustedSources).toEqual({
      appPreview: { from: "preview", projectId: context.target.projectId, to: "preview" },
      builderProduction: {
        from: "production",
        projectId: "builder-project",
        to: "preview",
      },
      operatorPreview: {
        from: "preview",
        projectId: "operator-project",
        to: "preview",
      },
    });
  });

  it("validates a trusted source against the exact Gateway workload, team and app Preview while accepting legacy plans", async () => {
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const plan = await resolveFullPlan(
      bootstrapWithGatewayOrigin("https://gateway.example"),
      context,
      f.configuration,
      f.controlPlane,
    );
    expect(hostedOperatorPlanSchema.safeParse(plan).success).toBe(true);
    const legacyPlan = structuredClone(plan);
    delete legacyPlan.appTrustedSources;
    expect(hostedOperatorPlanSchema.safeParse(legacyPlan).success).toBe(true);
    const { deploymentBoundary: boundary, gatewayBindings, delivery } = plan;
    if (boundary === undefined || gatewayBindings === undefined || delivery === undefined) {
      throw new Error("The trusted app Preview plan must retain its deployment bindings.");
    }

    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        appTrustedSources: {
          gatewayPreview: { from: "preview", projectId: "different-gateway", to: "preview" },
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          teamId: "different-team",
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        gatewayBindings: {
          ...gatewayBindings,
          sourceWorkload: { ...gatewayBindings.sourceWorkload, ownerId: "different-team" },
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        delivery: { ...delivery, projectId: "different-app" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        appTrustedSources: {
          gatewayPreview: { from: "preview", projectId: "gateway", to: "production" },
        },
      }).success,
    ).toBe(false);
  });

  it("binds membership transport to the current approved Gateway while retaining legacy fallback", () => {
    const current = "https://current-gateway.example";
    const historical = "https://gateway.example";
    const plan = bootstrapWithGatewayOrigin(current);
    expect(matchesApprovedMembershipJwks(plan, historical, `${current}/_platform/jwks.json`)).toBe(
      true,
    );
    expect(
      matchesApprovedMembershipJwks(plan, historical, `${historical}/_platform/jwks.json`),
    ).toBe(false);
    expect(
      matchesApprovedMembershipJwks(plan, historical, "https://other.example/_platform/jwks.json"),
    ).toBe(false);
    expect(
      matchesApprovedMembershipJwks(
        bootstrapPlan(),
        historical,
        `${historical}/_platform/jwks.json`,
      ),
    ).toBe(true);
    expect(
      matchesApprovedMembershipJwks(bootstrapPlan(), historical, `${current}/_platform/jwks.json`),
    ).toBe(false);
  });

  it("binds owner signup eligibility and roles to its approved Auth organization", async () => {
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const base = bootstrapWithGatewayOrigin("https://current-gateway.example");
    const result = await resolveFullPlan(
      base,
      context,
      f.configuration,
      f.controlPlane,
      {},
      false,
      false,
      undefined,
      {
        version: 1,
        appPath: "/dashboard",
        appRoles: ["member"],
        eligibility: "public",
        membershipRole: "member",
        organizationId: "actual-organization",
      },
    );
    expect(f.verifiedIdentity.mock.calls[0]?.[0].transportOrigin).toBe(
      "https://current-gateway.example",
    );
    expect(result.authSignupPolicy).toMatchObject({
      appId: "actual",
      appPath: "/dashboard",
      appRoles: ["member"],
      authResourceId: "auth-resource",
      eligibility: "public",
      membershipRole: "member",
      organizationId: "actual-organization",
      origin: "https://apps.example",
    });
    const kinds = result.effects.map((effect) => effect.kind);
    expect(kinds.indexOf("auth-membership")).toBeLessThan(kinds.indexOf("auth-signup-policy"));
    expect(kinds.indexOf("auth-signup-policy")).toBeLessThan(kinds.indexOf("access"));
    expect(kinds.indexOf("auth-signup-policy")).toBeLessThan(kinds.indexOf("delivery"));
  });

  it.each(["branch", "projectId", "scopeId"] as const)(
    "retains the actual %s ownership check with a complete publication binding",
    async (field) => {
      const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
      const changed = { ...context, target: { ...context.target, [field]: "different" } };
      await expect(
        resolveFullPlan(bootstrapPlan(), changed, f.configuration, f.controlPlane),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.readCapturedRealmIdentityProof).not.toHaveBeenCalled();
      expect(f.unexpectedPort).not.toHaveBeenCalled();
    },
  );
});

describe("configured owner-authorized Preview target metadata", () => {
  const resolverFixture = () => {
    const f = publicationFixture();
    const order: string[] = [];
    const consentOwner = {
      // oxlint-disable-next-line eslint/require-await -- Synthetic async authority ports record their invocation synchronously.
      authorize: vi.fn(async () => {
        order.push("owner");
        if (context.ownerContext === undefined) {
          throw new Error("Fixture owner missing");
        }
        return { authority, ownerContext: context.ownerContext };
      }),
    };
    const controlPlane = {
      // oxlint-disable-next-line eslint/require-await -- Synthetic async authority ports record their invocation synchronously.
      authorize: vi.fn(async () => {
        order.push("project");
        return structuredClone(context);
      }),
      // oxlint-disable-next-line eslint/require-await -- Synthetic async authority revalidation records its invocation synchronously.
      assertPlanningAuthorized: vi.fn(async () => {
        order.push("revalidate");
      }),
    };
    const resolve = createConfiguredPreviewTargetResolver(
      f.configuration,
      consentOwner,
      controlPlane,
    );
    return { ...f, order, consentOwner, controlPlane, resolve };
  };
  const identity = { appId: context.target.appId, sessionId: context.target.sessionId };

  it("resolves the configured project and branch after owner and provider checks without compiling or planning", async () => {
    const f = resolverFixture();
    const result = await f.resolve(request(), identity, context.ownerContext);
    expect(result.target).toMatchObject(identity);
    expect(f.order.indexOf("owner")).toBeGreaterThanOrEqual(0);
    expect(f.order.indexOf("owner")).toBeLessThan(f.order.indexOf("project"));
    expect(f.order.indexOf("project")).toBeLessThan(f.order.lastIndexOf("revalidate"));
    expect(f.controlPlane.authorize).toHaveBeenCalledWith(
      expect.any(Request),
      {
        ...identity,
        projectId: context.target.projectId,
        branch: context.target.branch,
        environment: "preview",
      },
      context.ownerContext,
    );
    expect(f.unexpectedPort).not.toHaveBeenCalled();
  });
  it("does not look up a configured app before current-owner authorization succeeds", async () => {
    const f = resolverFixture();
    f.consentOwner.authorize.mockRejectedValue(new Error("revoked owner"));
    await expect(
      f.resolve(request(), { ...identity, appId: "unconfigured" }, context.ownerContext),
    ).rejects.toThrow("revoked owner");
    expect(f.controlPlane.authorize).not.toHaveBeenCalled();
  });
  it("does not authorize an unconfigured app", async () => {
    const f = resolverFixture();
    await expect(
      f.resolve(request(), { ...identity, appId: "unconfigured" }, context.ownerContext),
    ).rejects.toThrow("resource_mismatch");
    expect(f.controlPlane.authorize).not.toHaveBeenCalled();
  });
  it("preserves actual provider project access denial", async () => {
    const f = resolverFixture();
    f.controlPlane.authorize.mockRejectedValue(new Error("project access revoked"));
    await expect(f.resolve(request(), identity, context.ownerContext)).rejects.toThrow(
      "project access revoked",
    );
    expect(f.controlPlane.assertPlanningAuthorized).not.toHaveBeenCalled();
  });
  it("rejects a target in a different configured owner team", async () => {
    const f = resolverFixture();
    f.controlPlane.authorize.mockResolvedValue({
      ...context,
      target: { ...context.target, scopeId: "other-team" },
    });
    await expect(f.resolve(request(), identity, context.ownerContext)).rejects.toThrow(
      "resource_mismatch",
    );
  });
  it("does not return metadata if the owner is revoked during resolution", async () => {
    const f = resolverFixture();
    f.controlPlane.assertPlanningAuthorized.mockRejectedValue(
      new Error("owner revoked during lookup"),
    );
    await expect(f.resolve(request(), identity, context.ownerContext)).rejects.toThrow(
      "owner revoked during lookup",
    );
  });
});

const participantResolutionFixture = (captureOnly = false) => {
  const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
  const declaredProgram = normalActorProgramSchema.parse({
    version: 1,
    appId: context.target.appId,
    origin: f.configuration.gateway.publicOrigin,
    actors: [
      {
        actorKey: "owner",
        name: "Owner",
        email: "owner@example.test",
        account: "create-email-password",
      },
    ],
    organizations: [
      { organizationId: "first-org", ownerActorKey: "owner", name: "First", slug: "first" },
      { organizationId: "second-org", ownerActorKey: "owner", name: "Second", slug: "second" },
    ],
    memberships: [
      { organizationId: "first-org", actorKey: "owner", role: "owner" },
      { organizationId: "second-org", actorKey: "owner", role: "owner" },
    ],
    appAccess: [
      { organizationId: "first-org", actorKey: "owner", roles: ["member"] },
      { organizationId: "second-org", actorKey: "owner", roles: ["member"] },
    ],
  });
  const program = captureOnly
    ? normalActorProgramSchema.parse({
        ...declaredProgram,
        actors: declaredProgram.actors.map((actor) => ({ ...actor, account: "capture-existing" })),
        organizations: [],
        memberships: [],
        appAccess: [],
      })
    : declaredProgram;
  const base = hostedOperatorPlanSchema.parse({
    ...bootstrapWithGatewayOrigin("https://gateway.example"),
    normalActorProgram: program,
    publicGateway: { projectId: "gateway", branch: "gateway-actual", origin: program.origin },
    gatewayDelivery: {
      branch: "gateway-actual",
      gitSha: "d".repeat(40),
      projectId: "gateway",
      repoId: "gateway-repository",
    },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        projectId: context.target.projectId,
        deploymentId: "app-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      gateway: {
        projectId: "gateway",
        deploymentId: "gateway-deployment",
        branch: "gateway-actual",
        environment: "preview",
      },
      operator: {
        projectId: "operator",
        deploymentId: "operator-deployment",
        environment: "preview",
      },
      verification: {
        gatewayOrigin: "https://gateway.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: program.origin,
      },
    },
  });
  const accountPlan = hostedOperatorPlanSchema.parse({
    ...base,
    stage: "auth-participants",
    effects: [{ id: "normal-accounts", kind: "normal-accounts", description: "Accounts only" }],
  });
  const operation = "00000000-0000-4000-8000-000000000011";
  const state = initialNormalActorState(program, operation);
  state.actors[0] = {
    actorKey: "owner",
    signup: "complete",
    session: {
      reference: "00000000-0000-4000-8000-000000000012",
      actorId: "normal-owner-from-session",
      realmSessionId: "normal-owner-session",
      origin: program.origin,
      expiresAt: "2027-01-01T00:00:00.000Z",
    },
    storageState: { cookies: [], origins: [] },
  };
  const ownerSession = state.actors[0].session;
  if (ownerSession === undefined) {
    throw new Error("Missing fixture owner session");
  }
  state.organizationSessions = program.memberships.map((membership) => ({
    actorKey: membership.actorKey,
    organizationId: membership.organizationId,
    selection: "pending",
    session: { ...ownerSession, realmSessionId: `normal-owner-${membership.organizationId}` },
    storageState: { cookies: [], origins: [] },
  }));
  const preparation: NormalActorAccountPreparation = {
    program,
    programDigest: normalActorProgramDigest(program),
    accountOperationRef: operation,
    accountPlan,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    accountApprovalId: "first-account-approval",
    accountApprovedByCallId: "first-account-call",
    sealedState: {
      encryptedToken: "private-account-state",
      keyVersion: "fixture",
      tokenIv: "fixture",
      tokenTag: "fixture",
    },
    captures: [],
    accountsCompletedAt: "2026-10-14T12:00:00.000Z",
  };
  const organizations = program.organizations.map((organization, index) => ({
    kind: "create-owned-organization" as const,
    organizationId: organization.organizationId,
    name: organization.name,
    slug: organization.slug,
    actorId: "normal-owner-from-session",
    bootstrapPlanDigest: "a".repeat(64),
    identityCapture: {
      capturedAt: "2026-10-14T12:00:00.000Z",
      realmSessionId: `normal-owner-${organization.organizationId}`,
    },
    identityNonceSha256: (index === 0 ? "b" : "c").repeat(64),
    identityProof: {
      reference: `private-proof-${index}`,
      sha256: (index === 0 ? "d" : "e").repeat(64),
    },
    identityVerification: {
      audience: "https://operator.example",
      issuer: program.origin,
      jwksUrl: "https://gateway.example/_platform/jwks.json",
      transportSource: f.configuration.nativeNeon.configuration.operator,
    },
  }));
  const ports = {
    ...f.controlPlane,
    assertPlanningAuthorized: vi.fn(async () => {
      await Promise.resolve();
    }),
    readNormalActorPreparation: vi.fn<
      HostedOperatorNormalActorPlanningPorts["readNormalActorPreparation"]
    >(async () => await Promise.resolve({ preparation, state })),
    readNormalActorOrganizationProofs: vi.fn(async () => await Promise.resolve(organizations)),
  };
  return { ...f, ports, base, program, accountPlan, state, preparation, organizations };
};

const unusedCompositionControlPlane = (): Parameters<
  typeof composeHostedOperatorDependencies
>[1] => {
  const unexpectedPort = (): never => {
    throw new Error("Unexpected control-plane operation in signup guard fixture");
  };
  const store = {
    reserve: unexpectedPort,
    read: unexpectedPort,
    compareAndSet: unexpectedPort,
    reserveFenceGeneration: unexpectedPort,
  };
  return {
    exportRequest: unexpectedPort,
    continuityRequest: unexpectedPort,
    readNormalActorRuntimeBindings: unexpectedPort,
    ensureNormalActorCapture: unexpectedPort,
    normalActorAuthIdentityInput: unexpectedPort,
    prepareNormalActorAccounts: unexpectedPort,
    verifyNormalActorAccounts: unexpectedPort,
    prepareNormalActorMemberships: unexpectedPort,
    verifyNormalActorMemberships: unexpectedPort,
    reconcileNormalActorMemberships: unexpectedPort,
    readNormalActorPreparation: unexpectedPort,
    readNormalActorOrganizationProofs: unexpectedPort,
    readApprovedPlan: unexpectedPort,
    registerOwnerRealmIdentityWait: unexpectedPort,
    acknowledgeOwnerRealmIdentityWait: unexpectedPort,
    readRealmIdentityWaitDelivery: unexpectedPort,
    resolveOwnerRealmContinuationContext: unexpectedPort,
    reconcileOwnerRealmContinuation: unexpectedPort,
    readRealmContinuationPendingBaseline: unexpectedPort,
    isObsoleteRealmAuthWait: unexpectedPort,
    readRealmContinuationDeliveryStartIndex: unexpectedPort,
    readRealmContinuationDeliveryTargetRequestId: unexpectedPort,
    acceptRealmContinuationDelivery: unexpectedPort,
    readRealmContinuationDeliveryReceipt: unexpectedPort,
    readRealmContinuationDeliveryClaim: unexpectedPort,
    claimRealmContinuationDelivery: unexpectedPort,
    normalActorJournalPorts: {
      store,
      get keyring() {
        return unexpectedPort();
      },
      assertAuthorized: unexpectedPort,
      assertAccountApproval: unexpectedPort,
      assertMutationAuthority: unexpectedPort,
      now: unexpectedPort,
    },
    assertAuthorized: unexpectedPort,
    assertMembershipCapture: unexpectedPort,
    assertCanonicalOwner: unexpectedPort,
    assertPlanningAuthorized: unexpectedPort,
    authorize: unexpectedPort,
    checkpointSharedAuthAdoption: unexpectedPort,
    close: unexpectedPort,
    consumeOwnerRealmIdentityCallback: unexpectedPort,
    prepareRealmIdentityLink: unexpectedPort,
    prepareNormalActorCapture: unexpectedPort,
    readPendingNormalActorCapture: unexpectedPort,
    prepareResourceCredentials: unexpectedPort,
    publishAuthPlan: unexpectedPort,
    readActiveSharedAuth: unexpectedPort,
    readApproval: unexpectedPort,
    readAuthPlan: unexpectedPort,
    readMembershipInspectionPlan: unexpectedPort,
    readCapturedRealmIdentity: unexpectedPort,
    readCapturedRealmIdentityProof: unexpectedPort,
    readCredential: unexpectedPort,
    readCurrentPlanningOwner: unexpectedPort,
    readGeneratedRelease: unexpectedPort,
    readGeneratedSelection: unexpectedPort,
    readPendingRealmIdentityLinkForStaging: unexpectedPort,
    readRealmIdentityLink: unexpectedPort,
    readResourceBindings: unexpectedPort,
    readRetirementResourceCredentials: unexpectedPort,
    readSharedAuthAdoption: unexpectedPort,
    readSharedGatewayRows: unexpectedPort,
    reserveRealmIdentityLink: unexpectedPort,
    resolveRealmIdentityCallbackContext: unexpectedPort,
    store,
    verifySharedAuthAdoption: unexpectedPort,
    withResourceLease: unexpectedPort,
  };
};

describe("empty approved access effects", () => {
  const setup = async (captureOnly = true) => {
    const f = participantResolutionFixture(captureOnly);
    f.state.memberships = f.state.memberships.map((membership) => ({
      ...membership,
      status: "complete",
    }));
    const plan = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      {
        ...f.ports,
        readAppInstallationCustomerIds: async () => await Promise.resolve(["existing-owner"]),
      },
      {},
      true,
      true,
    );
    const effect = plan.effects.find((candidate) => candidate.kind === "access");
    if (effect === undefined) {
      throw new Error("Controlled access effect missing");
    }
    const inspect = vi.fn<
      ReturnType<typeof membershipLauncher.createHostedOperatorSandboxLauncher>["inspect"]
    >(
      async () =>
        await Promise.resolve({
          version: 1,
          operation_id: "00000000-0000-4000-8000-000000000021",
          context_digest: "d".repeat(64),
          fence_generation: 1,
          status: "applied",
          readback_sha256: "e".repeat(64),
        }),
    );
    const execute = vi.fn<
      ReturnType<typeof membershipLauncher.createHostedOperatorSandboxLauncher>["execute"]
    >(async () => {
      await Promise.resolve();
    });
    vi.spyOn(membershipLauncher, "createHostedOperatorSandboxLauncher").mockReturnValue({
      inspect,
      execute,
    });
    const assertCurrent = vi.fn<HostedOperatorEffectContext["assertCurrent"]>(async () => {
      await Promise.resolve();
    });
    const assertAuthorized = vi.fn<ProtectedHostedOperatorDependencies["assertAuthorized"]>(
      async () => {
        await Promise.resolve();
      },
    );
    const verifyNormalActorMemberships = vi.fn(async () => await Promise.resolve(f.state));
    const readResourceBindings = vi.fn(
      async () =>
        await Promise.resolve({
          authDatabase: { migrationUrl: "private-auth", runtimeUrl: "private-auth-runtime" },
          appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
        }),
    );
    const readGeneratedRelease = vi.fn(
      async () => await Promise.reject(new Error("Controlled worker release read")),
    );
    const dependencies = composeHostedOperatorDependencies(f.configuration, {
      ...unusedCompositionControlPlane(),
      assertAuthorized,
      verifyNormalActorMemberships,
      readResourceBindings,
      readGeneratedRelease,
    });
    const input: HostedOperatorWorkerEffectContext = {
      ...context,
      plan,
      effect,
      accountPreparation: f.preparation,
      operationRef: "00000000-0000-4000-8000-000000000021",
      fenceGeneration: 7,
      leaseId: "00000000-0000-4000-8000-000000000022",
      workerAttemptId: "00000000-0000-4000-8000-000000000023",
      workerCheckpoints: [],
      assertCurrent,
      checkpoint: async () => {
        await Promise.resolve();
      },
      bindWorkerContext: async () =>
        await Promise.resolve(async () => {
          await Promise.resolve();
        }),
    };
    return {
      f,
      input,
      dependencies,
      inspect,
      execute,
      assertCurrent,
      assertAuthorized,
      verifyNormalActorMemberships,
      readResourceBindings,
      readGeneratedRelease,
    };
  };
  it("settles only zero approved grants under the original captured accounts without opening a worker or credentials", async () => {
    const f = await setup();
    const before = structuredClone({
      plan: f.input.plan,
      preparation: f.f.preparation,
      state: f.f.state,
    });
    expect(f.input.plan.access).toEqual([]);
    expect(f.input.plan.appInstallation?.customerIds).toEqual(["existing-owner"]);
    expect(f.input.plan.normalActorPreparation?.accountOperationRef).toBe(
      f.f.preparation.accountOperationRef,
    );
    const observed = await f.dependencies.reconcile(f.input);
    const executed = await f.dependencies.executeEffect(f.input);
    expect(observed).toMatchObject({
      status: "applied",
      receipt: {
        effectId: f.input.effect.id,
        fenceGeneration: 7,
        resourceVersion: executed.resourceVersion,
      },
    });
    expect(executed.resourceVersion).toBe(
      createHash("sha256")
        .update(JSON.stringify({ effect: "access", grants: [] }))
        .digest("hex"),
    );
    expect(f.verifyNormalActorMemberships).toHaveBeenCalledWith(f.input);
    expect({ plan: f.input.plan, preparation: f.f.preparation, state: f.f.state }).toEqual(before);
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.readResourceBindings).not.toHaveBeenCalled();
    expect(f.readGeneratedRelease).not.toHaveBeenCalled();
  });
  it.each(
    (["inspect", "execute"] as const).flatMap((mode) =>
      (
        [
          "owner",
          "fence",
          "account",
          "participant-scope",
          "changed-plan",
          "changed-effect",
        ] as const
      ).map((failure) => ({
        mode,
        failure,
      })),
    ),
  )("rejects $failure before $mode can settle empty grants", async ({ mode, failure }) => {
    const f = await setup();
    const denied = new HostedOperatorError("authorization_required");
    if (failure === "owner") {
      f.assertAuthorized
        .mockImplementationOnce(async () => {
          await Promise.resolve();
        })
        .mockRejectedValue(denied);
    } else if (failure === "fence") {
      f.verifyNormalActorMemberships.mockImplementation(async () => {
        f.assertCurrent.mockRejectedValue(denied);
        return await Promise.resolve(f.f.state);
      });
    } else if (failure === "account") {
      f.verifyNormalActorMemberships.mockRejectedValue(denied);
    } else if (failure === "changed-plan" || failure === "changed-effect") {
      f.verifyNormalActorMemberships.mockImplementation(async () => {
        if (failure === "changed-plan") {
          f.input.plan = hostedOperatorPlanSchema.parse({
            ...f.input.plan,
            contextId: "changed-after-account-check",
          });
        } else {
          f.input.effect = { ...f.input.effect, id: "unapproved-empty-access" };
        }
        return await Promise.resolve(f.f.state);
      });
    } else {
      f.verifyNormalActorMemberships.mockResolvedValue({
        ...f.f.state,
        operationRef: "00000000-0000-4000-8000-000000000099",
      });
    }
    await expect(
      mode === "inspect"
        ? f.dependencies.reconcile(f.input)
        : f.dependencies.executeEffect(f.input),
    ).rejects.toThrow();
    expect(f.inspect).not.toHaveBeenCalled();
    expect(f.execute).not.toHaveBeenCalled();
    expect(f.readResourceBindings).not.toHaveBeenCalled();
  });
  it.each(["inspect", "execute"] as const)(
    "rejects cleanup before %s can settle empty access",
    async (mode) => {
      const f = await setup();
      f.input.plan = { ...f.input.plan, action: "cleanup" };
      await expect(
        mode === "inspect"
          ? f.dependencies.reconcile(f.input)
          : f.dependencies.executeEffect(f.input),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(f.assertAuthorized).not.toHaveBeenCalled();
      expect(f.verifyNormalActorMemberships).not.toHaveBeenCalled();
      expect(f.readResourceBindings).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.execute).not.toHaveBeenCalled();
    },
  );
  it.each(["install", "revoke"] as const)(
    "keeps %s on the existing worker preparation path even without grants",
    async (kind) => {
      const f = await setup();
      const input = { ...f.input, effect: { ...f.input.effect, id: kind, kind } };
      await expect(f.dependencies.reconcile(input)).rejects.toThrow();
      expect(f.readResourceBindings).toHaveBeenCalledWith(input);
    },
  );
  it("keeps nonempty grants on the existing worker preparation path", async () => {
    const f = await setup(false);
    expect(f.input.plan.access.length).toBeGreaterThan(0);
    await expect(f.dependencies.reconcile(f.input)).rejects.toThrow();
    expect(f.verifyNormalActorMemberships).toHaveBeenCalledWith(f.input);
    expect(f.readResourceBindings).toHaveBeenCalledWith(f.input);
  });
});

describe("participant plan resolution", () => {
  it.each(["inspect", "execute"] as const)(
    "keeps current authority and participant signup state checks on %s callbacks",
    async (mode) => {
      const f = participantResolutionFixture();
      f.configuration.sandbox.membershipWorker = {
        ...f.configuration.sandbox.authWorker,
        id: "membership-fixture",
        operationScope: "auth-protected-membership-v1",
        subcommand: "auth-protected-membership",
      };
      f.state.organizations = f.state.organizations.map((organization) => ({
        ...organization,
        status: "complete",
      }));
      f.state.memberships = f.state.memberships.map((membership) => ({
        ...membership,
        status: "complete",
      }));
      const plan = await resolveFullPlan(
        f.base,
        context,
        f.configuration,
        f.ports,
        {},
        true,
        true,
        undefined,
        {
          version: 1,
          appPath: "/dashboard",
          appRoles: ["member"],
          eligibility: "approved-email",
          allowedEmails: ["owner@example.test"],
          membershipRole: "member",
          organizationId: "first-org",
        },
      );
      const effect = plan.effects.find((candidate) => candidate.kind === "auth-signup-policy");
      if (effect === undefined) {
        throw new Error("Fixture signup policy effect missing");
      }
      const full = vi.fn<HostedOperatorEffectContext["assertCurrent"]>(() => Promise.resolve());
      const observation = vi.fn<
        NonNullable<HostedOperatorEffectContext["assertCurrentObservation"]>
      >(() => Promise.resolve());
      const input: HostedOperatorWorkerEffectContext = {
        ...context,
        plan,
        effect,
        operationRef: "11111111-1111-4111-8111-111111111111",
        fenceGeneration: 1,
        workerAttemptId: "22222222-2222-4222-8222-222222222222",
        workerCheckpoints: [],
        assertCurrent: full,
        assertCurrentObservation: observation,
        checkpoint: vi.fn<HostedOperatorWorkerEffectContext["checkpoint"]>(() => Promise.resolve()),
        bindWorkerContext: vi
          .fn<HostedOperatorWorkerEffectContext["bindWorkerContext"]>()
          .mockResolvedValue(() => Promise.resolve()),
      };
      let worker: HostedOperatorEffectContext | undefined;
      const stop = new Error("controlled execute transport stop");
      type Launcher = ReturnType<typeof membershipLauncher.createHostedOperatorSandboxLauncher>;
      vi.spyOn(membershipLauncher, "createHostedOperatorSandboxLauncher").mockReturnValue({
        inspect: vi.fn<Launcher["inspect"]>((current) => {
          worker = current;
          const readback: Awaited<ReturnType<Launcher["inspect"]>> = {
            version: 1,
            operation_id: input.operationRef,
            context_digest: "d".repeat(64),
            fence_generation: 1,
            status: "applied",
            readback_sha256: "e".repeat(64),
          };
          return Promise.resolve(readback);
        }),
        execute: vi.fn<Launcher["execute"]>((current) => {
          worker = current;
          return Promise.reject(stop);
        }),
      });
      vi.stubEnv(
        "VERCEL_OIDC_TOKEN",
        `fixture.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.fixture`,
      );
      const dependencies = composeHostedOperatorDependencies(f.configuration, {
        ...unusedCompositionControlPlane(),
        assertPlanningAuthorized: f.ports.assertPlanningAuthorized,
        readNormalActorPreparation: f.ports.readNormalActorPreparation,
        readNormalActorOrganizationProofs: f.ports.readNormalActorOrganizationProofs,
        assertAuthorized: vi.fn(() => Promise.resolve()),
        readResourceBindings: vi.fn(() =>
          Promise.resolve({
            authDatabase: { migrationUrl: "private-auth", runtimeUrl: "private-auth-runtime" },
            appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
          }),
        ),
      });
      await (mode === "inspect"
        ? dependencies.reconcile(input)
        : expect(dependencies.executeEffect(input)).rejects.toBe(stop));
      if (worker === undefined) {
        throw new Error("Fixture worker missing");
      }
      const guard = mode === "inspect" ? worker.assertCurrentObservation : worker.assertCurrent;
      if (guard === undefined) {
        throw new Error("Fixture worker observation guard missing");
      }
      const base = mode === "inspect" ? observation : full;
      const unused = mode === "inspect" ? full : observation;
      base.mockClear();
      unused.mockClear();
      await guard();
      expect(base).toHaveBeenCalledTimes(2);
      expect(unused).not.toHaveBeenCalled();
      base
        .mockImplementationOnce(() => Promise.resolve())
        .mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
      await expect(guard()).rejects.toMatchObject({ code: "authorization_required" });
      const organization = f.state.organizations[0];
      if (organization === undefined) {
        throw new Error("Fixture participant organization missing");
      }
      organization.status = "pending";
      await expect(guard()).rejects.toMatchObject({ code: "reconciliation_required" });
    },
  );
  it("retains the accepted program during bootstrap and never starts the legacy singular identity path", async () => {
    const f = participantResolutionFixture();
    expect(await resolveFullPlan(f.base, context, f.configuration, f.ports)).toEqual(f.base);
    expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
    expect(f.ports.readNormalActorPreparation).not.toHaveBeenCalled();
  });
  it("freezes only account effects after actual bootstrap readiness", async () => {
    const f = participantResolutionFixture();
    // oxlint-disable-next-line unicorn/no-useless-undefined -- Vitest requires an explicit optional result argument.
    f.ports.readNormalActorPreparation.mockResolvedValue(undefined);
    const result = await resolveFullPlan(f.base, context, f.configuration, f.ports, {}, true);
    expect(result.stage).toBe("auth-participants");
    expect(result.effects.map((effect) => effect.kind)).toEqual(["normal-accounts"]);
    expect(result.access).toEqual([]);
    expect(result.authMembership).toBeUndefined();
    expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
    expect(f.ports.readNormalActorOrganizationProofs).not.toHaveBeenCalled();
  });
  it("resumes the first account plan until participant completion rather than replacing its operation or approval", async () => {
    const f = participantResolutionFixture();
    const result = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      f.ports,
      {},
      true,
      false,
    );
    expect(result).toEqual(f.accountPlan);
    expect(f.ports.readNormalActorOrganizationProofs).not.toHaveBeenCalled();
  });
  it("proposes actual captured actors and both organizations in one full approval, with separate worker checkpoints", async () => {
    const f = participantResolutionFixture();
    const result = await resolveFullPlan(f.base, context, f.configuration, f.ports, {}, true, true);
    expect(result.stage).toBe("app");
    expect(result.appTrustedSources).toEqual({
      gatewayPreview: {
        from: "preview",
        projectId: f.configuration.gateway.workload.projectId,
        to: "preview",
      },
    });
    expect(result.gatewayBindings?.trustedSources).toEqual({
      appPreview: { from: "preview", projectId: context.target.projectId, to: "preview" },
    });
    expect(result.effects.find((effect) => effect.kind === "gateway-bindings")?.description).toBe(
      "Bind shared Gateway runtime and allow this app Preview to read the Gateway's public signing keys.",
    );
    expect(result.access).toEqual([
      { actorId: "normal-owner-from-session", organizationId: "first-org", roles: ["member"] },
      { actorId: "normal-owner-from-session", organizationId: "second-org", roles: ["member"] },
    ]);
    expect(result.authMembership).toEqual({
      kind: "create-owned-organizations",
      organizations: f.organizations,
    });
    expect(
      result.effects
        .filter((effect) => effect.kind === "auth-membership")
        .map((effect) => effect.id),
    ).toEqual(["auth-membership:first-org", "auth-membership:second-org"]);
    expect(result.normalActorPreparation?.accountOperationRef).toBe(
      f.preparation.accountOperationRef,
    );
    expect(result.normalActorPreparation?.accountApprovalId).toBe("first-account-approval");
    expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private-account-state");
  });
  it("uses the selected source profile in a new participant app plan", async () => {
    const f = participantResolutionFixture();
    const result = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      f.ports,
      {},
      true,
      true,
      currentPublishedSelection,
      undefined,
      undefined,
      undefined,
      currentSourceDescription,
    );
    expect(result.delivery?.projectSettings).toEqual({
      framework: "nextjs",
      rootDirectory: "apps/current-source",
      sourceFilesOutsideRootDirectory: true,
    });
    expect(result.delivery?.repoId).toBe(currentPublishedSelection.publishedSource.repositoryId);
  });
  it("rejects participant grants outside the current captured release roles", async () => {
    const f = participantResolutionFixture();
    await expect(
      resolveFullPlan(
        f.base,
        context,
        f.configuration,
        f.ports,
        {},
        true,
        true,
        undefined,
        undefined,
        undefined,
        [],
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it("binds participant signup roles as a subset for one approved organization", async () => {
    const f = participantResolutionFixture();
    const result = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      f.ports,
      {},
      true,
      true,
      undefined,
      {
        version: 1,
        appPath: "/dashboard",
        appRoles: ["member"],
        eligibility: "approved-email",
        allowedEmails: ["owner@example.test"],
        membershipRole: "member",
        organizationId: "first-org",
      },
    );
    expect(result.authSignupPolicy).toMatchObject({
      appId: result.selection.appId,
      appPath: "/dashboard",
      appRoles: ["member"],
      eligibility: "approved-email",
      membershipRole: "member",
      organizationId: "first-org",
      origin: f.program.origin,
    });
    const kinds = result.effects.map((effect) => effect.kind);
    expect(kinds.indexOf("auth-signup-policy")).toBeLessThan(kinds.indexOf("access"));
    expect(kinds.indexOf("auth-signup-policy")).toBeLessThan(kinds.indexOf("delivery"));
    expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
  });
});

/* oxlint-disable eslint/require-await, typescript/no-non-null-assertion, anti-slop/no-chained-type-assertions, anti-slop/require-safety-comment-for-type-assertion, typescript/no-unsafe-type-assertion, typescript/no-unnecessary-type-assertion, eslint/no-nested-ternary, sonarjs/no-nested-conditional, sonarjs/max-union-size, unicorn/no-useless-undefined -- Synthetic planning fixtures intentionally implement only read-only ports reached by these tests; schema parsers construct the original approved records. */
// These spies isolate provider inventory while exercising the real workflow plan composition.

const existingAuthRecord = (plan = bootstrapPlan()) =>
  hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "original-approval-call",
    request: context.target,
    status: "pending",
    step: "reserved",
    privateState: {
      encryptedToken: "encrypted",
      keyVersion: "fixture",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    operator: {
      mode: "protected-operator-v1",
      approvalId: "original-approval",
      operationRef: "00000000-0000-4000-8000-000000000001",
      fenceGeneration: 1,
      plan,
      planDigest: operatorPlanDigest(plan),
      authPreparation: {
        assetSha256: "d".repeat(64),
        catalogFingerprint: "e".repeat(64),
        database: "auth",
        runtimeRole: "auth_runtime",
        targetDigest: plan.authSchema!.targetDigest,
        observedAt: "2026-10-15T12:00:00Z",
      },
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt: "2026-10-15T12:00:00Z",
        resourceVersion: "owned-observation",
      })),
    },
  });

describe("retained APP Gateway source planning continuation", () => {
  const setup = async () => {
    const f = participantResolutionFixture();
    const appPlan = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      f.ports,
      {},
      true,
      true,
    );
    f.readCapturedRealmIdentity.mockClear();
    f.readCapturedRealmIdentityProof.mockClear();
    const record = existingAuthRecord(appPlan);
    const operator = record.operator!;
    const pending =
      appPlan.effects.find((effect) => effect.kind === "auth-membership") ??
      appPlan.effects.find((effect) => effect.kind === "install");
    if (pending === undefined) {
      throw new Error("The controlled plan has no pending worker effect");
    }
    operator.pendingEffectId = pending.id;
    operator.pendingEffectAttempt = {
      id: "00000000-0000-4000-8000-000000000003",
      contextDigest: "e".repeat(64),
    };
    operator.receipts = operator.receipts.filter(
      (receipt) => receipt.effectId !== pending.id && receipt.effectId !== "gateway-delivery",
    );
    operator.workerCheckpoints = [
      {
        attemptId: operator.pendingEffectAttempt.id,
        contextDigest: "e".repeat(64),
        effectId: "controlled-inner-effect",
        parentEffectId: pending.id,
        operationRef: operator.operationRef,
        fenceGeneration: operator.fenceGeneration!,
        resourceId: appPlan.authDatabase.resourceId,
        sequence: 1,
        receipt: { state: "applied", readbackSha256: "f".repeat(64) },
      },
    ];
    const row = { record, revision: 7 };
    f.configuration.gateway.gitSha = "e".repeat(40);
    const read = vi.fn(async () => row);
    const assertCanonicalOwner = vi.fn(async () => {});
    const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(async () => ({
      action: "prepare",
      approved: true,
      approvalId: operator.approvalId!,
      callId: record.approvedByCallId,
      planDigest: operator.planDigest,
    }));
    const controlPlane = { ...f.controlPlane, assertCanonicalOwner, readApproval, store: { read } };
    const dependencies = composeHostedOperatorDependencies(
      f.configuration,
      // SAFETY: The focused planning branch uses only the implemented owner, approval and journal ports.
      // oxlint-disable-next-line anti-slop/no-chained-type-assertions, typescript/no-unsafe-type-assertion -- Unsupported states stop at the observed ordinary planning boundary.
      controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
    );
    return { ...f, row, read, assertCanonicalOwner, readApproval, dependencies };
  };

  it("keeps the complete original pending plan and worker evidence after configured source changes", async () => {
    const f = await setup();
    const before = structuredClone(f.row);
    const planned = await f.dependencies.plan({
      ...context,
      action: "prepare",
      normalActorProgram: before.record.operator!.plan.normalActorProgram,
    });
    expect(planned).toEqual(before.record.operator!.plan);
    expect(planned).not.toBe(f.row.record.operator!.plan);
    expect(planned.gatewayDelivery?.gitSha).not.toBe(f.configuration.gateway.gitSha);
    expect(f.row).toEqual(before);
    expect(f.read).toHaveBeenCalledTimes(2);
    expect(f.assertCanonicalOwner).toHaveBeenCalledTimes(2);
    expect(f.readApproval).toHaveBeenCalledWith({
      ...context,
      normalActorProgram: before.record.operator!.plan.normalActorProgram,
      action: "prepare",
      callId: before.record.approvedByCallId,
      planDigest: before.record.operator!.planDigest,
    });
    expect(f.unexpectedPort).not.toHaveBeenCalled();
    expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
    expect(f.readCapturedRealmIdentityProof).not.toHaveBeenCalled();
  });

  it("proposes only the future Gateway source after the original pending receipt is cleared", async () => {
    const f = await setup();
    const operator = f.row.record.operator!;
    operator.receipts.push({
      effectId: operator.pendingEffectId!,
      observedAt: "2026-10-20T12:00:00Z",
      resourceVersion: "controlled-observation",
    });
    delete operator.pendingEffectId;
    delete operator.pendingEffectAttempt;
    const before = structuredClone(f.row);
    const planned = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(planned).toEqual({
      ...before.record.operator!.plan,
      gatewayDelivery: {
        ...before.record.operator!.plan.gatewayDelivery,
        gitSha: f.configuration.gateway.gitSha,
      },
    });
    expect(f.row).toEqual(before);
    expect(f.readApproval.mock.calls[0]?.[0].planDigest).toBe(before.record.operator!.planDigest);
    expect(f.unexpectedPort).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    "re-exposes the exact saved source proposal after a lost response (approved=%s)",
    async (approved) => {
      const f = await setup();
      const original = structuredClone(f.row.record.operator!);
      const approvedByCallId = f.row.record.approvedByCallId;
      delete original.pendingEffectId;
      delete original.pendingEffectAttempt;
      const proposal = hostedOperatorPlanSchema.parse({
        ...original.plan,
        gatewayDelivery: {
          ...original.plan.gatewayDelivery,
          gitSha: f.configuration.gateway.gitSha,
        },
      });
      f.row.record.operator = {
        ...original,
        plan: proposal,
        planDigest: operatorPlanDigest(proposal),
        approvalId: approved ? "successor-approval" : undefined,
        retainedGatewayDeliveries: [{ approvedByCallId, operator: original }],
      };
      f.row.record.approvedByCallId = approved ? "successor-call" : "operator:unapproved-plan";
      f.readApproval.mockImplementation(async (input) => ({
        action: "prepare",
        approved: true,
        approvalId:
          input.planDigest === original.planDigest ? original.approvalId! : "successor-approval",
        callId: input.callId,
        planDigest: input.planDigest,
      }));
      const before = structuredClone(f.row);
      for (let attempt = 0; attempt < 2; attempt += 1) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Lost-response replay must observe the same saved proposal sequentially.
        const planned = await f.dependencies.plan({
          ...context,
          action: "prepare",
          normalActorProgram: proposal.normalActorProgram,
        });
        expect(planned).toEqual(proposal);
        expect(f.row).toEqual(before);
        expect(f.row.record.operator!.operationRef).toBe(original.operationRef);
      }
      const approvalsPerRead = approved ? 2 : 1;
      expect(f.readApproval).toHaveBeenCalledTimes(approvalsPerRead * 2);
      expect(f.readCapturedRealmIdentity).not.toHaveBeenCalled();
      expect(f.unexpectedPort).not.toHaveBeenCalled();
    },
  );

  it("accepts ordinary receipt progress under the same approval at the fresh canonical read", async () => {
    const f = await setup();
    const later = structuredClone(f.row);
    const operator = later.record.operator!;
    operator.receipts.push({
      effectId: operator.pendingEffectId!,
      observedAt: "2026-10-20T12:00:00Z",
      resourceVersion: "new-observation",
    });
    delete operator.pendingEffectId;
    delete operator.pendingEffectAttempt;
    later.revision += 1;
    f.read.mockResolvedValueOnce(f.row).mockResolvedValueOnce(later);
    const planned = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(planned.gatewayDelivery?.gitSha).toBe(f.configuration.gateway.gitSha);
    expect(operatorPlanDigest(f.row.record.operator!.plan)).toBe(f.row.record.operator!.planDigest);
  });

  it.each(["program", "signup"] as const)(
    "does not hide a changed supplied product %s behind a source continuation",
    async (input) => {
      const f = await setup();
      const ordinary = new Error("controlled ordinary product planning");
      const selection = vi
        .spyOn(planningAuthority, "readOwnedOperatorPlanningSelection")
        .mockRejectedValueOnce(ordinary);
      const program = structuredClone(f.row.record.operator!.plan.normalActorProgram!);
      program.actors[0]!.name = "Revised ordinary product name";
      await expect(
        f.dependencies.plan({
          ...context,
          action: "prepare",
          ...(input === "program"
            ? { normalActorProgram: program }
            : {
                authSignupPolicy: {
                  version: 1,
                  appPath: "/review",
                  appRoles: ["member"],
                  eligibility: "public",
                  membershipRole: "member",
                  organizationId: "first-org",
                },
              }),
        }),
      ).rejects.toBe(ordinary);
      expect(selection).toHaveBeenCalledOnce();
      expect(f.readApproval).not.toHaveBeenCalled();
    },
  );

  it("provides only the trusted configured source without per-effect owner or provider requests", async () => {
    const f = await setup();
    expect(await f.dependencies.readGatewayDeliverySource!(context)).toEqual({
      branch: f.configuration.gateway.branch,
      gitSha: f.configuration.gateway.gitSha,
      projectId: f.configuration.gateway.projectId,
      repoId: f.configuration.gateway.repoId,
    });
    expect(f.assertCanonicalOwner).not.toHaveBeenCalled();
    expect(f.read).not.toHaveBeenCalled();
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.unexpectedPort).not.toHaveBeenCalled();
  });

  it.each(["approval", "call", "digest", "action", "denied"] as const)(
    "retains original %s approval authority",
    async (mismatch) => {
      const f = await setup();
      f.readApproval.mockResolvedValueOnce({
        action: mismatch === "action" ? "cleanup" : "prepare",
        approved: mismatch !== "denied",
        approvalId:
          mismatch === "approval" ? "foreign-approval" : f.row.record.operator!.approvalId!,
        callId: mismatch === "call" ? "foreign-call" : f.row.record.approvedByCallId,
        planDigest: mismatch === "digest" ? "0".repeat(64) : f.row.record.operator!.planDigest,
      });
      const before = structuredClone(f.row);
      await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
        code: "authorization_required",
      });
      expect(f.row).toEqual(before);
      expect(f.read).toHaveBeenCalledTimes(1);
    },
  );

  it("preserves owner and journal failures and rejects a changed canonical read", async () => {
    const owner = await setup();
    const denied = new HostedOperatorError("authorization_required");
    owner.assertCanonicalOwner.mockRejectedValueOnce(denied);
    await expect(owner.dependencies.plan({ ...context, action: "prepare" })).rejects.toBe(denied);
    expect(owner.readApproval).not.toHaveBeenCalled();
    const journal = await setup();
    const unavailable = new Error("controlled journal unavailable");
    journal.read.mockRejectedValueOnce(unavailable);
    await expect(journal.dependencies.plan({ ...context, action: "prepare" })).rejects.toBe(
      unavailable,
    );
    const raced = await setup();
    const later = structuredClone(raced.row);
    later.record.operator!.pendingEffectId = "unknown-effect";
    raced.read.mockResolvedValueOnce(raced.row).mockResolvedValueOnce(later);
    await expect(raced.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
  });

  it.each([
    "branch",
    "project",
    "repository",
    "live-lease",
    "unknown-effect",
    "orphan-attempt",
    "attempted-gateway",
  ] as const)("leaves %s states on the existing ordinary planning path", async (state) => {
    const f = await setup();
    if (state === "branch") {
      f.configuration.gateway.branch = "different-branch";
    }
    if (state === "project") {
      f.configuration.gateway.projectId = "different-project";
    }
    if (state === "repository") {
      f.configuration.gateway.repoId = "different-repository";
    }
    if (state === "live-lease") {
      f.row.record.leaseId = "live-lease";
      f.row.record.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    }
    if (state === "unknown-effect") {
      f.row.record.operator!.pendingEffectId = "unknown-effect";
    }
    if (state === "orphan-attempt") {
      delete f.row.record.operator!.pendingEffectId;
    }
    if (state === "attempted-gateway") {
      f.row.record.operator!.pendingEffectId = "gateway-delivery";
    }
    const ordinary = new Error("controlled ordinary planning path");
    const selection = vi
      .spyOn(planningAuthority, "readOwnedOperatorPlanningSelection")
      .mockRejectedValueOnce(ordinary);
    const before = structuredClone(f.row);
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toBe(ordinary);
    expect(selection).toHaveBeenCalledOnce();
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.row).toEqual(before);
  });
});

describe("existing populated Auth workflow planning", () => {
  const setup = (mode: "current" | "retained" | "adopted" | "empty") => {
    const f = publicationFixture();
    f.readCapturedRealmIdentity.mockResolvedValue(null);
    const original = existingAuthRecord();
    const row = { record: original, revision: 1 };
    const sourceOwner = context.ownerContext;
    if (sourceOwner === undefined) {
      throw new Error("Fixture owner is missing.");
    }
    const sourceContext = {
      ...context,
      target: { ...context.target, appId: "source", sessionId: "source-session" },
      ownerContext: { ...sourceOwner, sessionId: "source-session" },
    };
    const sourcePlan = {
      ...original.operator!.plan,
      selection: {
        ...original.operator!.plan.selection,
        appId: "source",
        sessionId: "source-session",
      },
    };
    const sourceRow = { record: existingAuthRecord(sourcePlan), revision: 2 };
    if (mode === "retained") {
      original.retainedAuth = retainedOperatorAuthFromJournal(original);
      original.operator = {
        ...original.operator!,
        approvalId: undefined,
        plan: {
          ...original.operator!.plan,
          action: "cleanup",
          stage: "app",
          contextId: "next-spec",
          effects: [
            { description: "revoke", id: "revoke", kind: "revoke" },
            { description: "remove", id: "remove-bindings", kind: "remove-bindings" },
            { description: "retire", id: "retire", kind: "retire", resourceId: "app-resource" },
          ],
        },
      };
      original.operator.planDigest = operatorPlanDigest(original.operator.plan);
    }
    if (mode === "adopted") {
      f.configuration.applications.actual!.authAdoptionSource = {
        ownerContext: sourceContext.ownerContext,
        target: sourceContext.target,
      };
    }
    const adopted =
      mode === "adopted"
        ? {
            adoption: {
              kind: "owned-journal-auth-v1" as const,
              resource: {
                authDatabase: resource("auth"),
                branchId: "br-fixture",
                endpoint: "ep-fixture.neon.tech",
                endpointId: "ep-fixture",
                projectId: "neon-fixture",
              },
              source: {
                checkpointSha256: "1".repeat(64),
                journalDigest: "2".repeat(64),
                operationRef: sourceRow.record.operator!.operationRef,
                planDigest: sourceRow.record.operator!.planDigest,
                selection: sourcePlan.selection,
              },
            },
            authSchema: sourcePlan.authSchema!,
            content: Buffer.from("original-source-artifact"),
          }
        : undefined;
    const migrationUrl =
      "postgresql://auth_owner:private-fixture@ep-fixture.neon.tech/auth?sslmode=verify-full";
    const readResourceBindings = vi.fn(
      async (
        _input: Parameters<
          Parameters<typeof composeHostedOperatorDependencies>[1]["readResourceBindings"]
        >[0],
      ) => ({
        authDatabase: { migrationUrl, runtimeUrl: "private-runtime" },
        appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
      }),
    );
    const propose = vi.fn(
      async (
        input: Parameters<ReturnType<typeof authProposal.createHostedOperatorAuthProposal>>[0],
      ) => {
        await input.assertCurrentOwner();
        return {
          content: Buffer.from("observed-existing-plan"),
          planDigest: "3".repeat(64),
          targetDigest: "4".repeat(64),
        };
      },
    );
    vi.spyOn(authProposal, "createHostedOperatorAuthProposal").mockReturnValue(propose);
    vi.spyOn(planningAuthority, "readOwnedOperatorPlanningSelection").mockResolvedValue({
      currentSpec: { appSpecDigest: "new-spec" },
      selection: {
        artifactRef: "release-artifact",
        releaseId: "release",
        manifestSha256: "b".repeat(64),
      },
    } as Awaited<ReturnType<typeof planningAuthority.readOwnedOperatorPlanningSelection>>);
    vi.spyOn(nativePlanning, "createNativePreviewNeonPlanningAuthority").mockReturnValue(
      {} as ReturnType<typeof nativePlanning.createNativePreviewNeonPlanningAuthority>,
    );
    vi.spyOn(neonReader, "createPreviewNeonMcpReader").mockReturnValue({
      inspectPlanningTarget: vi.fn(async () => {}),
    } as unknown as ReturnType<typeof neonReader.createPreviewNeonMcpReader>);
    vi.spyOn(providerInventory, "readHostedOperatorProviderInventory").mockResolvedValue({
      app: {
        deployedEnvironmentKeys: [],
        projectEnvironmentKeys: [],
        branch: context.target.branch,
        projectId: context.target.projectId,
        deploymentId: "app-deployment",
        environment: "preview",
      },
      gateway: {
        deployedEnvironmentKeys: [],
        projectEnvironmentKeys: [],
        branch: "gateway-actual",
        projectId: "gateway",
        deploymentId: "gateway-deployment",
        environment: "preview",
      },
      operator: {
        branch: null,
        deployedEnvironmentKeys: [],
        projectEnvironmentKeys: [],
        projectId: "operator",
        deploymentId: "operator-deployment",
        environment: "preview",
      },
      verification: {
        publicKeyIds: null,
        gatewayOrigin: "https://gateway.example",
        publicOrigin: "https://apps.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
      },
      appEnvironment: { deployedKeyInventory: "observed", forbiddenKeys: [] },
      nativeResource: null,
      previewBranch: { status: "unconfirmed", reason: "fixture" },
      protectedAppGrantPolicy: "unconfirmed",
      scopeId: "team",
      scopeType: "team",
    });
    const controlPlane = {
      ...f.controlPlane,
      assertPlanningAuthorized: vi.fn(async () => {}),
      store: {
        read: vi.fn(async (input: HostedOperatorContext) =>
          input.target.appId === "source"
            ? sourceRow
            : mode === "empty" || mode === "adopted"
              ? undefined
              : row,
        ),
      },
      readGeneratedRelease: vi.fn(async () => ({})),
      readActiveSharedAuth: vi.fn(async () => undefined),
      readSharedAuthAdoption: vi.fn(async () => adopted),
      readResourceBindings,
      publishAuthPlan: vi.fn(async () => "new-observed-artifact"),
    };
    const dependencies = composeHostedOperatorDependencies(
      f.configuration,
      controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
    );
    return {
      ...f,
      dependencies,
      controlPlane,
      original,
      row,
      sourceRow,
      sourceContext,
      propose,
      migrationUrl,
      readResourceBindings,
    };
  };
  const retainedAuthReadinessFixture = async () => {
    const sql = "select 'controlled-readiness-fixture'";
    const assetSha256 = createHash("sha256").update(sql).digest("hex");
    const snapshot = {
      database: "auth",
      role: "auth_runtime",
      login: "auth_runtime",
      readiness: {
        algorithm: "pg-jsonb-catalog-sha256-v1",
        assetSha256,
        database: "auth",
        observedFingerprint: "e".repeat(64),
        publishedFingerprint: "e".repeat(64),
        status: "verified",
        targetDigest: "f".repeat(64),
        version: 1,
      },
    };
    const readSnapshot = vi.fn(async () => snapshot);
    const assertAuthorized = vi.fn(async () => {});
    const createReadiness = authReadiness.createHostedOperatorAuthReadiness;
    vi.spyOn(authReadiness, "createHostedOperatorAuthReadiness").mockImplementation((ports) =>
      createReadiness({ ...ports, assertAuthorized, readSnapshot }),
    );
    const f = setup("current");
    const participant = participantResolutionFixture();
    const prior = participant.base;
    const completed = existingAuthRecord(prior);
    const operator = completed.operator!;
    operator.authPreparation!.assetSha256 = assetSha256;
    operator.gatewayEnvironment = [
      {
        branch: prior.gatewayDelivery!.branch,
        comment: `App Builder protected operator ${operator.operationRef}`,
        id: "retained-gateway-binding",
        key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
        operationRef: operator.operationRef,
        projectId: prior.gatewayDelivery!.projectId,
        valueSha256: hostedOperatorRealmLinkConfigSha256(prior),
      },
    ];
    operator.deliveredGatewayDeploymentId = "retained-gateway";
    operator.gatewayDeliveryCandidates = [
      {
        branch: prior.gatewayDelivery!.branch,
        projectId: prior.gatewayDelivery!.projectId,
        repoId: prior.gatewayDelivery!.repoId,
        deploymentId: "retained-gateway",
        operationRef: operator.operationRef,
        origin: "https://gateway.example",
        readyState: "READY",
      },
    ];
    const retained = retainedOperatorAuthFromJournal(completed)!;
    const app = await resolveFullPlan(
      prior,
      context,
      participant.configuration,
      participant.ports,
      {},
      true,
      true,
    );
    const appPlan = hostedOperatorPlanSchema.parse({
      ...app,
      contextId: "new-spec",
      gatewayBindings: prior.gatewayBindings,
      gatewayDelivery: prior.gatewayDelivery,
      publicGateway: prior.publicGateway,
      installer: { reference: "worker", sha256: "a".repeat(64) },
    });
    f.row.record = hostedRuntimeJournalRecordSchema.parse({
      ...completed,
      approvedByCallId: "current-app-call",
      retainedAuth: retained,
      operator: {
        ...operator,
        approvalId: "current-app-approval",
        operationRef: "00000000-0000-4000-8000-000000000002",
        plan: appPlan,
        planDigest: operatorPlanDigest(appPlan),
        receipts: operator.receipts.filter((receipt) =>
          ["auth-resources", "app-resources", "auth-schema"].includes(receipt.effectId),
        ),
      },
    });
    f.propose.mockResolvedValue({
      content: Buffer.from("controlled original Auth proposal"),
      planDigest: prior.authSchema!.planDigest,
      targetDigest: prior.authSchema!.targetDigest,
    });
    f.controlPlane.publishAuthPlan.mockResolvedValue(prior.authSchema!.artifactRef);
    const readApproval = vi.fn(async () => ({
      approved: true,
      approvalId: retained.approvalId,
      callId: retained.approvedByCallId,
      planDigest: retained.planDigest,
      action: "prepare",
    }));
    Object.assign(f.controlPlane, {
      assertAuthorized,
      readApproval,
      readNormalActorPreparation: vi.fn(async () => undefined),
      readAuthPlan: vi.fn(async () => ({
        content: Buffer.from(
          JSON.stringify({
            schemaPlan: {
              planDigest: prior.authSchema!.planDigest,
              targetDigest: prior.authSchema!.targetDigest,
              effects: [{ owner: "readiness", sha256: assetSha256, sql }],
            },
          }),
        ),
      })),
    });
    f.readResourceBindings.mockImplementation(async (input) => {
      const row = requireFinalResourceBindingPhase(
        selectAuthPlanningResourceBindingRow(f.row, input.plan),
        input,
      );
      const approval = await readApproval();
      if (
        !approval.approved ||
        approval.approvalId !== row.record.operator!.approvalId ||
        approval.callId !== row.record.approvedByCallId ||
        approval.planDigest !== row.record.operator!.planDigest
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return {
        authDatabase: {
          migrationUrl: f.migrationUrl,
          runtimeUrl:
            "postgresql://auth_runtime:synthetic-password@ep-fixture.neon.tech/auth?sslmode=verify-full",
        },
        appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
      };
    });
    return { ...f, retained, snapshot, readSnapshot, readApproval, assertAuthorized, participant };
  };

  const settledAppPlanningFixture = async () => {
    const f = await retainedAuthReadinessFixture();
    f.planningSession.privateBuildDecision = {
      adapterSessionId: f.planningSession.adapterSessionId,
      currentSpec: {
        appId: context.target.appId,
        appSpecDigest: "new-spec",
        sessionId: f.planningSession.adapterSessionId,
        workspaceId: "current-source-workspace",
      },
      decision: "blocked",
      turnId: "accepted-turn",
      turnSequence: 1,
      version: 1,
      workflowPhase: "applied",
    };
    const record = f.row.record;
    const operator = record.operator!;
    f.configuration.applications.actual!.repoId = "actual-repository-id";
    f.configuration.applications.actual!.gitSha = "c".repeat(40);
    vi.mocked(planningAuthority.readOwnedOperatorPlanningSelection).mockResolvedValue({
      currentSpec: { appSpecDigest: "new-spec" },
      selection: {
        artifactRef: "release-artifact",
        releaseId: "release",
        manifestSha256: "b".repeat(64),
        publishedSource: {
          repositoryId: "actual-repository-id",
          branch: context.target.branch,
          gitSha: "c".repeat(40),
          gitTree: "a".repeat(40),
          changeSetDigest: "b".repeat(64),
          reviewDigest: "c".repeat(64),
        },
      },
    } as Awaited<ReturnType<typeof planningAuthority.readOwnedOperatorPlanningSelection>>);
    const originalAuth = record.retainedAuth!;
    originalAuth.plan.gatewayDelivery!.gitSha = "a".repeat(40);
    originalAuth.planDigest = operatorPlanDigest(originalAuth.plan);
    operator.plan.gatewayDelivery!.gitSha = f.configuration.gateway.gitSha;
    operator.plan.neon.connectionRef = f.configuration.nativeNeon.configuration.connector;
    // The prepared APP plan and provider row describe the same current realm configuration.
    operator.plan.gatewayBindings = configuredBootstrapGatewayBindings(f.configuration);
    operator.planDigest = operatorPlanDigest(operator.plan);
    operator.receipts = operator.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-10-15T12:00:00Z",
      resourceVersion: "settled-app-readback",
      ...(["access", "revoke"].includes(effect.kind)
        ? { fenceGeneration: operator.fenceGeneration }
        : {}),
    }));
    operator.gatewayEnvironment![0].valueSha256 = hostedOperatorRealmLinkConfigSha256(
      operator.plan,
    );
    const candidate = operator.gatewayDeliveryCandidates![0]!;
    candidate.operationRef = operator.operationRef;
    candidate.deploymentId = "settled-current-gateway";
    operator.deliveredGatewayDeploymentId = candidate.deploymentId;
    record.accountPreparation = f.participant.preparation;
    record.status = "prepared";
    record.step = "bound";
    record.environmentBound = true;
    record.proof = {
      actors: 1,
      tenants: 2,
      authenticatedBehavior: "unassessed",
      artifactHash: "a".repeat(64),
      manifestSha256: operator.plan.release.sha256,
      releaseId: operator.plan.release.id,
    };
    const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
      async (input) => {
        const auth =
          input.planDigest === originalAuth.planDigest
            ? originalAuth
            : {
                approvalId: operator.approvalId!,
                approvedByCallId: record.approvedByCallId,
                planDigest: operator.planDigest,
              };
        return {
          action: "prepare",
          approved: true,
          approvalId: auth.approvalId,
          callId: auth.approvedByCallId,
          planDigest: auth.planDigest,
        };
      },
    );
    const assertCanonicalOwner = vi.fn(async () => {});
    f.readResourceBindings.mockImplementation(async (input) => {
      const authorized = requireFinalResourceBindingPhase(
        selectAuthPlanningResourceBindingRow(f.row, input.plan),
        input,
      );
      const approved = await readApproval({
        ...context,
        action: "prepare",
        callId: authorized.record.approvedByCallId,
        planDigest: authorized.record.operator!.planDigest,
      });
      if (
        approved?.approvalId !== authorized.record.operator!.approvalId ||
        approved?.approved !== true
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return {
        authDatabase: {
          migrationUrl: f.migrationUrl,
          runtimeUrl:
            "postgresql://auth_runtime:synthetic-password@ep-fixture.neon.tech/auth?sslmode=verify-full",
        },
        appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
      };
    });
    f.participant.ports.readNormalActorOrganizationProofs.mockClear();
    Object.assign(f.controlPlane, {
      readApproval,
      assertCanonicalOwner,
      readNormalActorPreparation: f.participant.ports.readNormalActorPreparation,
      readNormalActorOrganizationProofs: f.participant.ports.readNormalActorOrganizationProofs,
    });
    return {
      ...f,
      originalAuth,
      appApprovalId: operator.approvalId!,
      appPlanDigest: operator.planDigest,
      readApproval,
      assertCanonicalOwner,
      readOrganizations: f.participant.ports.readNormalActorOrganizationProofs,
    };
  };

  it("binds a registered target's new proposal to captured current roles", async () => {
    const f = await settledAppPlanningFixture();
    f.configuration.applications.actual!.nativeTargetRegistration = true;
    vi.mocked(f.controlPlane.readGeneratedRelease).mockResolvedValue({
      description: { backend: { kind: "generated-postgres", roles: [] } },
    } as Awaited<ReturnType<typeof f.controlPlane.readGeneratedRelease>>);

    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(f.controlPlane.readGeneratedRelease).toHaveBeenCalledOnce();
  });

  it("requires captured current roles for a registered target's new proposal", async () => {
    const f = await settledAppPlanningFixture();
    f.configuration.applications.actual!.nativeTargetRegistration = true;

    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(f.controlPlane.readGeneratedRelease).toHaveBeenCalledOnce();
  });

  it("composes prepared Preview restoration entirely from the selected frozen release", async () => {
    const f = await settledAppPlanningFixture();
    const application = f.configuration.applications.actual;
    if (application === undefined) {
      throw new Error("Fixture app is missing");
    }
    application.projectSettings = {
      framework: "vite",
      rootDirectory: "apps/initial-registration",
      sourceFilesOutsideRootDirectory: false,
    };
    vi.mocked(f.controlPlane.readGeneratedRelease).mockResolvedValue({
      description: appDescriptionSchema.parse({
        ...currentSourceDescription,
        backend: {
          authorization: "app-owned",
          kind: "generated-postgres",
          release: { artifactHash: "sha256:source", directory: "release", id: "current-release" },
          roles: ["member"],
          runtime: { databaseEnvironment: "APP_DATABASE_URL" },
        },
      }),
    } as Awaited<ReturnType<typeof f.controlPlane.readGeneratedRelease>>);
    const readSelection = vi.mocked(planningAuthority.readOwnedOperatorPlanningSelection);
    const frozenSelection = {
      appId: context.target.appId,
      appSpecDigest: "f".repeat(64),
      artifactRef: "prepared-release-artifact",
      releaseId: "prepared-release",
      manifestSha256: "d".repeat(64),
      schemaSha256: "e".repeat(64),
      version: 1 as const,
      publishedSource: {
        repositoryId: "actual-repository-id",
        branch: context.target.branch,
        gitSha: "c".repeat(40),
        gitTree: "a".repeat(40),
        changeSetDigest: "b".repeat(64),
        reviewDigest: "c".repeat(64),
      },
    };
    const assertCurrent = vi.fn(async () => {});
    readSelection.mockResolvedValue({
      currentSpec: {
        appId: context.target.appId,
        appSpecDigest: "a".repeat(64),
        sessionId: "adapter",
        workspaceId: "sandbox",
      },
      approvedScope: undefined,
      selection: frozenSelection,
      contextId: "prepared-context",
      assertCurrent,
    });
    const result = await f.dependencies.plan({
      ...context,
      action: "prepare",
      releaseIntent: "prepared-preview",
    });
    expect(readSelection).toHaveBeenCalledWith({
      context: { ...context, action: "prepare", releaseIntent: "prepared-preview" },
      controlPlane: f.controlPlane,
      releaseIntent: "prepared-preview",
    });
    expect(result.releaseIntent).toBe("prepared-preview");
    expect(result.contextId).toBe("prepared-context");
    expect(result.release).toEqual({
      artifactRef: frozenSelection.artifactRef,
      id: frozenSelection.releaseId,
      sha256: frozenSelection.manifestSha256,
    });
    expect(result.delivery?.gitSha).toBe(frozenSelection.publishedSource?.gitSha);
    expect(result.delivery?.projectSettings).toEqual({
      framework: "nextjs",
      rootDirectory: "apps/current-source",
      sourceFilesOutsideRootDirectory: true,
    });
    expect(f.configuration.applications.actual?.projectSettings?.rootDirectory).toBe(
      "apps/initial-registration",
    );
    expect(f.controlPlane.readGeneratedRelease).toHaveBeenCalledWith(
      expect.objectContaining(context),
      frozenSelection,
    );
    expect(assertCurrent).toHaveBeenCalled();
  });
  it("replans a settled app using original Auth and independently approved current Gateway", async () => {
    const f = await settledAppPlanningFixture();
    const before = structuredClone(f.row.record);
    expect(retainedOperatorAuthFromJournal(f.row.record)).toBeDefined();
    expect(
      inspectParticipantBootstrapPreparation(f.row.record.operator!.plan, f.row.record)
        .gatewayPrepared,
    ).toBe(true);
    expect(
      inspectPlanningParticipantBootstrap(f.row.record.operator!.plan, f.row.record),
    ).toBeDefined();
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(plan.stage).toBe("app");
    expect(plan.gatewayDelivery?.gitSha).toBe(f.configuration.gateway.gitSha);
    expect(plan.normalActorPreparation?.accountApprovalId).toBe(
      f.participant.preparation.accountApprovalId,
    );
    for (const planDigest of [f.originalAuth.planDigest, f.appPlanDigest]) {
      expect(f.readApproval).toHaveBeenCalledWith(expect.objectContaining({ planDigest }));
    }
    expect(f.readOrganizations).toHaveBeenCalled();
    expect(f.row.record).toEqual(before);
  });

  it("persists both settled authorities through the actual plan reservation and next planning read", async () => {
    const f = await settledAppPlanningFixture();
    const original = structuredClone(f.row.record);
    const store: ProtectedHostedOperatorDependencies["store"] = {
      read: async () => structuredClone(f.row),
      reserve: async () => structuredClone(f.row),
      compareAndSet: async (input) => {
        if (input.expectedRevision !== f.row.revision) {
          return undefined;
        }
        f.row.record = hostedRuntimeJournalRecordSchema.parse(input.record);
        f.row.revision += 1;
        return structuredClone(f.row);
      },
      reserveFenceGeneration: async () => {
        throw new Error("Planning must not acquire an execution fence");
      },
    };
    Object.assign(f.controlPlane.store, store);
    const executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(async () => {
      throw new Error("Planning must not execute an outward effect");
    });
    const handler = createProtectedHostedOperatorHandler({
      ...f.dependencies,
      store,
      authorize: async () => context,
      assertAuthorized: async () => {
        await f.assertCanonicalOwner();
      },
      readApproval: f.readApproval,
      withResourceLease: async () => {
        throw new Error("Planning must not lease an outward effect");
      },
      executeEffect,
    });
    const response = await handler(
      new Request("https://operator.example/v1/runtime", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "plan",
          operation: "prepare",
          selection: original.operator!.plan.selection,
        }),
      }),
    );
    const result = operatorPublicResultSchema.parse(await response.json());
    expect(result.status).toBe("planned");
    expect(f.row.record.status).toBe("pending");
    expect(f.row.record.step).toBe("reserved");
    expect(f.row.record.operator?.approvalId).toBeUndefined();
    expect(f.row.record.retainedAuth?.approvalId).toBe(original.retainedAuth?.approvalId);
    expect(f.row.record.retainedParticipantGateway?.completion.approvalId).toBe(
      original.operator?.approvalId,
    );
    expect(f.row.record.retainedParticipantGateway?.candidate.deploymentId).toBe(
      original.operator?.deliveredGatewayDeploymentId,
    );
    expect(f.row.record.accountPreparation).toEqual(original.accountPreparation);
    expect(f.row.record.privateState).toEqual(original.privateState);
    expect(executeEffect).not.toHaveBeenCalled();
    const replay = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(replay.stage).toBe("app");
    expect(replay.gatewayDelivery?.gitSha).toBe(f.configuration.gateway.gitSha);
    expect(f.row.record.retainedParticipantGateway?.completion.planDigest).toBe(f.appPlanDigest);
  });

  it.each(["auth", "app"] as const)(
    "rejects settled app planning without its %s approval",
    async (missing) => {
      const f = await settledAppPlanningFixture();
      const read = f.readApproval.getMockImplementation()!;
      f.readApproval.mockImplementation(async (input) =>
        input.planDigest === (missing === "auth" ? f.originalAuth.planDigest : f.appPlanDigest)
          ? null
          : await read(input),
      );
      await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
        code: missing === "auth" ? "operator_unavailable" : "authorization_required",
      });
      expect(f.readApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          planDigest: missing === "auth" ? f.originalAuth.planDigest : f.appPlanDigest,
        }),
      );
      expect(f.readOrganizations).not.toHaveBeenCalled();
    },
  );

  it("rechecks the completed Gateway snapshot after reading organization evidence", async () => {
    const f = await settledAppPlanningFixture();
    f.readOrganizations.mockImplementation(async () => {
      f.row.record.operator!.gatewayDeliveryCandidates![0]!.readyState = "ERROR";
      return f.participant.organizations;
    });
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "operation_in_progress",
    });
  });

  it("rejects current-owner revocation before borrowing settled app bootstrap authority", async () => {
    const f = await settledAppPlanningFixture();
    f.assertCanonicalOwner.mockRejectedValue(new HostedOperatorError("authorization_required"));
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.readOrganizations).not.toHaveBeenCalled();
  });

  it("uses completed retained Auth readiness while the app has only its three prerequisite receipts", async () => {
    const f = await retainedAuthReadinessFixture();
    const before = structuredClone(f.row);
    expect(() =>
      requireFinalResourceBindingPhase(f.row, {
        plan: f.row.record.operator!.plan,
        privateState: f.row.record.privateState,
      }),
    ).toThrow();
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(plan.stage).toBe("auth-participants");
    expect(f.readSnapshot).toHaveBeenCalled();
    expect(f.assertAuthorized).toHaveBeenCalled();
    expect(f.readApproval).toHaveBeenCalled();
    expect(
      f.readResourceBindings.mock.calls.every(
        ([input]) => operatorPlanDigest(input.plan) === f.retained.planDigest,
      ),
    ).toBe(true);
    expect(f.row).toEqual(before);
  });

  it.each(["auth-resources", "auth-schema", "unknown-effect"])(
    "retained Auth readiness rejects a pending %s mutation",
    async (effectId) => {
      const f = await retainedAuthReadinessFixture();
      f.row.record.operator!.pendingEffectId = effectId;
      f.row.record.operator!.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000003" };
      await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
        code: "operation_in_progress",
      });
      expect(f.readSnapshot).not.toHaveBeenCalled();
    },
  );

  it.each(["targetDigest", "assetSha256", "publishedFingerprint"] as const)(
    "retained Auth readiness rejects a changed %s publication",
    async (field) => {
      const f = await retainedAuthReadinessFixture();
      f.readSnapshot.mockResolvedValue({
        ...f.snapshot,
        readiness: { ...f.snapshot.readiness, [field]: "0".repeat(64) },
      });
      await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
        code: "operator_unavailable",
      });
      expect(f.readSnapshot).toHaveBeenCalled();
    },
  );

  it("retained Auth readiness rejects changed original approval", async () => {
    const f = await retainedAuthReadinessFixture();
    f.readApproval.mockResolvedValue({
      approved: false,
      approvalId: f.retained.approvalId,
      callId: f.retained.approvedByCallId,
      planDigest: f.retained.planDigest,
      action: "prepare",
    });
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.readSnapshot).not.toHaveBeenCalled();
  });

  it("plans retained Auth infrastructure before looking up an unvalidated accepted app revision", async () => {
    const f = setup("current");
    const participants = participantResolutionFixture();
    const completed = existingAuthRecord(participants.base);
    const retainedAuth = retainedOperatorAuthFromJournal(completed)!;
    f.row.record = hostedRuntimeJournalRecordSchema.parse({
      ...completed,
      status: "participants-prepared",
      retainedAuth,
      accountPreparation: participants.preparation,
      operator: {
        ...completed.operator!,
        operationRef: participants.preparation.accountOperationRef,
        plan: participants.accountPlan,
        planDigest: participants.preparation.accountPlanDigest,
        approvalId: participants.preparation.accountApprovalId,
        receipts: [
          {
            effectId: "normal-accounts",
            observedAt: "2026-10-15T12:00:00Z",
            resourceVersion: "actual-accounts",
          },
        ],
      },
      approvedByCallId: participants.preparation.accountApprovedByCallId,
    });
    f.configuration.gateway.gitSha = "e".repeat(40);
    const selection = vi.mocked(planningAuthority.readOwnedOperatorPlanningSelection);
    selection.mockResolvedValue({
      currentSpec: { appSpecDigest: "new-unvalidated-spec" },
      selection: undefined,
    } as Awaited<ReturnType<typeof planningAuthority.readOwnedOperatorPlanningSelection>>);
    const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(async () => ({
      action: "prepare" as const,
      approved: true,
      approvalId: retainedAuth.approvalId,
      callId: retainedAuth.approvedByCallId,
      planDigest: retainedAuth.planDigest,
    }));
    Object.assign(f.controlPlane, { readApproval });
    const before = structuredClone(f.row.record);
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(plan.stage).toBe("auth-bootstrap");
    expect(plan.contextId).toBe(retainedAuth.plan.contextId);
    expect(plan.release).toEqual(retainedAuth.plan.release);
    expect(plan.access).toEqual([]);
    expect(plan.gatewayDelivery?.gitSha).toBe(f.configuration.gateway.gitSha);
    expect(plan.effects.map((effect) => effect.kind)).not.toEqual(
      expect.arrayContaining([
        "normal-accounts",
        "auth-membership",
        "access",
        "delivery",
        "bindings",
      ]),
    );
    expect(selection).not.toHaveBeenCalled();
    expect(f.controlPlane.readGeneratedRelease).not.toHaveBeenCalled();
    expect(f.row.record).toEqual(before);
    expect(readApproval).toHaveBeenCalled();
    readApproval.mockResolvedValueOnce(null);
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.row.record).toEqual(before);
    f.controlPlane.assertPlanningAuthorized.mockRejectedValueOnce(
      new HostedOperatorError("authorization_required"),
    );
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(f.row.record).toEqual(before);
    let approved = false;
    let fence = 1;
    const executed: string[] = [];
    const receipt = (input: HostedOperatorEffectContext) => ({
      effectId: input.effect.id,
      observedAt: new Date().toISOString(),
      resourceVersion: "independent-fixture-readback",
    });
    const store: ProtectedHostedOperatorDependencies["store"] = {
      read: async () => structuredClone(f.row),
      reserve: async () => structuredClone(f.row),
      compareAndSet: async (input) => {
        if (input.expectedRevision !== f.row.revision) {
          return undefined;
        }
        f.row.record = hostedRuntimeJournalRecordSchema.parse(input.record);
        f.row.revision += 1;
        return structuredClone(f.row);
      },
      reserveFenceGeneration: async (input) => {
        if (input.expectedRevision !== f.row.revision || input.leaseId !== f.row.record.leaseId) {
          return undefined;
        }
        fence += 1;
        f.row.record.operator!.fenceGeneration = fence;
        f.row.revision += 1;
        return structuredClone(f.row);
      },
    };
    Object.assign(f.controlPlane.store, store);
    const approvalPort: ProtectedHostedOperatorDependencies["readApproval"] = async (input) => {
      if (
        input.planDigest === retainedAuth.planDigest &&
        input.callId === retainedAuth.approvedByCallId
      ) {
        return {
          action: "prepare",
          approved: true,
          approvalId: retainedAuth.approvalId,
          callId: retainedAuth.approvedByCallId,
          planDigest: retainedAuth.planDigest,
        };
      }
      return approved && input.callId === "new-bootstrap-call"
        ? {
            action: "prepare",
            approved: true,
            approvalId: "new-bootstrap-approval",
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null;
    };
    Object.assign(f.controlPlane, { readApproval: approvalPort });
    const deps: ProtectedHostedOperatorDependencies = {
      ...f.dependencies,
      store,
      authorize: async () => context,
      assertAuthorized: async (input) => {
        expect(input.authority).toEqual(context.authority);
        expect(input.plan.selection).toEqual(plan.selection);
        await f.controlPlane.assertPlanningAuthorized();
      },
      readApproval: approvalPort,
      readApprovedPlan: async () => null,
      withResourceLease: async (_input, run) => await run(async () => {}),
      reconcile: async (input) => {
        await input.assertCurrent();
        return ["resources", "install"].includes(input.effect.kind)
          ? { status: "applied", receipt: receipt(input) }
          : { status: "absent" };
      },
      executeEffect: async (input) => {
        await input.assertCurrent();
        executed.push(input.effect.kind);
        if (input.effect.kind === "gateway-delivery") {
          await input.checkpointGatewayDelivery!(
            [
              {
                deploymentId: "new-gateway",
                origin: "https://new-gateway.example",
                readyState: "READY",
                branch: plan.gatewayDelivery!.branch,
                projectId: plan.gatewayDelivery!.projectId,
                repoId: plan.gatewayDelivery!.repoId,
                operationRef: input.operationRef,
              },
            ],
            "new-gateway",
          );
        }
        return receipt(input);
      },
      verifyAuthReadiness: async (input) => {
        await input.assertCurrent();
        return retainedAuth.authPreparation;
      },
      verify: async () => {
        throw new Error("Auth bootstrap must not attest an app release");
      },
      bindings: async () => {
        throw new Error("Auth bootstrap must not expose app bindings");
      },
    };
    const handler = createProtectedHostedOperatorHandler(deps);
    const call = async (input: OperatorRequest) => {
      const response = await handler(
        new Request("https://operator.example/v1/runtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(input),
        }),
      );
      return operatorPublicResultSchema.parse(await response.json());
    };
    const proposal = await call({
      action: "plan",
      operation: "prepare",
      selection: plan.selection,
    });
    expect(proposal).toMatchObject({
      status: "planned",
      plan: { stage: "auth-bootstrap", contextId: retainedAuth.plan.contextId },
    });
    expect(f.row.record.accountPreparation).toEqual(before.accountPreparation);
    expect(f.row.record.privateState).toEqual(before.privateState);
    expect(executed).toEqual([]);
    if (proposal.operationRef === undefined || proposal.planDigest === undefined) {
      throw new Error("Missing proposed operation");
    }
    const execute: OperatorRequest = {
      action: "execute",
      selection: plan.selection,
      operationRef: proposal.operationRef,
      planDigest: proposal.planDigest,
      callId: "new-bootstrap-call",
    };
    expect(await call(execute)).toMatchObject({
      code: "authorization_required",
      status: "blocked",
    });
    expect(executed).toEqual([]);
    approved = true;
    const complete = await call(execute);
    expect(complete.code).toBeUndefined();
    expect(executed).toEqual(["gateway-bindings", "gateway-delivery"]);
    expect(f.row.record.accountPreparation).toEqual(before.accountPreparation);
    expect(f.row.record.privateState).toEqual(before.privateState);
    expect(f.row.record.operator?.plan.stage).toBe("auth-bootstrap");
    expect(f.row.record.operator?.approvalId).toBe("new-bootstrap-approval");
    expect(f.row.record.operator?.deliveredGatewayDeploymentId).toBe("new-gateway");
    expect(f.row.record.proof).toBeUndefined();
    expect(selection).not.toHaveBeenCalled();
    expect(f.controlPlane.readGeneratedRelease).not.toHaveBeenCalled();
    // Completed infrastructure is not permission to select the old app release for this changed spec.
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toMatchObject({
      code: "operator_unavailable",
    });
    expect(selection).toHaveBeenCalled();
  });

  it.each(["pending", "consumed"] as const)(
    "plans the frozen shared-host prerequisite before changed app/source inputs with a %s identity",
    async (identityState) => {
      const f = setup("current");
      const original = f.original.operator!;
      const frozen = hostedOperatorPlanSchema.parse({
        ...original.plan,
        publicGateway: {
          branch: "frozen-gateway",
          origin: "https://apps.example",
          projectId: "gateway",
        },
        gatewayDelivery: {
          branch: "frozen-gateway",
          gitSha: "c".repeat(40),
          projectId: "gateway",
          repoId: "frozen-repository",
        },
        gatewayBindings: {
          authBrowserOrigin: "https://auth.example",
          builderCallbackOrigin: "https://builder.example",
          catalogAppIds: ["actual"],
          operatorOrigin: "https://operator.example",
          sourceWorkload: f.configuration.gateway.workload,
          trustedSources: {
            builderProduction: { projectId: "builder", from: "production", to: "preview" },
            operatorPreview: { projectId: "operator", from: "preview", to: "preview" },
          },
        },
        deploymentBoundary: {
          app: {
            branch: context.target.branch,
            deploymentId: "frozen-app",
            environment: "preview",
            projectId: context.target.projectId,
          },
          gateway: {
            branch: "frozen-gateway",
            deploymentId: "frozen-gateway",
            environment: "preview",
            projectId: "gateway",
          },
          operator: {
            deploymentId: "frozen-operator",
            environment: "preview",
            projectId: "operator",
          },
          authority: context.authority,
          teamId: "team",
          verification: {
            gatewayOrigin: "https://gateway.example",
            publicOrigin: "https://apps.example",
            jwksUrl: "https://gateway.example/_platform/jwks.json",
          },
        },
        effects: [
          ...original.plan.effects,
          {
            description: "Frozen Gateway binding",
            id: "gateway-bindings",
            kind: "gateway-bindings",
          },
          {
            description: "Frozen Gateway delivery",
            id: "gateway-delivery",
            kind: "gateway-delivery",
          },
        ],
      });
      const digest = operatorPlanDigest(frozen);
      f.row.record = hostedRuntimeJournalRecordSchema.parse({
        ...f.original,
        operator: {
          ...original,
          plan: frozen,
          planDigest: digest,
          pendingEffectId: "gateway-bindings",
          pendingEffectAttempt: { id: "00000000-0000-4000-8000-000000000002" },
          identityLink: {
            audience: "https://operator.example",
            authResourceId: frozen.authDatabase.resourceId,
            bootstrapPlanDigest: digest,
            browserOrigin: "https://auth.example",
            endpointOrigin: "https://gateway.example",
            issuer: "https://apps.example",
            ownerSessionId: context.target.sessionId,
            organizationId: null,
            nonceSha256: "a".repeat(64),
            expiresAt: "2027-01-01T00:00:00Z",
            ...(identityState === "consumed"
              ? {
                  consumedAt: "2026-10-15T12:00:00Z",
                  proofRef: "captured-owner-proof",
                  proofSha256: "b".repeat(64),
                }
              : {}),
          },
        },
      });
      const before = structuredClone(f.row.record);
      f.configuration.gateway.gitSha = "e".repeat(40);
      f.configuration.gateway.branch = "new-gateway-source";
      f.configuration.applications.actual!.repoId = "new-app-repository";
      f.configuration.applications.actual!.gitSha = "f".repeat(40);
      f.readCapturedRealmIdentity.mockResolvedValue({
        audience: "https://operator.example",
        endpointOrigin: "https://gateway.example",
      });
      const next = await f.dependencies.plan({ ...context, action: "prepare" });
      const { trustedSources, ...gatewayBindings } = frozen.gatewayBindings!;
      expect(trustedSources).toBeDefined();
      expect(next).toEqual({
        ...frozen,
        gatewayBindings,
        retention: { ...frozen.retention, expiresAt: next.retention.expiresAt },
      });
      expect(f.row.record).toEqual(before);
    },
  );

  it("uses host-owned Gateway ingress while retaining native caller verification and app delivery", async () => {
    const f = setup("current");
    f.configuration.workloadPolicy.environment = "production";
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(plan.gatewayBindings?.trustedSources).toBeUndefined();
    expect(plan.gatewayDelivery?.projectId).toBe("gateway");
    expect(plan.gatewayBindings?.readonlyAttesters).toMatchObject({
      builderProduction: { projectId: "builder", environment: "production" },
      operatorPreview: { projectId: "operator", environment: "preview" },
    });
    expect(plan.gatewayBindings).toMatchObject({
      authBrowserOrigin: f.configuration.gateway.authBrowserOrigin,
      operatorOrigin: f.configuration.operator.origin,
      sourceWorkload: f.configuration.gateway.workload,
    });
    expect(plan.effects.map(({ kind }) => kind)).toEqual(
      expect.arrayContaining(["gateway-bindings", "gateway-delivery"]),
    );
  });
  it("omits app trusted sources from cleanup while retaining the approved resources and policy", async () => {
    const f = setup("current");
    const publication = publicationFixture({
      repoId: "actual-repository-id",
      gitSha: "c".repeat(40),
    });
    const appPlan = await resolveFullPlan(
      bootstrapWithGatewayOrigin("https://gateway.example"),
      context,
      publication.configuration,
      publication.controlPlane,
    );
    expect(appPlan.appTrustedSources).toBeDefined();
    f.row.record.operator!.plan = appPlan;
    f.row.record.operator!.planDigest = operatorPlanDigest(appPlan);

    const cleanup = await f.dependencies.plan({ ...context, action: "cleanup" });

    expect(cleanup.action).toBe("cleanup");
    expect(cleanup.appTrustedSources).toBeUndefined();
    expect(cleanup.appDatabase).toEqual(appPlan.appDatabase);
    expect(cleanup.authDatabase).toEqual(appPlan.authDatabase);
    expect(cleanup.authSchema).toEqual(appPlan.authSchema);
    expect(cleanup.retention).toEqual(appPlan.retention);
    expect(cleanup.cost).toEqual(appPlan.cost);
    expect(cleanup.effects.map(({ kind }) => kind)).toEqual([
      "revoke",
      "remove-bindings",
      "retire",
    ]);
  });
  it("does not invent Production source authority for a Preview Builder workload", async () => {
    const f = setup("current");
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(plan.gatewayBindings?.trustedSources).toBeUndefined();
    expect(plan.gatewayBindings?.readonlyAttesters).toBeUndefined();
  });
  it("reproposes the approved migration with the existing private binding and current fence", async () => {
    const reconcileMigration = vi.fn<
      ReturnType<typeof authReadiness.createHostedOperatorAuthReadiness>["reconcileMigration"]
    >(async (input, repropose) => {
      const proposed = await repropose(input);
      expect(proposed.toString("utf-8")).toBe("observed-existing-plan");
      return { status: "retryable", resourceVersion: "d".repeat(64) };
    });
    vi.spyOn(authReadiness, "createHostedOperatorAuthReadiness").mockReturnValue({
      reconcileMigration,
      verify: vi.fn(),
      verifyPublication: vi.fn(),
    });
    const f = setup("current");
    Object.assign(f.controlPlane, { assertAuthorized: vi.fn(async () => {}) });
    const original = f.original.operator!;
    const input: HostedOperatorEffectContext = {
      ...context,
      assertCurrent: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => {}),
      effect: { id: "auth-schema", kind: "install", description: "Install approved Auth schema" },
      fenceGeneration: 1,
      operationRef: original.operationRef,
      plan: original.plan,
      privateState: f.original.privateState,
      workerCheckpoints: [],
    };
    expect(await f.dependencies.reconcile(input)).toEqual({
      status: "retryable",
      resourceVersion: "d".repeat(64),
    });
    expect(reconcileMigration).toHaveBeenCalledOnce();
    const observed = f.propose.mock.calls[0]?.[0];
    expect(observed?.directMigrationUrl).toBe(f.migrationUrl);
    expect(observed?.resource).toEqual({
      version: 1,
      environment: "preview",
      hostname: original.plan.neon.endpoint,
      port: 5432,
      database: original.plan.authDatabase.database,
      schema: "public",
      runtimeRole: original.plan.authDatabase.runtimeRole,
      migratorRole: original.plan.authDatabase.migratorRole,
      neon: { branchId: original.plan.neon.branchId, projectId: original.plan.neon.projectId },
    });
    expect(input.assertCurrent).toHaveBeenCalled();
    expect(
      f.readResourceBindings.mock.calls.every(([binding]) => binding.plan === input.plan),
    ).toBe(true);
    expect(f.controlPlane.publishAuthPlan).not.toHaveBeenCalled();
  });
  it.each(["current", "retained"] as const)(
    "replans %s Auth with the original owner and approval binding before publishing the next plan",
    async (mode) => {
      const f = setup(mode);
      const before = structuredClone(f.row);
      const plan = await f.dependencies.plan({ ...context, action: "prepare" });
      const binding = f.readResourceBindings.mock.calls[0]?.[0];
      expect(binding).toMatchObject({
        authority: context.authority,
        target: context.target,
        ownerContext: context.ownerContext,
        plan: mode === "retained" ? f.original.retainedAuth!.plan : f.original.operator!.plan,
        privateState: f.original.privateState,
      });
      expect(f.propose).toHaveBeenCalledWith(
        expect.objectContaining({ directMigrationUrl: f.migrationUrl }),
      );
      expect(plan.authSchema).toMatchObject({
        artifactRef: "new-observed-artifact",
        targetDigest: "4".repeat(64),
        planDigest: "3".repeat(64),
      });
      expect(plan.authAdoption).toBeUndefined();
      expect(f.row).toEqual(before);
      expect(JSON.stringify(plan)).not.toContain("private-fixture");
    },
  );
  it("replans using retained approved Auth when the current unapproved plan carries preparation", async () => {
    const f = setup("current");
    const retained = retainedOperatorAuthFromJournal(f.original);
    if (retained === undefined) {
      throw new Error("Fixture completed Auth authority is missing.");
    }
    f.original.retainedAuth = retained;
    f.original.approvedByCallId = "operator:unapproved-plan";
    const operator = f.original.operator!;
    operator.approvalId = undefined;
    operator.operationRef = "00000000-0000-4000-8000-000000000002";
    operator.plan = {
      ...operator.plan,
      retention: { ...operator.plan.retention, expiresAt: "2027-01-02T00:00:00Z" },
    };
    operator.planDigest = operatorPlanDigest(operator.plan);
    operator.receipts = operator.receipts.filter((receipt) =>
      operator.plan.effects.some(
        (effect) =>
          effect.id === receipt.effectId && ["resources", "install"].includes(effect.kind),
      ),
    );
    const before = structuredClone(f.row);
    f.readResourceBindings.mockImplementation(async (binding) => {
      const selected = selectAuthPlanningResourceBindingRow(f.row, binding.plan);
      const authorized = requireFinalResourceBindingPhase(selected, binding);
      expect(authorized.record.operator?.approvalId).toBe(retained.approvalId);
      expect(authorized.record.approvedByCallId).toBe(retained.approvedByCallId);
      return {
        authDatabase: { migrationUrl: f.migrationUrl, runtimeUrl: "private-runtime" },
        appDatabase: { migrationUrl: "private-app", runtimeUrl: "private-app-runtime" },
      };
    });
    const next = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(f.original.operator?.authPreparation).toBeDefined();
    expect(f.original.operator?.approvalId).toBeUndefined();
    expect(f.original.operator?.planDigest).not.toBe(retained.planDigest);
    expect(f.readResourceBindings.mock.calls.length).toBeGreaterThan(0);
    expect(
      f.readResourceBindings.mock.calls.every(([binding]) => binding.plan === retained.plan),
    ).toBe(true);
    expect(next.authSchema?.artifactRef).toBe("new-observed-artifact");
    expect(f.propose.mock.calls[0]?.[0].directMigrationUrl).toBe(f.migrationUrl);
    expect(f.row).toEqual(before);
  });
  it.each([
    {
      configuredDeploymentId: "configured-gateway",
      recordedState: "READY",
      expectedDeploymentId: "configured-gateway",
      expectedOrigin: "https://gateway.example",
    },
    {
      configuredDeploymentId: undefined,
      recordedState: "READY",
      expectedDeploymentId: undefined,
      expectedOrigin: "https://gateway.example",
    },
    {
      configuredDeploymentId: undefined,
      recordedState: "BUILDING",
      expectedDeploymentId: undefined,
      expectedOrigin: "https://gateway.example",
    },
  ] as const)(
    "plans against stable configured Gateway origins without overriding them from history: $configuredDeploymentId / $recordedState",
    async ({ configuredDeploymentId, recordedState, expectedDeploymentId, expectedOrigin }) => {
      const f = setup("current");
      f.configuration.gateway.deploymentId = configuredDeploymentId;
      const operator = f.original.operator!;
      operator.deliveredGatewayDeploymentId = "retained-gateway";
      operator.gatewayDeliveryCandidates = [
        {
          branch: f.configuration.gateway.branch,
          deploymentId: "retained-gateway",
          operationRef: operator.operationRef,
          origin: "https://retained-gateway.example",
          projectId: f.configuration.gateway.projectId,
          readyState: recordedState,
          repoId: f.configuration.gateway.repoId,
        },
      ];
      const { approvalId, planDigest } = operator;
      await f.dependencies.plan({ ...context, action: "prepare" });
      const observedTargets = vi
        .mocked(providerInventory.readHostedOperatorProviderInventory)
        .mock.calls.map(([{ configuration }]) => ({
          deploymentId: configuration.gateway.deploymentId,
          gatewayOrigin: configuration.verification.gatewayOrigin,
          publicOrigin: configuration.verification.publicOrigin,
        }));
      expect(observedTargets).toContainEqual({
        deploymentId: expectedDeploymentId,
        gatewayOrigin: expectedOrigin,
        publicOrigin: f.configuration.gateway.publicOrigin,
      });
      expect(operator.deliveredGatewayDeploymentId).toBe("retained-gateway");
      expect(operator.gatewayDeliveryCandidates[0]?.origin).toBe(
        "https://retained-gateway.example",
      );
      expect(operator.approvalId).toBe(approvalId);
      expect(operator.planDigest).toBe(planDigest);
    },
  );
  it("preserves the approved source artifact and read-only adoption authority", async () => {
    const f = setup("adopted");
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(f.controlPlane.readSharedAuthAdoption).toHaveBeenCalledWith({
      context: { ...context, action: "prepare" },
      source: { ownerContext: f.sourceContext.ownerContext, target: f.sourceContext.target },
    });
    expect(f.readResourceBindings).not.toHaveBeenCalled();
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.controlPlane.publishAuthPlan).toHaveBeenCalledWith(expect.anything(), {
      content: Buffer.from("original-source-artifact"),
      planDigest: f.sourceRow.record.operator!.plan.authSchema!.planDigest,
      targetDigest: f.sourceRow.record.operator!.plan.authSchema!.targetDigest,
    });
    expect(plan.authSchema!.targetDigest).toBe(
      f.sourceRow.record.operator!.plan.authSchema!.targetDigest,
    );
    expect(plan.authAdoption).toBeDefined();
  });
  it("opts only a new plan into configured operator origin resolution and freezes the observed ID", async () => {
    const f = setup("empty");
    f.configuration.operator.deploymentId = "deleted-config-deployment";
    const plan = await f.dependencies.plan({ ...context, action: "prepare" });
    expect(
      vi
        .mocked(providerInventory.readHostedOperatorProviderInventory)
        .mock.calls.some(
          ([inventoryRead]) =>
            inventoryRead.phase === "bootstrap-planning" &&
            inventoryRead.resolveOperatorByConfiguredOrigin === true &&
            inventoryRead.configuration.operator.origin === f.configuration.operator.origin,
        ),
    ).toBe(true);
    expect(plan.deploymentBoundary?.operator.deploymentId).toBe("operator-deployment");
  });

  it("keeps initial empty-target planning credential free", async () => {
    const f = setup("empty");
    await f.dependencies.plan({ ...context, action: "prepare" });
    expect(f.readResourceBindings).not.toHaveBeenCalled();
    expect(f.propose.mock.calls[0]?.[0]).not.toHaveProperty("directMigrationUrl");
  });
  it.each(["consumed", "pending", "narrowed-consumed"] as const)(
    "preserves frozen identity authority when the owner nonce is %s",
    async (nonceState) => {
      const f = setup("current");
      const operator = f.original.operator!;
      operator.plan = {
        ...operator.plan,
        publicGateway: {
          branch: "gateway-actual",
          origin: "https://apps.example",
          projectId: "gateway",
        },
        effects: [
          ...operator.plan.effects,
          { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
        ],
        deploymentBoundary: {
          app: {
            branch: context.target.branch,
            deploymentId: "app-deployment",
            environment: "preview",
            projectId: context.target.projectId,
          },
          gateway: {
            branch: "gateway-actual",
            deploymentId: "gateway-deployment",
            environment: "preview",
            projectId: "gateway",
          },
          operator: {
            deploymentId: "operator-deployment",
            environment: "preview",
            projectId: "operator",
          },
          authority: context.authority,
          teamId: "team",
          verification: {
            gatewayOrigin: "https://gateway.example",
            publicOrigin: "https://apps.example",
            jwksUrl: "https://gateway.example/_platform/jwks.json",
          },
        },
        gatewayBindings: {
          authBrowserOrigin: "https://auth.example",
          builderCallbackOrigin: "https://builder.example",
          catalogAppIds: ["actual"],
          operatorOrigin: "https://operator.example",
          sourceWorkload: {
            audience: "https://vercel.com/team",
            environment: "preview",
            issuer: "https://oidc.vercel.com/team",
            ownerId: "team",
            projectId: "gateway",
            subject: "gateway-workload",
          },
        },
      };
      operator.planDigest = operatorPlanDigest(operator.plan);
      operator.receipts.push({
        effectId: "gateway-bindings",
        observedAt: "2026-10-15T12:00:00Z",
        resourceVersion: "owned-observation",
      });
      operator.gatewayDeliveryCandidates = [
        {
          branch: "gateway-actual",
          deploymentId: "gateway-deployment",
          operationRef: operator.operationRef,
          origin: "https://gateway.example",
          projectId: "gateway",
          readyState: "READY",
          repoId: "gateway-repository",
        },
      ];
      operator.deliveredGatewayDeploymentId = "gateway-deployment";
      operator.identityLink = {
        audience: "https://operator.example",
        authResourceId: operator.plan.authDatabase.resourceId,
        bootstrapPlanDigest: operator.planDigest,
        browserOrigin: "https://auth.example",
        endpointOrigin: "https://gateway.example",
        issuer: "https://apps.example",
        ownerSessionId: context.target.sessionId,
        organizationId: null,
        nonceSha256: "a".repeat(64),
        expiresAt: "2026-10-01T00:00:00Z",
        consumedAt: "2026-09-30T23:59:00Z",
        proofRef: "captured-owner-proof",
        proofSha256: "b".repeat(64),
      };
      if (nonceState === "narrowed-consumed") {
        operator.plan.gatewayBindings!.trustedSources = {
          builderProduction: { projectId: "builder", from: "production", to: "preview" },
          operatorPreview: { projectId: "operator", from: "preview", to: "preview" },
        };
        operator.plan.gatewayDelivery = {
          branch: "gateway-actual",
          gitSha: "c".repeat(40),
          projectId: "gateway",
          repoId: "gateway-repository",
        };
        operator.plan.effects.push({
          description: "Gateway delivery",
          id: "gateway-delivery",
          kind: "gateway-delivery",
        });
        operator.receipts.push({
          effectId: "gateway-delivery",
          observedAt: "2026-10-15T12:00:00Z",
          resourceVersion: "owned-observation",
        });
        operator.planDigest = operatorPlanDigest(operator.plan);
        operator.identityLink.bootstrapPlanDigest = operator.planDigest;
        const originalOperator = structuredClone(operator);
        operator.retainedGatewayDeliveries = [
          { approvedByCallId: f.original.approvedByCallId, operator: originalOperator },
        ];
        const gatewayBindings = { ...operator.plan.gatewayBindings! };
        delete gatewayBindings.trustedSources;
        operator.plan = { ...operator.plan, gatewayBindings };
        operator.planDigest = operatorPlanDigest(operator.plan);
        operator.approvalId = "narrowed-approval";
      }
      const prepareRealmIdentityLink = vi.fn(() => {
        throw new Error("fixture invitation boundary");
      });
      Object.assign(f.controlPlane, { prepareRealmIdentityLink });
      if (nonceState === "pending") {
        operator.identityLink.consumedAt = undefined;
      }
      const before = structuredClone(operator.identityLink);
      const invitation = f.dependencies.authIdentityInput!({
        ...context,
        operationRef: operator.operationRef,
        plan: operator.plan,
      });
      if (nonceState === "pending") {
        await expect(invitation).rejects.toThrow("fixture invitation boundary");
        const [observed] = vi.mocked(providerInventory.readHostedOperatorProviderInventory).mock
          .calls;
        expect(observed?.[0].phase).toBe("bootstrap-planning");
        expect(observed?.[0].resolveGatewayByPublicOrigin).toBeUndefined();
        expect(observed?.[0].resolveOperatorByConfiguredOrigin).toBeUndefined();
        expect(observed?.[0].configuration.operator.deploymentId).toBe(
          operator.plan.deploymentBoundary?.operator.deploymentId,
        );
        expect(observed?.[0].configuration.gateway.deploymentId).toBe("gateway-deployment");
        expect(observed?.[0].configuration.verification.gatewayOrigin).toBe(
          "https://gateway.example",
        );
      } else {
        await expect(invitation).rejects.toMatchObject({ code: "operation_in_progress" });
        expect(prepareRealmIdentityLink).not.toHaveBeenCalled();
        expect(providerInventory.readHostedOperatorProviderInventory).not.toHaveBeenCalled();
      }
      expect(operator.identityLink).toEqual(before);
    },
  );
  it("continues participant capture through its existing next-actor path", async () => {
    const f = setup("current");
    const participant = participantResolutionFixture();
    const normalActorAuthIdentityInput = vi.fn(async () => ({
      browserUrl: "https://auth.example/next-actor",
      expiresAt: "2027-01-01T00:00:00Z",
      operationRef: f.original.operator!.operationRef,
      sessionId: context.target.sessionId,
    }));
    Object.assign(f.controlPlane, { normalActorAuthIdentityInput });
    const invocation = {
      ...context,
      operationRef: f.original.operator!.operationRef,
      plan: participant.accountPlan,
    };
    expect(await f.dependencies.authIdentityInput!(invocation)).toMatchObject({
      browserUrl: "https://auth.example/next-actor",
    });
    expect(normalActorAuthIdentityInput).toHaveBeenCalledWith(invocation);
  });
  it("does not turn a denied original binding into an empty proposal", async () => {
    const f = setup("current");
    f.readResourceBindings.mockRejectedValueOnce(new Error("original approval unavailable"));
    await expect(f.dependencies.plan({ ...context, action: "prepare" })).rejects.toThrow(
      "original approval unavailable",
    );
    expect(f.propose).not.toHaveBeenCalled();
    expect(f.controlPlane.publishAuthPlan).not.toHaveBeenCalled();
  });
});

describe("retained approved Auth binding selection", () => {
  const pendingDelivery = async () => {
    const originalPlan = bootstrapWithGatewayOrigin("https://gateway.example");
    const record = existingAuthRecord(originalPlan);
    record.retainedAuth = retainedOperatorAuthFromJournal(record);
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const appPlan = await resolveFullPlan(originalPlan, context, f.configuration, f.controlPlane);
    record.operator = {
      ...record.operator!,
      approvalId: "app-approval",
      operationRef: "00000000-0000-4000-8000-000000000002",
      plan: appPlan,
      planDigest: operatorPlanDigest(appPlan),
      pendingEffectId: appPlan.effects.find((effect) => effect.kind === "delivery")!.id,
      pendingEffectAttempt: { id: "00000000-0000-4000-8000-000000000003" },
    };
    return { row: { record, revision: 5 }, originalPlan };
  };

  it("reads exact completed retained Auth while an unrelated app delivery awaits reconciliation", async () => {
    const { row, originalPlan } = await pendingDelivery();
    const before = structuredClone(row);
    const selected = selectAuthPlanningResourceBindingRow(row, originalPlan);
    const authorized = requireFinalResourceBindingPhase(selected, {
      plan: originalPlan,
      privateState: row.record.privateState,
    });
    expect(authorized.record.approvedByCallId).toBe(row.record.retainedAuth!.approvedByCallId);
    expect(authorized.record.operator?.approvalId).toBe(row.record.retainedAuth!.approvalId);
    expect(authorized.record.operator?.fenceGeneration).toBe(
      row.record.retainedAuth!.fenceGeneration,
    );
    expect(authorized.record.operator?.plan).toEqual(originalPlan);
    expect(authorized.record.operator?.receipts).toEqual(row.record.retainedAuth!.receipts);
    expect(authorized.record.privateState).toEqual(row.record.privateState);
    expect(authorized.revision).toBe(row.revision);
    expect(row).toEqual(before);
    expect(() =>
      requireFinalResourceBindingPhase(selected, {
        plan: originalPlan,
        privateState: undefined,
      }),
    ).toThrow();
    row.record.leaseId = "active-delivery-lease";
    expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
    delete row.record.leaseId;
    row.record.leaseExpiresAt = "2027-01-01T00:00:00Z";
    expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
  });

  it.each(["auth-resources", "auth-schema", "unknown-effect"])(
    "continues blocking a pending %s effect from retained credential projection",
    async (effectId) => {
      const { row, originalPlan } = await pendingDelivery();
      row.record.operator!.pendingEffectId = effectId;
      expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
    },
  );

  it("continues blocking cleanup and orphan pending attempts", async () => {
    const { row, originalPlan } = await pendingDelivery();
    row.record.operator!.plan = { ...row.record.operator!.plan, action: "cleanup" };
    expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
    row.record.operator!.plan = { ...row.record.operator!.plan, action: "prepare" };
    delete row.record.operator!.pendingEffectId;
    expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
  });

  it("selects only the completed original prepare evidence without replacing the journal", () => {
    const record = existingAuthRecord();
    const originalPlan = record.operator!.plan;
    record.retainedAuth = retainedOperatorAuthFromJournal(record);
    record.operator = {
      ...record.operator!,
      authPreparation: undefined,
      approvalId: undefined,
      plan: { ...originalPlan, contextId: "replacement" },
    };
    record.operator.planDigest = operatorPlanDigest(record.operator.plan);
    const row = { record, revision: 4 };
    const selected = selectAuthPlanningResourceBindingRow(row, originalPlan)!;
    const accepted = requireFinalResourceBindingPhase(selected, {
      plan: originalPlan,
      privateState: record.privateState,
    });
    expect(accepted.record.operator!.approvalId).toBe("original-approval");
    expect(accepted.record.approvedByCallId).toBe("original-approval-call");
    expect(accepted.record.operator!.planDigest).toBe(operatorPlanDigest(originalPlan));
    expect(row.record.operator!.plan.contextId).toBe("replacement");
    expect(() =>
      requireFinalResourceBindingPhase(selected, { plan: originalPlan, privateState: undefined }),
    ).toThrow();
    expect(() =>
      requireFinalResourceBindingPhase(
        selectAuthPlanningResourceBindingRow(row, { ...originalPlan, contextId: "foreign" }),
        { plan: originalPlan, privateState: record.privateState },
      ),
    ).toThrow();
    const incomplete = structuredClone(row);
    incomplete.record.retainedAuth!.receipts = [];
    expect(() =>
      requireFinalResourceBindingPhase(
        selectAuthPlanningResourceBindingRow(incomplete, originalPlan),
        { plan: originalPlan, privateState: record.privateState },
      ),
    ).toThrow();
    const unapproved = structuredClone(selected);
    unapproved.record.operator!.approvalId = undefined;
    expect(() =>
      requireFinalResourceBindingPhase(unapproved, {
        plan: originalPlan,
        privateState: record.privateState,
      }),
    ).toThrow();
    record.leaseId = "active-lease";
    expect(() => selectAuthPlanningResourceBindingRow(row, originalPlan)).toThrow();
  });
});

it.each(["reconcile", "execute"] as const)(
  "preserves app candidates through Gateway %s and adapter candidate clones",
  async (mode) => {
    const f = publicationFixture();
    const appCandidate = {
      branch: context.target.branch,
      deploymentId: "app-ready",
      operationRef: "00000000-0000-4000-8000-000000000001",
      origin: "https://app-ready.example.test",
      projectId: context.target.projectId,
      projectName: "app-project",
      readyState: "READY",
      repoId: "app-repository",
      scopeSlug: "fixture-team",
    };
    const gatewayCandidate = {
      ...appCandidate,
      deploymentId: "gateway-ready",
      origin: "https://gateway-ready.example.test",
      projectId: "gateway",
      projectName: "gateway-project",
      repoId: "gateway-repository",
    };
    const appCandidates = [appCandidate];
    const gatewayCandidates = [gatewayCandidate];
    const checkpointApp = vi.fn(async () => {});
    const checkpointGateway = vi.fn(async () => {});
    const verifyForDelivery = vi.fn(
      async (
        input: Parameters<
          ReturnType<
            typeof gatewayBindingAdapter.createHostedOperatorGatewayBindings
          >["verifyForDelivery"]
        >[0],
      ) => {
        expect(input.deliveryCandidates).toBe(appCandidates);
        expect(input.effect.kind).toBe("gateway-delivery");
        return { rows: [] };
      },
    );
    const createBindings = gatewayBindingAdapter.createHostedOperatorGatewayBindings;
    vi.spyOn(gatewayBindingAdapter, "createHostedOperatorGatewayBindings").mockImplementation(
      (ports) => ({
        ...createBindings(ports),
        verifyForDelivery,
      }),
    );
    const createDelivery = deploymentDelivery.createHostedOperatorDeploymentDelivery;
    const runGateway = vi.fn(async (input: HostedOperatorDeploymentContext) => {
      expect(input.deliveryCandidates).toBe(gatewayCandidates);
      expect(input.appDeliveryCandidates).toBe(appCandidates);
      expect(input.checkpointDelivery).toBe(checkpointGateway);
      expect(input.leaseId).toBe("actual-lease");
      return {
        candidates: gatewayCandidates,
        selected: gatewayCandidate,
        status: "applied" as const,
      };
    });
    vi.spyOn(deploymentDelivery, "createHostedOperatorDeploymentDelivery").mockImplementation(
      (ports) => {
        const adapter = createDelivery(ports);
        if (ports.target !== "gateway") {
          return adapter;
        }
        const observe = async (input: HostedOperatorDeploymentContext) => {
          const result = await runGateway(input);
          await ports.assertEnvironment({
            ...input,
            deliveryCandidates: [{ ...gatewayCandidate }],
          });
          return result;
        };
        return { ...adapter, reconcile: observe, deliver: observe };
      },
    );
    const dependencies = composeHostedOperatorDependencies(f.configuration, {
      ...f.controlPlane,
      assertAuthorized: vi.fn(async () => {}),
    } as unknown as Parameters<typeof composeHostedOperatorDependencies>[1]);
    const plan = bootstrapWithGatewayOrigin("https://gateway.example");
    plan.stage = "app";
    plan.gatewayBindings = {
      authBrowserOrigin: "https://auth.example",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [context.target.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: { ...f.configuration.gateway.workload, environment: "preview" },
    };
    const input: HostedOperatorWorkerEffectContext = {
      ...context,
      assertCurrent: vi.fn(async () => {}),
      bindWorkerContext: vi.fn(),
      checkpoint: vi.fn(async () => {}),
      checkpointDelivery: checkpointApp,
      checkpointGatewayDelivery: checkpointGateway,
      checkpointGatewayEnvironment: vi.fn(async () => {}),
      deliveryCandidates: appCandidates,
      effect: { id: "gateway-delivery", kind: "gateway-delivery", description: "Deliver Gateway" },
      fenceGeneration: 3,
      gatewayDeliveryCandidates: gatewayCandidates,
      leaseId: "actual-lease",
      operationRef: appCandidate.operationRef,
      plan,
      workerAttemptId: "actual-attempt",
      workerCheckpoints: [],
    };
    if (mode === "reconcile") {
      expect(await dependencies.reconcile(input)).toMatchObject({ status: "applied" });
    } else {
      expect(await dependencies.executeEffect(input)).toMatchObject({
        effectId: "gateway-delivery",
      });
    }
    expect(runGateway).toHaveBeenCalledOnce();
    expect(verifyForDelivery).toHaveBeenCalledOnce();
    expect(checkpointApp).not.toHaveBeenCalled();
    expect(input.deliveryCandidates).toBe(appCandidates);
    expect(input.gatewayDeliveryCandidates).toBe(gatewayCandidates);
  },
);

describe("approved historical organization inspection", () => {
  const setup = (historical: boolean, status: "applied" | "absent") => {
    const f = publicationFixture();
    f.configuration.sandbox.membershipWorker = {
      executablePath: "/membership-worker",
      id: "auth-owned-organization-v1",
      operationScope: "auth-protected-membership-v1",
      sha256: "a".repeat(64),
      subcommand: "auth-protected-membership",
    };
    const prior = hostedOperatorPlanSchema.parse({
      ...bootstrapWithGatewayOrigin("https://gateway.example"),
      stage: "app",
      retention: { expiresAt: "2026-10-01T00:00:00Z", policy: "Original approved retention" },
      effects: [
        ...bootstrapPlan().effects,
        { id: "app-install", kind: "install", description: "Install app" },
        {
          id: "auth-membership",
          kind: "auth-membership",
          description: "Create owned organization",
        },
        { id: "access", kind: "access", description: "Grant approved access" },
        { id: "bindings", kind: "bindings", description: "Bind app" },
        { id: "gateway-bindings", kind: "gateway-bindings", description: "Bind Gateway" },
        { id: "gateway-delivery", kind: "gateway-delivery", description: "Deliver Gateway" },
      ],
      authMembership: {
        kind: "create-owned-organization",
        actorId: "fixture-owner",
        organizationId: "fixture-organization",
        name: "Fixture organization",
        slug: "fixture-organization",
        bootstrapPlanDigest: "a".repeat(64),
        identityNonceSha256: "b".repeat(64),
        identityProof: { reference: "frozen-proof", sha256: "c".repeat(64) },
        identityCapture: { capturedAt: "2026-10-15T12:00:00Z", realmSessionId: "frozen-session" },
        identityVerification: {
          audience: "https://operator.example",
          issuer: "https://apps.example",
          jwksUrl: "https://gateway.example/_platform/jwks.json",
          transportSource: {
            audience: "https://vercel.com/team",
            issuer: "https://oidc.vercel.com/team",
            ownerId: "team",
            projectId: "operator",
            environment: "preview",
          },
        },
      },
    });
    const plan = hostedOperatorPlanSchema.parse({
      ...prior,
      release: { ...prior.release, id: "current-release" },
      retention: { expiresAt: "2030-01-01T00:00:00Z", policy: "Current approved retention" },
    });
    const effect = plan.effects.find((entry) => entry.kind === "auth-membership");
    if (effect === undefined) {
      throw new Error("Fixture membership effect missing");
    }
    const input: HostedOperatorEffectContext = {
      ...context,
      plan,
      effect,
      operationRef: "11111111-1111-4111-8111-111111111111",
      fenceGeneration: 9,
      leaseId: "current-lease",
      workerCheckpoints: [],
      assertCurrentObservation: vi.fn(async () => {}),
      assertCurrent: vi.fn(async () => {}),
      checkpoint: vi.fn(async () => {}),
    };
    const inspect = vi.fn<
      ReturnType<typeof membershipLauncher.createHostedOperatorSandboxLauncher>["inspect"]
    >(async (observed) => {
      await (observed.assertCurrentObservation ?? observed.assertCurrent)();
      return {
        version: 1,
        operation_id: input.operationRef,
        context_digest: "d".repeat(64),
        fence_generation: input.fenceGeneration,
        status,
        readback_sha256: "e".repeat(64),
      };
    });
    const execute = vi.fn(async () => {});
    vi.spyOn(membershipLauncher, "createHostedOperatorSandboxLauncher").mockReturnValue({
      inspect,
      execute,
    });
    vi.stubEnv(
      "VERCEL_OIDC_TOKEN",
      `fixture.${Buffer.from(JSON.stringify({ exp: 2_000_000_000 })).toString("base64url")}.fixture`,
    );
    const readResourceBindings = vi.fn(async () => ({
      authDatabase: { migrationUrl: "private-current-auth", runtimeUrl: "private-current-runtime" },
      appDatabase: {
        migrationUrl: "private-current-app",
        runtimeUrl: "private-current-app-runtime",
      },
    }));
    const readMembershipInspectionPlan = vi.fn(async () =>
      historical ? { plan: prior, effect } : undefined,
    );
    const assertMembershipCapture = vi.fn(async (current: HostedOperatorEffectContext) => {
      await current.assertCurrent();
    });
    f.readCapturedRealmIdentityProof.mockResolvedValue({
      link: { proofSha256: "c".repeat(64) },
      proof: "fixture-private-proof",
    });
    const controlPlane = {
      ...f.controlPlane,
      readResourceBindings,
      readMembershipInspectionPlan,
      assertMembershipCapture,
      assertAuthorized: vi.fn(async () => {}),
    };
    const dependencies = composeHostedOperatorDependencies(
      f.configuration,
      controlPlane as unknown as Parameters<typeof composeHostedOperatorDependencies>[1],
    );
    return {
      f,
      input,
      prior,
      inspect,
      execute,
      readResourceBindings,
      readMembershipInspectionPlan,
      assertMembershipCapture,
      dependencies,
    };
  };

  it("reads current credentials and capture but inspects the original approved full plan with today's fence", async () => {
    const f = setup(true, "applied");
    await expect(f.dependencies.reconcile(f.input)).resolves.toMatchObject({
      status: "applied",
      receipt: { effectId: f.input.effect.id, resourceVersion: "e".repeat(64) },
    });
    expect(f.readResourceBindings).toHaveBeenCalledWith(f.input);
    expect(f.f.readCapturedRealmIdentityProof).toHaveBeenCalledWith(f.input);
    expect(f.readMembershipInspectionPlan).toHaveBeenCalledWith(f.input);
    expect(f.assertMembershipCapture).toHaveBeenCalledWith(f.input);
    expect(f.inspect).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: f.prior,
        operationRef: f.input.operationRef,
        fenceGeneration: 9,
        leaseId: "current-lease",
        readbackOnly: true,
        directDatabaseUrl: "private-current-auth",
      }),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("keeps missing historical ownership unknown without authorizing recreation", async () => {
    const f = setup(true, "absent");
    await expect(f.dependencies.reconcile(f.input)).resolves.toEqual({ status: "unknown" });
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("preserves ordinary current-plan absence for a first organization creation", async () => {
    const f = setup(false, "absent");
    await expect(f.dependencies.reconcile(f.input)).resolves.toEqual({ status: "absent" });
    expect(f.inspect).toHaveBeenCalledWith(
      expect.objectContaining({ plan: f.input.plan, readbackOnly: true }),
    );
    expect(f.execute).not.toHaveBeenCalled();
  });

  it("rejects a lost current capture before historical observation can succeed", async () => {
    const f = setup(true, "applied");
    f.assertMembershipCapture.mockRejectedValue(new Error("current capture revoked"));
    await expect(f.dependencies.reconcile(f.input)).rejects.toThrow("current capture revoked");
    expect(f.execute).not.toHaveBeenCalled();
  });
});

describe("retained active schema installation scope", () => {
  const fixture = () => {
    const desired = hostedOperatorPlanSchema.parse({
      ...bootstrapPlan(),
      stage: undefined,
      effects: [
        ...bootstrapPlan().effects,
        { id: "app-access", kind: "access", description: "Approved grants" },
        { id: "app-bindings", kind: "bindings", description: "Approved bindings" },
      ],
      access: [{ actorId: "qa-actor", organizationId: "qa-org", roles: ["member"] }],
    });
    const prior = hostedOperatorPlanSchema.parse({
      ...desired,
      release: { ...desired.release, id: "previous-release", sha256: "1".repeat(64) },
      access: [{ actorId: "original-owner", organizationId: "original-org", roles: ["member"] }],
    });
    const receipt = (sequence: number): PrivateHostedApprovalReceipt =>
      privateHostedApprovalReceiptSchema.parse({
        callId: `approved-call-${sequence}`,
        requestId: `approved-request-${sequence}`,
        format: "autograph-hosted-approval-v1",
        outcome: "approved",
        responderPrincipalId: authority.ownerUserId,
        sequence,
        turnId: "",
        toolName: "prepare-app-hosted-runtime",
        toolInput: {
          appId: prior.selection.appId,
          branch: prior.selection.branch,
          environment: "preview",
          projectId: prior.selection.projectId,
          operationRef: `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
          plan: prior,
          planDigest: operatorPlanDigest(prior),
        },
      });
    const owner = operatorOwnerContextSchema.parse(context.ownerContext);
    const session = durableHostedSessionRecordSchema.parse({
      version: 2,
      sessionId: context.target.sessionId,
      appId: context.target.appId,
      principal: owner.principal,
      adapterGeneration: 1,
      adapterSessionId: "adapter",
      originAdapterSessionId: "adapter",
      createdAtEpochMs: 100,
      updatedAtEpochMs: 100,
      lastProgressAtEpochMs: 100,
      resumability: "live",
      stage: "ready",
      status: "waiting",
      title: "Controlled retained owner",
      privateApprovalReceipts: [receipt(1)],
    });
    const getSession = vi.fn(async () => await Promise.resolve(session));
    const readOwner = vi.fn(async () => await Promise.resolve({ session }));
    const readApproval = vi.fn(
      async (_context: HostedOperatorContext, selected: PrivateHostedApprovalReceipt) =>
        await readPrivateHostedApproval({
          store: { getSession },
          principal: owner.principal,
          sessionId: context.target.sessionId,
          callId: selected.callId,
          action: "prepare",
          planDigest: selected.toolInput.planDigest,
          selection: selected.toolInput.plan.selection,
          requestId: selected.requestId,
        }),
    );
    const readActiveCustomers = vi.fn(async () => await Promise.resolve(["original-org"]));
    const read = createRetainedAppInstallationCustomerReader({
      readOwner,
      readApproval,
      readActiveCustomers,
    });
    return { desired, prior, receipt, session, readOwner, readApproval, readActiveCustomers, read };
  };

  const deploymentFixture = async (encrypted = false) => {
    const f = fixture();
    const row = {
      revision: 1,
      record: hostedRuntimeJournalRecordSchema.parse({
        version: 1,
        kind: "app-runtime",
        approvedByCallId: "approved-call-1",
        request: context.target,
        status: "prepared",
        step: "bound",
        privateState: {
          encryptedToken: "protected-resource-ciphertext",
          keyVersion: "fixture-key",
          tokenIv: "fixture-iv",
          tokenTag: "fixture-tag",
        },
        operator: {
          mode: "protected-operator-v1",
          approvalId: f.receipt(1).requestId,
          operationRef: f.receipt(1).toolInput.operationRef,
          plan: f.prior,
          planDigest: operatorPlanDigest(f.prior),
          fenceGeneration: 1,
          receipts: f.prior.effects.map((effect) => ({
            effectId: effect.id,
            observedAt: "2026-10-20T12:00:00Z",
            resourceVersion: "observed-resource",
            ...(effect.kind === "access" ? { fenceGeneration: 1 } : {}),
          })),
        },
      }),
    };
    const journal = await import("./postgres-hosted-runtime-journal");
    const eve = await import("../eve/postgres-hosted-store");
    const owners = await import("./hosted-operator-owner");
    const credentials = await import("./hosted-operator-resource-credentials");
    const appReadiness = await import("./hosted-operator-app-readiness");
    if (encrypted) {
      const prepared = credentials.prepareHostedOperatorResourceCredentials({
        ...context,
        plan: f.prior,
        record: { ...row.record, privateState: undefined },
        database: "appDatabase",
        config: { tokenKey: Buffer.alloc(32, 1), tokenKeyVersion: "fixture-key" },
      });
      row.record.privateState = prepared.privateState;
    }
    const readJournal = vi.fn(async () => await Promise.resolve(structuredClone(row)));
    const createJournal = journal.createPostgresHostedRuntimeJournalStore;
    vi.spyOn(journal, "createPostgresHostedRuntimeJournalStore").mockImplementation((database) => ({
      ...createJournal(database),
      read: readJournal,
    }));
    const createEve = eve.createPostgresHostedEveStore;
    vi.spyOn(eve, "createPostgresHostedEveStore").mockImplementation((database) => ({
      ...createEve(database),
      getSession: async () => await Promise.resolve(f.session),
    }));
    const assertPlanningAuthorized = vi.fn(async () => {
      await Promise.resolve();
    });
    const createOwner = owners.createHostedOperatorOwnerAuthority;
    const assertAuthorized = vi.fn<ReturnType<typeof createOwner>["assertAuthorized"]>(
      async (input) => {
        expect(input.purpose).toBe("planning");
        await assertPlanningAuthorized();
      },
    );
    vi.spyOn(owners, "createHostedOperatorOwnerAuthority").mockImplementation((dependencies) => ({
      ...createOwner(dependencies),
      readCurrentPlanningOwner: async () =>
        await Promise.resolve({ session: f.session, target: context.target }),
      assertPlanningAuthorized,
      assertAuthorized,
    }));
    const bindings = {
      appDatabase: { migrationUrl: "fixture-app-migrator", runtimeUrl: "fixture-app-runtime" },
      authDatabase: { migrationUrl: "fixture-auth-migrator", runtimeUrl: "fixture-auth-runtime" },
    };
    const readBindings = vi.spyOn(credentials, "readHostedOperatorResourceBindings");
    if (!encrypted) {
      readBindings.mockReturnValue(bindings);
    }
    const metadataRead = vi.fn(async () => await Promise.resolve(["original-org"]));
    const readMetadata = vi
      .spyOn(appReadiness, "readActiveAppInstallationCustomerIds")
      .mockImplementation(async (input) => {
        await input.assertCurrent();
        return await metadataRead();
      });
    const { configuration } = publicationFixture();
    const controlPlane = await createHostedOperatorControlPlane({
      environment: {
        DATABASE_URL: "postgresql://fixture@db.example/control_plane",
        BETTER_AUTH_URL: authority.issuer,
        MCP_RESOURCE_URL: authority.audience,
        VERCEL_INTEGRATION_TOKEN_KEY: Buffer.alloc(32, 1).toString("base64"),
        VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "fixture-key",
      },
      sourceConfiguration: configuration,
      workloadPolicy: configuration.workloadPolicy,
    });
    const read = controlPlane.readAppInstallationCustomerIds;
    if (read === undefined) {
      throw new Error("Factory installation planning reader is missing");
    }
    return {
      ...f,
      row,
      read,
      readBindings,
      readJournal,
      readMetadata,
      metadataRead,
      assertPlanningAuthorized,
      assertAuthorized,
      bindings,
      readResourceBindings: controlPlane.readResourceBindings,
    };
  };

  const pausedEncryptedRead = async () => {
    const f = await deploymentFixture(true);
    f.row.record.status = "pending";
    f.row.record.step = "reserved";
    f.row.record.leaseId = "00000000-0000-4000-8000-000000000031";
    f.row.record.leaseExpiresAt = new Date(Date.now() + 60_000).toISOString();
    const before = structuredClone(f.row);
    const entered = Promise.withResolvers<undefined>();
    const resume = Promise.withResolvers<undefined>();
    let checks = 0;
    f.assertAuthorized.mockImplementation(async () => {
      checks += 1;
      if (checks === 2) {
        entered.resolve(undefined);
        await resume.promise;
      }
    });
    const reading = f.readResourceBindings({
      ...context,
      plan: f.prior,
      privateState: before.record.privateState,
    });
    // Attach the rejection handler before resuming the deliberately paused read.
    const result = (async () => {
      try {
        return { bindings: await reading };
      } catch (error) {
        return { error };
      }
    })();
    await entered.promise;
    expect(f.readBindings).toHaveBeenCalledOnce();
    f.row.revision += 1;
    f.row.record.leaseExpiresAt = new Date(Date.now() + 90_000).toISOString();
    return { ...f, before, result, resume };
  };

  it("reads real encrypted credentials across renewal of the same active lease", async () => {
    const f = await pausedEncryptedRead();
    expect(f.row.record.operator).toEqual(f.before.record.operator);
    expect(f.row.record.privateState).toEqual(f.before.record.privateState);
    expect(f.row.record.leaseId).toBe(f.before.record.leaseId);
    f.resume.resolve(undefined);
    const result = await f.result;
    expect(result).not.toHaveProperty("error");
    if (!("bindings" in result)) {
      throw new Error("expected decrypted bindings");
    }
    expect(new URL(result.bindings.appDatabase.runtimeUrl).username).toBe(
      f.prior.appDatabase.runtimeRole,
    );
    expect(new URL(result.bindings.authDatabase.runtimeUrl).username).toBe(
      f.prior.authDatabase.runtimeRole,
    );
    expect(f.row.record.status).toBe("pending");
    expect(f.assertAuthorized).toHaveBeenCalledTimes(2);
  });

  it.each([
    "lease identity",
    "lease removal",
    "expiry rollback",
    "expired lease",
    "unchanged expiry",
    "revision rollback",
    "private state",
    "approval",
    "approval call",
    "fence",
    "receipt",
    "plan",
    "checkpoint",
  ] as const)(
    "refuses real encrypted credentials after a concurrent change to %s",
    async (changed) => {
      const f = await pausedEncryptedRead();
      const operator = f.row.record.operator!;
      if (changed === "lease identity") {
        f.row.record.leaseId = "00000000-0000-4000-8000-000000000032";
      }
      if (changed === "lease removal") {
        delete f.row.record.leaseId;
        delete f.row.record.leaseExpiresAt;
        f.row.record.status = "prepared";
        f.row.record.step = "bound";
      }
      if (changed === "expiry rollback") {
        f.row.record.leaseExpiresAt = new Date(Date.now() + 30_000).toISOString();
      }
      if (changed === "expired lease") {
        f.row.record.leaseExpiresAt = new Date(Date.now() - 1000).toISOString();
      }
      if (changed === "unchanged expiry") {
        f.row.record.leaseExpiresAt = f.before.record.leaseExpiresAt;
      }
      if (changed === "revision rollback") {
        f.row.revision = f.before.revision - 1;
      }
      if (changed === "private state") {
        f.row.record.privateState!.encryptedToken = "replacement-ciphertext";
      }
      if (changed === "approval") {
        operator.approvalId = "replacement-approval";
      }
      if (changed === "approval call") {
        f.row.record.approvedByCallId = "replacement-call";
      }
      if (changed === "fence") {
        operator.fenceGeneration! += 1;
      }
      if (changed === "receipt") {
        operator.receipts = [];
      }
      if (changed === "plan") {
        operator.plan = hostedOperatorPlanSchema.parse({
          ...f.prior,
          contextId: "replacement-context",
        });
        operator.planDigest = operatorPlanDigest(operator.plan);
      }
      if (changed === "checkpoint") {
        f.row.record.environmentBound = true;
      }
      f.resume.resolve(undefined);
      const result = await f.result;
      expect(result).toHaveProperty("error");
      expect(result).not.toHaveProperty("bindings");
    },
  );

  it("refuses decrypted bindings when the second owner check is revoked", async () => {
    const f = await deploymentFixture(true);
    f.assertAuthorized
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    await expect(
      f.readResourceBindings({
        ...context,
        plan: f.prior,
        privateState: f.row.record.privateState,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.readBindings).toHaveBeenCalledOnce();
  });

  it("refuses real credentials without the canonical durable approval", async () => {
    const f = await deploymentFixture(true);
    f.assertAuthorized.mockResolvedValue(undefined);
    f.session.privateApprovalReceipts = [{ ...f.receipt(1), outcome: "cancelled" }];
    await expect(
      f.readResourceBindings({
        ...context,
        plan: f.prior,
        privateState: f.row.record.privateState,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.readBindings).not.toHaveBeenCalled();
  });

  it("uses the deployed retained-scope reader with prepared protected bindings", async () => {
    const f = await deploymentFixture();
    await expect(f.read(context, f.desired)).resolves.toEqual(["original-org"]);
    expect(f.readBindings).toHaveBeenCalledWith(
      expect.objectContaining({ record: f.row.record, plan: f.prior }),
    );
    expect(f.readMetadata).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: f.desired,
        runtimeUrl: f.bindings.appDatabase.runtimeUrl,
        scopes: [
          {
            appId: context.target.appId,
            actorId: "original-owner",
            organizationId: "original-org",
            role: "member",
          },
        ],
      }),
    );
    expect(f.metadataRead).toHaveBeenCalled();
    expect(f.assertAuthorized).toHaveBeenCalledWith(
      expect.objectContaining({ purpose: "planning", plan: f.prior }),
    );
  });

  it.each([
    ["private state", "operation_in_progress"],
    ["plan", "resource_mismatch"],
    ["phase", "operation_in_progress"],
  ] as const)(
    "rejects a changed deployed binding %s before reading retained metadata",
    async (changed, code) => {
      const f = await deploymentFixture();
      f.readBindings.mockImplementation(() => {
        if (changed === "private state" && f.row.record.privateState !== undefined) {
          f.row.record.privateState.encryptedToken = "replacement-protected-state";
        }
        if (changed === "plan" && f.row.record.operator !== undefined) {
          f.row.record.operator.plan = hostedOperatorPlanSchema.parse({
            ...f.prior,
            contextId: "replacement-approved-context",
          });
          f.row.record.operator.planDigest = operatorPlanDigest(f.row.record.operator.plan);
        }
        if (changed === "phase") {
          f.row.record.status = "pending";
          f.row.record.step = "reserved";
        }
        return f.bindings;
      });
      await expect(f.read(context, f.desired)).rejects.toMatchObject({ code });
      expect(f.metadataRead).not.toHaveBeenCalled();
    },
  );

  it("canonically checks only the latest duplicate scope and preserves the prior release tenant", async () => {
    const f = fixture();
    f.session.privateApprovalReceipts = Array.from({ length: 8 }, (_, index) =>
      f.receipt(index + 1),
    );
    await expect(f.read(context, f.desired)).resolves.toEqual(["original-org"]);
    expect(f.readApproval).toHaveBeenCalledTimes(1);
    expect(f.readApproval).toHaveBeenCalledWith(context, f.receipt(8));
    expect(f.readActiveCustomers).toHaveBeenCalledWith(context, f.desired, [
      {
        appId: context.target.appId,
        actorId: "original-owner",
        organizationId: "original-org",
        role: "member",
      },
    ]);
    expect(f.desired.access).toEqual([
      { actorId: "qa-actor", organizationId: "qa-org", roles: ["member"] },
    ]);
  });

  it("does not revive a latest canceled approval", async () => {
    const f = fixture();
    f.session.privateApprovalReceipts = [
      f.receipt(1),
      { ...f.receipt(1), sequence: 2, outcome: "cancelled" },
    ];
    await expect(f.read(context, f.desired)).resolves.toEqual([]);
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.readActiveCustomers).not.toHaveBeenCalled();
  });

  it.each(["owner", "session", "database", "app", "responder"] as const)(
    "does not acquire retained scope from a foreign %s",
    async (kind) => {
      const f = fixture();
      const original = f.receipt(1);
      if (kind === "owner") {
        f.session.principal.ownerUserId = "other-owner";
      }
      if (kind === "session") {
        f.session.sessionId = "other-session";
      }
      const plan = hostedOperatorPlanSchema.parse({
        ...f.prior,
        ...(kind === "database"
          ? { appDatabase: { ...f.prior.appDatabase, database: "other_database" } }
          : {}),
        ...(kind === "app" ? { selection: { ...f.prior.selection, appId: "other-app" } } : {}),
      });
      f.session.privateApprovalReceipts = [
        {
          ...original,
          responderPrincipalId:
            kind === "responder" ? "other-owner" : original.responderPrincipalId,
          toolInput: {
            ...original.toolInput,
            appId: plan.selection.appId,
            plan,
            planDigest: operatorPlanDigest(plan),
          },
        },
      ];
      await (kind === "owner" || kind === "session"
        ? expect(f.read(context, f.desired)).rejects.toThrow("authorization_required")
        : expect(f.read(context, f.desired)).resolves.toEqual([]));
      expect(f.readActiveCustomers).not.toHaveBeenCalled();
    },
  );

  it("rejects malformed plan approval digests before any metadata read", async () => {
    const f = fixture();
    const prior = f.receipt(1);
    f.session.privateApprovalReceipts = [
      { ...prior, toolInput: { ...prior.toolInput, planDigest: "0".repeat(64) } },
    ];
    await expect(f.read(context, f.desired)).rejects.toThrow();
    expect(f.readActiveCustomers).not.toHaveBeenCalled();
  });

  it("requires the exact owner-scoped canonical receipt", async () => {
    const f = fixture();
    f.readApproval.mockResolvedValue(null);
    await expect(f.read(context, f.desired)).rejects.toThrow("authorization_required");
    expect(f.readActiveCustomers).not.toHaveBeenCalled();
  });

  it("propagates unknown active scope instead of omitting the original owner", async () => {
    const f = fixture();
    f.readActiveCustomers.mockRejectedValue(new Error("metadata unavailable"));
    await expect(f.read(context, f.desired)).rejects.toThrow("metadata unavailable");
  });

  it("excludes observed inactive scope", async () => {
    const f = fixture();
    f.readActiveCustomers.mockResolvedValue([]);
    await expect(f.read(context, f.desired)).resolves.toEqual([]);
  });

  it("rechecks latest settlement after active scope observation", async () => {
    const f = fixture();
    f.readActiveCustomers.mockImplementation(async () => {
      f.session.privateApprovalReceipts = [{ ...f.receipt(1), sequence: 2, outcome: "cancelled" }];
      return await Promise.resolve(["original-org"]);
    });
    await expect(f.read(context, f.desired)).rejects.toThrow("authorization_required");
  });

  it("rejects an active result outside the canonically approved actor scope", async () => {
    const f = fixture();
    f.readActiveCustomers.mockResolvedValue(["foreign-org"]);
    await expect(f.read(context, f.desired)).rejects.toThrow("resource_mismatch");
  });

  it("preserves the fresh owner check after metadata observation", async () => {
    const f = fixture();
    f.readOwner
      .mockResolvedValueOnce({ session: f.session })
      .mockRejectedValue(new Error("owner revoked"));
    await expect(f.read(context, f.desired)).rejects.toThrow("owner revoked");
  });
});

describe("normal actor plan with retained installation scope", () => {
  it("reviews the exact schema target union while preserving QA actors, access and membership program", async () => {
    const f = participantResolutionFixture();
    const original = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      f.ports,
      {},
      true,
      true,
    );
    const readAppInstallationCustomerIds = vi.fn(
      async () => await Promise.resolve(["retained-owner-org"]),
    );
    const proposed = await resolveFullPlan(
      f.base,
      context,
      f.configuration,
      { ...f.ports, readAppInstallationCustomerIds },
      {},
      true,
      true,
    );
    expect(proposed.appInstallation?.customerIds).toEqual([
      "first-org",
      "second-org",
      "retained-owner-org",
    ]);
    expect(proposed.access).toEqual(original.access);
    expect(proposed.normalActorProgram).toEqual(original.normalActorProgram);
    expect(proposed.normalActorPreparation).toEqual(original.normalActorPreparation);
    expect(proposed.authMembership).toEqual(original.authMembership);
    expect(proposed.effects.map((effect) => [effect.id, effect.kind])).toEqual(
      original.effects.map((effect) => [effect.id, effect.kind]),
    );
    expect(operatorPlanDigest(proposed)).not.toBe(operatorPlanDigest(original));
    const description = publicApprovalDescription(
      {
        appId: proposed.selection.appId,
        branch: proposed.selection.branch,
        projectId: proposed.selection.projectId,
        environment: "preview",
        operationRef: "00000000-0000-4000-8000-000000000099",
        plan: proposed,
        planDigest: operatorPlanDigest(proposed),
      },
      "prepare-app-hosted-runtime",
    );
    expect(description).toBe("This approval may incur provider costs.");
  });

  it("does not silently omit an unknown retained installation scope", async () => {
    const f = participantResolutionFixture();
    await expect(
      resolveFullPlan(
        f.base,
        context,
        f.configuration,
        {
          ...f.ports,
          readAppInstallationCustomerIds: async () =>
            await Promise.reject(new Error("retained scope unknown")),
        },
        {},
        true,
        true,
      ),
    ).rejects.toThrow("retained scope unknown");
  });
});
