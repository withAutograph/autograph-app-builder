import { afterEach, describe, expect, it, vi } from "vitest";
import nativeEntryPoint from "./hosted-operator-function";
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
import { selectAuthPlanningResourceBindingRow } from "./hosted-operator-deployment";
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
import type { HostedOperatorContext } from "./hosted-operator-service";
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
    const plan = await resolveFullPlan(bootstrapPlan(), context, f.configuration, f.controlPlane);
    expect(plan.stage).toBe("app");
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

  it("binds owner signup eligibility and roles to its approved Auth organization", async () => {
    const f = publicationFixture({ repoId: "actual-repository-id", gitSha: "c".repeat(40) });
    const base = hostedOperatorPlanSchema.parse({
      ...bootstrapPlan(),
      publicGateway: {
        branch: "gateway",
        origin: "https://apps.example",
        projectId: "gateway",
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
          gatewayOrigin: "https://gateway.example",
          jwksUrl: "https://gateway.example/_platform/jwks.json",
          publicOrigin: "https://apps.example",
        },
      },
    });
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
    ...bootstrapPlan(),
    normalActorProgram: program,
    publicGateway: { projectId: "gateway", branch: "gateway-actual", origin: program.origin },
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
  it("preserves a consumed owner nonce when proof capture races the identity-link read", async () => {
    const f = setup("current");
    const operator = f.original.operator!;
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
    const prepareRealmIdentityLink = vi.fn();
    Object.assign(f.controlPlane, { prepareRealmIdentityLink });
    const before = structuredClone(operator.identityLink);
    await expect(
      f.dependencies.authIdentityInput!({
        ...context,
        operationRef: operator.operationRef,
        plan: operator.plan,
      }),
    ).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(prepareRealmIdentityLink).not.toHaveBeenCalled();
    expect(providerInventory.readHostedOperatorProviderInventory).not.toHaveBeenCalled();
    expect(operator.identityLink).toEqual(before);
  });
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
