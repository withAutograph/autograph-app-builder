import { afterEach, describe, expect, it, vi } from "vitest";
import nativeEntryPoint from "./hosted-operator-function";
import { createDependencies, resolveFullPlan } from "./hosted-operator-composition";
import { readHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

import { hostedOperatorPlanSchema } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
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
