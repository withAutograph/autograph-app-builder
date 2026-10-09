/* oxlint-disable eslint/require-await -- Synthetic native ports remain asynchronous like their production contracts. */
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorOwnerContext } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles } from "./hosted-runtime-service";
import {
  activateHostedOperatorSharedAuth,
  describeHostedOperatorSharedAuth,
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
  sealHostedOperatorSharedAuth,
} from "./hosted-operator-resource-credentials";
import type { ResourceCredentialInput } from "./hosted-operator-resource-credentials";

import { composeHostedOperatorDependencies } from "./hosted-operator-composition";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import type { HostedOperatorSandboxWorkerInput } from "./hosted-operator-sandbox-launcher";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Capture the native maintenance reader port without provider calls.
import * as nativeNeon from "./hosted-operator-native-preview-neon-mcp";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Capture the native sandbox launcher port without starting a sandbox.
import * as sandbox from "./hosted-operator-sandbox-launcher";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const config = { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture" };
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const target = (appId: string): HostedRuntimeTarget => ({
  appId,
  branch: "preview",
  environment: "preview",
  installationId: "installation",
  projectId: `prj_${appId}`,
  scopeId: "team",
  scopeType: "team",
  sessionId: `session_${appId}`,
});
const owner = (request: HostedRuntimeTarget): OperatorOwnerContext => ({
  adapterGeneration: 1,
  adapterSessionId: `adapter_${request.appId}`,
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:get"] },
  sessionId: request.sessionId,
});
const context = (request: HostedRuntimeTarget) => ({
  authority,
  ownerContext: owner(request),
  target: request,
});
const sourcePlan = () => {
  const {
    installationId: _installation,
    scopeId: _scope,
    scopeType: _scopeType,
    ...selection
  } = target("first");
  void _installation;
  void _scope;
  void _scopeType;
  return hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("first"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "source-auth-artifact",
      installer: { reference: "auth-worker", sha256: "a".repeat(64) },
      planDigest: "b".repeat(64),
      targetDigest: "c".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "fixture",
    cost: { class: "shared-recovery-group", description: "synthetic fixture", owner: "owner" },
    effects: [
      { description: "Auth", id: "auth-resources", kind: "resources", resourceId: "auth-resource" },
      { description: "App", id: "app-resources", kind: "resources", resourceId: "first-resource" },
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "d".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "owner-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "synthetic-project",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: "preview",
      origin: "https://gateway.example.test",
      projectId: "prj_gateway",
    },
    release: { artifactRef: "source-release", id: "release", sha256: "f".repeat(64) },
    resourcesInstaller: { reference: "resource-worker", sha256: "e".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    selection,
    stage: "auth-bootstrap",
    version: 1,
  });
};
const row = (
  request: HostedRuntimeTarget,
  plan: HostedOperatorPlan,
  ready = false,
): HostedRuntimeJournalRow => ({
  record: hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "call",
    kind: "app-runtime",
    operator: {
      approvalId: "approval",
      authPreparation: ready
        ? {
            assetSha256: "9".repeat(64),
            catalogFingerprint: "b".repeat(64),
            database: "auth",
            observedAt: "2026-10-09T00:00:00Z",
            runtimeRole: "auth_runtime",
            targetDigest: "c".repeat(64),
          }
        : undefined,
      fenceGeneration: 1,
      mode: "protected-operator-v1",
      operationRef: randomUUID(),
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: ready
        ? plan.effects.map((effect) => ({
            effectId: effect.id,
            observedAt: "2026-10-09T00:00:00Z",
            resourceVersion: "observed",
          }))
        : [],
    },
    request,
    status: "pending",
    step: "reserved",
    version: 1,
  }),
  revision: 1,
});
const requireOperator = (record: HostedRuntimeJournalRecord) => {
  if (record.operator === undefined) {
    throw new Error("Fixture operator missing");
  }
  return record.operator;
};
const requirePreparation = (record: HostedRuntimeJournalRecord) => {
  const preparation = requireOperator(record).authPreparation;
  if (preparation === undefined) {
    throw new Error("Fixture readiness missing");
  }
  return preparation;
};

const gatewayKeys = [
  "AUTH_DATABASE_RESOURCE",
  "PLATFORM_AUTH_DATABASE_URL",
  "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
  "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
  "PLATFORM_GATEWAY_PROJECT_BINDINGS",
];
const fixture = () => {
  const plan = sourcePlan();
  const request = target("first");
  const { record } = row(request, plan, true);
  requireOperator(record).gatewayEnvironment = gatewayKeys.map((key) => ({
    branch: "preview",
    comment: `App Builder protected operator ${requireOperator(record).operationRef}`,
    id: `env_${key}`,
    key,
    operationRef: requireOperator(record).operationRef,
    projectId: "prj_gateway",
    valueSha256: "e".repeat(64),
  }));
  const source = { ...context(request), config, plan, record };
  record.privateState = prepareHostedOperatorResourceCredentials({
    ...source,
    database: "authDatabase",
  }).privateState;
  return source;
};
const pending = (source: ResourceCredentialInput, appId = "second") => {
  const request = target(appId);
  const plan = hostedOperatorPlanSchema.parse({
    ...source.plan,
    appDatabase: resource(appId),
    authAdoption: describeHostedOperatorSharedAuth(source),
    effects: source.plan.effects.map((effect) =>
      effect.id === "app-resources" ? { ...effect, resourceId: `${appId}-resource` } : effect,
    ),
    selection: {
      ...source.plan.selection,
      appId,
      projectId: request.projectId,
      sessionId: request.sessionId,
    },
  });
  const { record } = row(request, plan);
  const input = { ...context(request), config, plan, record };
  record.privateState = sealHostedOperatorSharedAuth({ source, target: input });
  return input;
};
const activate = (source: ResourceCredentialInput, destination: ResourceCredentialInput) => {
  destination.record.privateState = activateHostedOperatorSharedAuth({
    authPreparation: { ...requirePreparation(source.record), observedAt: "2026-10-09T01:00:00Z" },
    gatewayEnvironment: requireOperator(source.record).gatewayEnvironment ?? [],
    source,
    target: destination,
  });
};
const credentials = (input: ResourceCredentialInput) => {
  const files = decryptHostedRuntimeFiles(input);
  if (files === undefined) {
    throw new Error("Fixture checkpoint missing");
  }
  return z
    .object({
      appDatabase: z.object({ migratorPassword: z.string(), runtimePassword: z.string() }),
      authDatabase: z.object({ migratorPassword: z.string(), runtimePassword: z.string() }),
    })
    .parse(JSON.parse(files["protected-resource-credentials.json"]));
};

type ControlPlane = Awaited<ReturnType<typeof createHostedOperatorControlPlane>>;
const composed = (active = true) => {
  const source = fixture();
  const destination = pending(source);
  const saved = credentials(destination);
  const sourceCredentials = credentials(source);
  if (active) {
    activate(source, destination);
  }
  const ciphertext = structuredClone(destination.record.privateState);
  source.record.status = "cleaned";
  delete source.record.operator;
  delete source.record.privateState;
  const unavailable = vi.fn(() => {
    throw new Error("Unexpected source, Auth, or provider path");
  });
  const workload = {
    audience: "https://vercel.com/team",
    environment: "preview" as const,
    issuer: "https://oidc.vercel.com/team",
    ownerId: "team",
    projectId: "builder",
    subject: "builder-workload",
  };
  const worker = {
    executablePath: "/fixed-worker",
    id: "resource-worker",
    operationScope: "neon-resource-bootstrap-v1" as const,
    sha256: "e".repeat(64),
    subcommand: "neon-resource-bootstrap" as const,
  };
  const configuration: HostedOperatorSourceConfiguration = {
    applications: {
      second: {
        accessRoles: ["member"],
        appDatabase: resource("second"),
        branch: "preview",
        gitSha: "a".repeat(40),
        projectId: "prj_second",
        repoId: "repo",
      },
    },
    authDatabase: resource("auth"),
    builderCallbackOrigin: "https://builder.example",
    catalogAppIds: ["first", "second"],
    gateway: {
      authBrowserOrigin: "https://auth.example",
      branch: "preview",
      environment: "preview",
      gatewayOrigin: "https://gateway.example",
      gitSha: "a".repeat(40),
      projectId: "prj_gateway",
      protectedApplicationIds: ["first", "second"],
      publicOrigin: "https://gateway.example.test",
      repoId: "repo",
      workload: { ...workload, projectId: "prj_gateway" },
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
          environment: workload.environment,
          issuer: workload.issuer,
          ownerId: workload.ownerId,
          projectId: "operator",
        },
      },
      scope: {
        branchId: "br-fixture",
        endpointId: "ep-fixture",
        hostname: "ep-fixture.neon.tech",
        maintenanceDatabase: "neondb",
        maintenanceRole: "neondb_owner",
        projectId: "synthetic-project",
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
      authProposal: { executablePath: "/proposal", id: "proposal", sha256: "a".repeat(64) },
      authWorker: worker,
      image: "fixture",
      projectId: "operator",
      resourcesWorker: worker,
      teamId: "team",
      workers: { second: worker },
    },
    teamId: "team",
    workloadPolicy: workload,
  };
  const assertCurrent = vi.fn(async () => {});
  const assertAuthorized = vi.fn(async () => {});
  const inputFor = (input: { plan: HostedOperatorPlan }) => ({ ...destination, plan: input.plan });
  const preparedCredentials = (input: { plan: HostedOperatorPlan }) => {
    const prepared = prepareHostedOperatorResourceCredentials({
      ...inputFor(input),
      database: "appDatabase",
    });
    return {
      bytes: Buffer.from(prepared.credentialsBytes),
      privateState: prepared.privateState,
      sha256: prepared.credentialsSha256,
    };
  };
  const prepareResourceCredentials = vi.fn<ControlPlane["prepareResourceCredentials"]>(
    async (input) => {
      const prepared = prepareHostedOperatorResourceCredentials({
        ...inputFor(input),
        database: input.database,
      });
      await input.checkpoint(prepared.privateState);
      return {
        bytes: Buffer.from(prepared.credentialsBytes),
        privateState: prepared.privateState,
        sha256: prepared.credentialsSha256,
      };
    },
  );
  const readResourceBindings = vi.fn<ControlPlane["readResourceBindings"]>(async (input) => {
    if (!("plan" in input)) {
      throw new Error("Missing fixture plan");
    }
    return readHostedOperatorResourceBindings(inputFor(input));
  });
  const readRetirementResourceCredentials = vi.fn<
    ControlPlane["readRetirementResourceCredentials"]
  >(async (input) => {
    if (input.effect.resourceId !== input.plan.appDatabase.resourceId) {
      throw new Error("Retirement must be app scoped");
    }
    return preparedCredentials(input);
  });
  const controlPlane: ControlPlane = {
    assertAuthorized,
    assertMembershipCapture: unavailable,
    assertPlanningAuthorized: unavailable,
    authorize: unavailable,
    checkpointSharedAuthAdoption: unavailable,
    close: unavailable,
    consumeOwnerRealmIdentityCallback: unavailable,
    prepareRealmIdentityLink: unavailable,
    prepareResourceCredentials,
    publishAuthPlan: unavailable,
    readActiveSharedAuth: unavailable,
    readApproval: unavailable,
    readAuthPlan: unavailable,
    readCapturedRealmIdentity: unavailable,
    readCapturedRealmIdentityProof: unavailable,
    readCredential: unavailable,
    readCurrentPlanningOwner: unavailable,
    readGeneratedRelease: async (_input, selection) => ({
      artifactRef: selection.artifactRef,
      files: {
        "app-artifact.json": Buffer.from("{}"),
        "cue-to-sql-source-map.json": Buffer.from("{}"),
        "data-operations.md": Buffer.from("fixture"),
        "data-operations.ts": Buffer.from("export {}"),
        "data-server.ts": Buffer.from("export {}"),
        "operation-manifest.json": Buffer.from("{}"),
        "release-manifest.json": Buffer.from("{}"),
        "runtime-coverage.json": Buffer.from("{}"),
        "sql-bundle.sql": Buffer.from("select 1"),
        "sql-manifest.json": Buffer.from("{}"),
        "transition-contract.json": Buffer.from("{}"),
        "transition-plan.json": Buffer.from("{}"),
      },
    }),
    readGeneratedSelection: async () => ({
      appId: "second",
      appSpecDigest: "a".repeat(64),
      artifactRef: destination.plan.release.artifactRef,
      manifestSha256: destination.plan.release.sha256,
      releaseId: destination.plan.release.id,
      schemaSha256: "b".repeat(64),
      version: 1,
    }),
    readPendingRealmIdentityLinkForStaging: unavailable,
    readRealmIdentityLink: unavailable,
    readResourceBindings,
    readRetirementResourceCredentials,
    readSharedAuthAdoption: unavailable,
    readSharedGatewayRows: unavailable,
    reserveRealmIdentityLink: unavailable,
    resolveRealmIdentityCallbackContext: unavailable,
    store: {
      compareAndSet: unavailable,
      read: unavailable,
      reserve: unavailable,
      reserveFenceGeneration: unavailable,
    },
    verifySharedAuthAdoption: unavailable,
    withResourceLease: unavailable,
  };
  const maintenance = vi.fn(async () => {});
  vi.spyOn(nativeNeon, "createPreviewNeonMcpReader").mockImplementation(() => ({
    inspectPlanningTarget: unavailable,
    withMaintenanceCredential: async (input, scope, consume) => {
      await maintenance();
      expect(input.target.appId).toBe("second");
      return await consume({
        initSource: "schema-only",
        maintenanceUrl:
          "postgres://neondb_owner:synthetic-maintenance@ep-fixture.neon.tech/neondb?sslmode=verify-full",
        scope,
      });
    },
  }));
  const execute = vi.fn(async (_input: HostedOperatorSandboxWorkerInput) => {});
  const inspect = vi.fn<ReturnType<typeof sandbox.createHostedOperatorSandboxLauncher>["inspect"]>(
    async (input) => ({
      context_digest: "0".repeat(64),
      fence_generation: input.fenceGeneration,
      operation_id: input.operationRef,
      readback_sha256: "f".repeat(64),
      resource_id: input.plan.appDatabase.resourceId,
      scope: "app_database" as const,
      status: "applied" as const,
      version: 1 as const,
    }),
  );
  vi.spyOn(sandbox, "createHostedOperatorSandboxLauncher").mockImplementation(() => ({
    execute,
    inspect,
  }));
  const native = composeHostedOperatorDependencies(configuration, controlPlane);
  const effect = (kind: "resources" | "retire"): HostedOperatorWorkerEffectContext => {
    const plan =
      kind === "resources"
        ? destination.plan
        : hostedOperatorPlanSchema.parse({
            ...destination.plan,
            action: "cleanup",
            effects: [
              { description: "Revoke app", id: "revoke", kind: "revoke" },
              {
                description: "Remove app bindings",
                id: "remove-bindings",
                kind: "remove-bindings",
              },
              {
                description: "Retire app only",
                id: "retire",
                kind: "retire",
                resourceId: "second-resource",
              },
            ],
            stage: "app",
          });
    return {
      ...context(destination.target),
      assertCurrent,
      bindWorkerContext: unavailable,
      checkpoint: async (privateState) => {
        destination.record.privateState = privateState;
      },
      effect: {
        description: "Owned app only",
        id: kind === "resources" ? "app-resources" : "retire",
        kind,
        resourceId: "second-resource",
      },
      fenceGeneration: 1,
      operationRef: requireOperator(destination.record).operationRef,
      plan,
      privateState: destination.record.privateState,
      workerAttemptId: randomUUID(),
      workerCheckpoints: [],
    };
  };
  return {
    ciphertext,
    destination,
    effect,
    execute,
    inspect,
    maintenance,
    native,
    prepareResourceCredentials,
    readResourceBindings,
    readRetirementResourceCredentials,
    saved,
    sourceCredentials,
    unavailable,
  };
};

afterEach(() => {
  vi.restoreAllMocks();
});
describe("native composition with independently active shared Auth", () => {
  it("bootstraps only the app resource with its independent credentials after the original source is gone", async () => {
    const f = composed();
    const input = f.effect("resources");
    expect(await f.native.reconcile(input)).toMatchObject({ status: "applied" });
    expect(await f.native.executeEffect(input)).toMatchObject({ effectId: "app-resources" });
    expect(f.saved.authDatabase).toEqual(f.sourceCredentials.authDatabase);
    expect(f.saved.appDatabase).not.toEqual(f.sourceCredentials.appDatabase);
    expect(f.prepareResourceCredentials).toHaveBeenCalledTimes(2);
    for (const call of f.prepareResourceCredentials.mock.calls) {
      expect(call[0].database).toBe("appDatabase");
    }
    expect(f.execute).toHaveBeenCalledOnce();
    const dispatched = f.execute.mock.calls[0]?.[0];
    expect(dispatched?.database).toBe("appDatabase");
    expect(dispatched?.effect.resourceId).toBe("second-resource");
    expect(dispatched?.authSchemaPlan).toBeUndefined();
    expect(JSON.parse(dispatched?.resourceCredentials?.bytes.toString() ?? "null")).toEqual(
      f.saved.appDatabase,
    );
    expect(JSON.parse(dispatched?.resourceCredentials?.bytes.toString() ?? "null")).not.toEqual(
      f.saved.authDatabase,
    );
    expect(f.inspect).toHaveBeenCalledTimes(2);
    expect(f.maintenance).toHaveBeenCalledTimes(2);
    expect(f.destination.record.privateState).toEqual(f.ciphertext);
    expect(f.unavailable).not.toHaveBeenCalled();
  });
  it("retires only the owned app resource using active local bindings and keeps shared Auth ciphertext", async () => {
    const f = composed();
    const input = f.effect("retire");
    expect(await f.native.reconcile(input)).toMatchObject({ status: "applied" });
    expect(await f.native.executeEffect(input)).toMatchObject({ effectId: "retire" });
    expect(f.prepareResourceCredentials).not.toHaveBeenCalled();
    expect(f.readRetirementResourceCredentials).toHaveBeenCalledTimes(2);
    expect(f.readResourceBindings).toHaveBeenCalledTimes(2);
    expect(f.maintenance).toHaveBeenCalledTimes(2);
    expect(f.execute).toHaveBeenCalledOnce();
    const dispatched = f.execute.mock.calls[0]?.[0];
    expect(dispatched?.database).toBe("appDatabase");
    expect(dispatched?.effect.resourceId).toBe("second-resource");
    expect(dispatched?.authSchemaPlan).toBeUndefined();
    expect(JSON.parse(dispatched?.resourceCredentials?.bytes.toString() ?? "null")).toEqual(
      f.saved.appDatabase,
    );
    expect(dispatched?.accessConnections?.authRuntime).toContain("auth_runtime");
    expect(f.destination.record.privateState).toEqual(f.ciphertext);
    expect(f.unavailable).not.toHaveBeenCalled();
  });
  it.each(["resources", "retire"] as const)(
    "blocks pending adoption before releasing %s credentials to native ports",
    async (kind) => {
      const f = composed(false);
      await expect(f.native.reconcile(f.effect(kind))).rejects.toThrow("reconciliation_required");
      await expect(f.native.executeEffect(f.effect(kind))).rejects.toThrow(
        "reconciliation_required",
      );
      expect(f.execute).not.toHaveBeenCalled();
      expect(f.inspect).not.toHaveBeenCalled();
      expect(f.maintenance).not.toHaveBeenCalled();
      expect(f.unavailable).not.toHaveBeenCalled();
      expect(f.destination.record.privateState).toEqual(f.ciphertext);
    },
  );
});
