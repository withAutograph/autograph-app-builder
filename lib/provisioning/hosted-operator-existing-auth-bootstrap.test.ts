/* oxlint-disable typescript/no-non-null-assertion -- Schema-parsed controlled fixtures explicitly construct each tested optional record. */
import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import { readHostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import {
  createExistingAuthBootstrapPrerequisite,
  configuredBootstrapGatewayBindings,
} from "./hosted-operator-existing-auth-bootstrap";
import type { HostedOperatorContext } from "./hosted-operator-service";

const authority = {
  issuer: "https://builder.example/api/auth",
  audience: "https://builder.example/mcp",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  target: {
    appId: "fixture",
    branch: "preview",
    environment: "preview",
    projectId: "app",
    sessionId: "session",
    installationId: "installation",
    scopeId: "team",
    scopeType: "team",
  },
};
const resource = (name: string) => ({
  resourceId: `${name}-resource`,
  database: name,
  runtimeRole: `${name}_runtime`,
  migratorRole: `${name}_owner`,
});
const worker = {
  executablePath: "/fixture",
  id: "fixture-worker",
  sha256: "a".repeat(64),
  subcommand: "auth-protected-schema",
  operationScope: "auth-protected-schema-v1",
};
const fixture = () => {
  const native = {
    projectId: "neon",
    branchId: "branch",
    endpointId: "endpoint",
    hostname: "ep-fixture.neon.tech",
    maintenanceRole: "neondb_owner",
    maintenanceDatabase: "neondb",
  };
  const workload = {
    issuer: "https://oidc.vercel.com/team",
    audience: "https://vercel.com/team",
    ownerId: "team",
    projectId: "gateway",
    environment: "preview",
    subject: "gateway-workload",
  };
  const configuration = readHostedOperatorSourceConfiguration({
    PROTECTED_HOSTED_OPERATOR_CONFIGURATION: JSON.stringify({
      teamId: "team",
      authDatabase: resource("auth"),
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: ["fixture"],
      applications: {
        fixture: {
          accessRoles: ["member"],
          appDatabase: resource("app"),
          branch: "preview",
          projectId: "app",
        },
      },
      gateway: {
        authBrowserOrigin: "https://apps.example",
        branch: "gateway",
        environment: "preview",
        gatewayOrigin: "https://immutable-gateway.example",
        gitSha: "a".repeat(40),
        projectId: "gateway",
        protectedApplicationIds: ["fixture"],
        publicOrigin: "https://apps.example",
        repoId: "gateway-repository",
        workload,
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        origin: "https://operator.example",
        projectId: "operator",
      },
      nativeNeon: {
        scope: native,
        configuration: {
          connector: "connection",
          nativeStore: {
            configurationId: "installation",
            resourceId: "store",
            sourceProjectId: "operator",
          },
          operator: {
            issuer: workload.issuer,
            audience: workload.audience,
            ownerId: "team",
            projectId: "operator",
            environment: "preview",
          },
        },
      },
      workloadPolicy: {
        ...workload,
        projectId: "builder",
        environment: "production",
        subject: "builder-workload",
      },
      sandbox: {
        image: "fixture",
        teamId: "team",
        projectId: "operator",
        accessWorker: worker,
        authWorker: worker,
        resourcesWorker: worker,
        authProposal: { executablePath: "/proposal", id: "proposal", sha256: "b".repeat(64) },
        workers: { fixture: worker },
      },
    }),
  });
  const plan = hostedOperatorPlanSchema.parse({
    version: 1,
    stage: "auth-bootstrap",
    action: "prepare",
    access: [],
    appDatabase: resource("app"),
    authDatabase: resource("auth"),
    contextId: "historical-accepted-spec",
    authSchema: {
      artifactRef: "original-auth-plan",
      installer: { reference: "auth-worker", sha256: "c".repeat(64) },
      planDigest: "d".repeat(64),
      targetDigest: "e".repeat(64),
    },
    bootstrap: {
      endpointId: native.endpointId,
      maintenanceDatabase: native.maintenanceDatabase,
      role: native.maintenanceRole,
    },
    cost: { class: "shared-recovery-group", description: "Original approved Auth", owner: "owner" },
    effects: [
      { id: "auth-resources", kind: "resources", resourceId: "auth-resource", description: "Auth" },
      { id: "app-resources", kind: "resources", resourceId: "app-resource", description: "App" },
      { id: "auth-schema", kind: "install", description: "Auth schema" },
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
    ],
    installer: { reference: "historical-app-worker", sha256: "f".repeat(64) },
    release: {
      artifactRef: "historical-app-release",
      id: "historical-release",
      sha256: "1".repeat(64),
    },
    neon: {
      branchId: native.branchId,
      connectionRef: "connection",
      endpoint: native.hostname,
      projectId: native.projectId,
      source: "synthetic-only",
    },
    resourcesInstaller: { reference: "resources-worker", sha256: "2".repeat(64) },
    retention: { expiresAt: "2030-01-01T00:00:00Z", policy: "Retain Auth" },
    selection: {
      appId: context.target.appId,
      branch: context.target.branch,
      environment: context.target.environment,
      projectId: context.target.projectId,
      sessionId: context.target.sessionId,
    },
    publicGateway: { branch: "gateway", projectId: "gateway", origin: "https://apps.example" },
    gatewayBindings: configuredBootstrapGatewayBindings(configuration),
    gatewayDelivery: {
      branch: "gateway",
      projectId: "gateway",
      gitSha: configuration.gateway.gitSha,
      repoId: "gateway-repository",
    },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        projectId: "app",
        branch: "preview",
        environment: "preview",
        deploymentId: "app-deployment",
      },
      gateway: {
        projectId: "gateway",
        branch: "gateway",
        environment: "preview",
        deploymentId: "gateway-deployment",
      },
      operator: {
        projectId: "operator",
        environment: "preview",
        deploymentId: "operator-deployment",
      },
      verification: {
        publicOrigin: "https://apps.example",
        gatewayOrigin: "https://immutable-gateway.example",
        jwksUrl: "https://immutable-gateway.example/_platform/jwks.json",
      },
    },
  });
  const record = hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    status: "pending",
    step: "reserved",
    request: context.target,
    approvedByCallId: "original-call",
    privateState: {
      encryptedToken: "retained-private-ciphertext",
      keyVersion: "v1",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    operator: {
      mode: "protected-operator-v1",
      operationRef: "11111111-1111-4111-8111-111111111111",
      plan,
      planDigest: operatorPlanDigest(plan),
      approvalId: "original-approval",
      authPreparation: {
        assetSha256: "3".repeat(64),
        catalogFingerprint: "4".repeat(64),
        database: "auth",
        runtimeRole: "auth_runtime",
        targetDigest: plan.authSchema?.targetDigest,
        observedAt: "2026-10-19T12:00:00Z",
      },
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt: "2026-10-19T12:00:00Z",
        resourceVersion: "observed",
      })),
    },
  });
  record.retainedAuth = retainedOperatorAuthFromJournal(record);
  configuration.gateway.gitSha = "b".repeat(40);
  return {
    configuration,
    record,
    context: structuredClone(context),
    plan,
    now: Date.parse("2026-10-19T12:00:00Z"),
  };
};
const propose = (f: ReturnType<typeof fixture>) =>
  createExistingAuthBootstrapPrerequisite(
    f.record,
    f.context,
    f.configuration,
    f.configuration.applications.fixture.appDatabase,
    f.now,
  );

describe("retained existing Auth bootstrap prerequisite", () => {
  it("proposes only new Gateway intent without changing the owned resource context or old release", () => {
    const f = fixture();
    const before = structuredClone(f.record);
    const proposed = propose(f);
    expect(proposed?.plan.stage).toBe("auth-bootstrap");
    expect(proposed?.plan.contextId).toBe(f.plan.contextId);
    expect(proposed?.plan.release).toEqual(f.plan.release);
    expect(proposed?.plan.appDatabase).toEqual(f.plan.appDatabase);
    expect(proposed?.plan.authDatabase).toEqual(f.plan.authDatabase);
    expect(proposed?.plan.neon).toEqual(f.plan.neon);
    expect(proposed?.plan.gatewayDelivery?.gitSha).toBe(f.configuration.gateway.gitSha);
    expect(proposed?.auth.approvalId).toBe("original-approval");
    expect(proposed?.plan.access).toEqual([]);
    expect(f.record).toEqual(before);
  });
  it("leaves completed matching Gateway work to ordinary current app release planning", () => {
    const f = fixture();
    f.configuration.gateway.gitSha = "a".repeat(40);
    expect(propose(f)).toBeUndefined();
  });
  it("reexposes an existing unfinished matching bootstrap rather than generating a replacement approval", () => {
    const f = fixture();
    const proposed = propose(f)!;
    f.record.operator!.plan = proposed.plan;
    f.record.operator!.planDigest = operatorPlanDigest(proposed.plan);
    f.record.operator!.receipts = [];
    f.record.operator!.pendingEffectId = "gateway-delivery";
    f.now += 1000;
    expect(propose(f)?.plan).toEqual(proposed.plan);
  });
  it.each([
    "owner",
    "selection",
    "Auth",
    "Neon",
    "gateway-project",
    "gateway-repository",
    "public-origin",
  ] as const)("does not borrow a foreign %s scope", (scope) => {
    const f = fixture();
    switch (scope) {
      case "owner": {
        f.context.authority.ownerUserId = "another-owner";
        break;
      }
      case "selection": {
        f.context.target.sessionId = "another-session";
        break;
      }
      case "Auth": {
        f.configuration.authDatabase.runtimeRole = "another_role";
        break;
      }
      case "Neon": {
        f.configuration.nativeNeon.scope.branchId = "another-branch";
        break;
      }
      case "gateway-project": {
        f.configuration.gateway.projectId = "another-project";
        break;
      }
      case "gateway-repository": {
        f.configuration.gateway.repoId = "another-repository";
        break;
      }
      case "public-origin": {
        f.configuration.gateway.publicOrigin = "https://other.example";
        break;
      }
      default: {
        throw new Error("Unknown fixture scope");
      }
    }
    expect(propose(f)).toBeUndefined();
  });
  it("refreshes infrastructure after an app revision without using that app release as new authority", () => {
    const f = fixture();
    const app = hostedOperatorPlanSchema.parse({
      ...f.plan,
      stage: "app",
      contextId: "published-next-app-spec",
      release: {
        artifactRef: "published-current-app-release",
        id: "published-current-release",
        sha256: "9".repeat(64),
      },
      delivery: {
        branch: "preview",
        gitSha: "c".repeat(40),
        projectId: "app",
        repoId: "app-repository",
      },
      effects: [
        ...f.plan.effects.filter((effect) => ["resources", "install"].includes(effect.kind)),
        { id: "install-app", kind: "install", description: "Current app install" },
        { id: "access", kind: "access", description: "Verify current app access" },
        { id: "bindings", kind: "bindings", description: "Bind current app" },
        { id: "delivery", kind: "delivery", description: "Current published app delivery" },
        ...f.plan.effects.filter((effect) =>
          ["gateway-bindings", "gateway-delivery"].includes(effect.kind),
        ),
      ],
    });
    f.record = hostedRuntimeJournalRecordSchema.parse({
      ...f.record,
      status: "prepared",
      step: "bound",
      environmentBound: true,
      operator: {
        ...f.record.operator!,
        plan: app,
        planDigest: operatorPlanDigest(app),
        receipts: app.effects.map((effect) => ({
          effectId: effect.id,
          observedAt: "2026-10-19T12:00:00Z",
          resourceVersion: "observed",
        })),
      },
      proof: {
        actors: 0,
        tenants: 1,
        authenticatedBehavior: "unassessed",
        artifactHash: "8".repeat(64),
        manifestSha256: app.release.sha256,
        releaseId: app.release.id,
      },
    });
    const before = structuredClone(f.record);
    const proposed = propose(f);
    expect(proposed?.plan.stage).toBe("auth-bootstrap");
    expect(proposed?.plan.contextId).toBe(f.plan.contextId);
    expect(proposed?.plan.release).toEqual(f.plan.release);
    expect(proposed?.plan.delivery).toBeUndefined();
    expect(proposed?.plan.access).toEqual([]);
    expect(f.record).toEqual(before);
  });
  it("does not replace active or uncertain effects with a new bootstrap proposal", () => {
    const f = fixture();
    f.record.operator!.pendingEffectId = "gateway-delivery";
    expect(propose(f)).toBeUndefined();
  });
});
