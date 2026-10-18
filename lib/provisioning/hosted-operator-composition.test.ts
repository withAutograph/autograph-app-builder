import { afterEach, describe, expect, it, vi } from "vitest";
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

import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  HostedOperatorDeploymentContext,
  HostedOperatorEffectContext,
  HostedOperatorWorkerEffectContext,
} from "./hosted-operator-service";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on the provider adapter boundary while exercising real composition context routing.
import * as deploymentDelivery from "./hosted-operator-deployment-delivery";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Inspect the environment verification context without a provider request.
import * as gatewayBindingAdapter from "./hosted-operator-gateway-bindings";
import type { HostedOperatorNormalActorPlanningPorts } from "./hosted-operator-composition";
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
  const controlPlane = {
    readCapturedRealmIdentity,
    readCapturedRealmIdentityProof,
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
    unexpectedPort,
    verifiedIdentity,
  };
};

describe("app publication binding at plan renewal", () => {
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

const participantResolutionFixture = () => {
  const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
  const program = normalActorProgramSchema.parse({
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
      realmSessionId: "normal-owner-session",
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

describe("participant plan resolution", () => {
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
