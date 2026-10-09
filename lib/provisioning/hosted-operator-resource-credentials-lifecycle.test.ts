import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorOwnerContext } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles, encryptHostedRuntimeFiles } from "./hosted-runtime-service";
import {
  activateHostedOperatorSharedAuth,
  describeHostedOperatorSharedAuth,
  prepareHostedOperatorResourceCredentials,
  readActiveHostedOperatorSharedAuth,
  readHostedOperatorResourceBindings,
  sealHostedOperatorSharedAuth,
} from "./hosted-operator-resource-credentials";
import type { ResourceCredentialInput } from "./hosted-operator-resource-credentials";

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

describe("verified shared Auth credential lifecycle", () => {
  it("keeps pending passwords unavailable and activates the exact imported pair", () => {
    const source = fixture();
    const destination = pending(source);
    const saved = credentials(destination);
    const priorSource = structuredClone(source.record);
    expect(readActiveHostedOperatorSharedAuth(source)).toBeUndefined();
    expect(readActiveHostedOperatorSharedAuth(destination)).toBeUndefined();
    expect(() => readHostedOperatorResourceBindings(destination)).toThrow(
      "reconciliation_required",
    );
    expect(() =>
      prepareHostedOperatorResourceCredentials({ ...destination, database: "appDatabase" }),
    ).toThrow("reconciliation_required");
    activate(source, destination);
    expect(credentials(destination)).toEqual(saved);
    expect(source.record).toEqual(priorSource);
    expect(saved.authDatabase).toEqual(credentials(source).authDatabase);
    expect(saved.appDatabase).not.toEqual(credentials(source).appDatabase);
    const activated = destination.record.privateState;
    activate(source, destination);
    expect(destination.record.privateState).toEqual(activated);
    const proof = readActiveHostedOperatorSharedAuth(destination);
    expect(proof?.authPreparation.database).toBe("auth");
    expect(JSON.stringify(proof)).not.toContain(saved.authDatabase.runtimePassword);
    expect(() =>
      prepareHostedOperatorResourceCredentials({ ...destination, database: "authDatabase" }),
    ).toThrow("reconciliation_required");
    const app = prepareHostedOperatorResourceCredentials({
      ...destination,
      database: "appDatabase",
    });
    expect(JSON.parse(app.credentialsBytes)).toEqual(saved.appDatabase);
    expect(app.privateState).toEqual(activated);
    const missing = { ...destination, record: { ...destination.record } };
    delete missing.record.privateState;
    expect(() =>
      prepareHostedOperatorResourceCredentials({ ...missing, database: "appDatabase" }),
    ).toThrow("reconciliation_required");
  });

  it("reads bindings, app bootstrap and retirement locally after original source cleanup", () => {
    const source = fixture();
    const destination = pending(source);
    activate(source, destination);
    const before = readHostedOperatorResourceBindings(destination);
    source.record.status = "cleaned";
    delete source.record.operator;
    delete source.record.privateState;
    expect(readHostedOperatorResourceBindings(destination)).toEqual(before);
    expect(
      prepareHostedOperatorResourceCredentials({ ...destination, database: "appDatabase" })
        .privateState,
    ).toEqual(destination.record.privateState);
    const cleanupPlan = { ...destination.plan, action: "cleanup" as const, effects: [] };
    delete cleanupPlan.stage;
    const cleanup = { ...destination, plan: cleanupPlan };
    expect(readHostedOperatorResourceBindings(cleanup)).toEqual(before);
    expect(readActiveHostedOperatorSharedAuth(cleanup)?.adoption).toEqual(
      destination.plan.authAdoption,
    );
  });

  it("uses a fully verified adopter as the next source with fresh app passwords", () => {
    const first = fixture();
    const second = pending(first);
    activate(first, second);
    const secondOperator = requireOperator(second.record);
    second.record.status = "prepared";
    second.record.step = "bound";
    secondOperator.authPreparation = readActiveHostedOperatorSharedAuth(second)?.authPreparation;
    secondOperator.receipts = second.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-10-09T02:00:00Z",
      resourceVersion: "verified",
    }));
    secondOperator.gatewayEnvironment = requireOperator(first.record).gatewayEnvironment;
    // A legitimate sibling projection update takes precedence over activation provenance.
    secondOperator.gatewayEnvironment = secondOperator.gatewayEnvironment?.map((item) => ({
      ...item,
      valueSha256: "f".repeat(64),
    }));
    const third = pending(second, "third");
    expect(third.plan.authAdoption?.source.selection.appId).toBe("second");
    expect(third.plan.authAdoption?.gatewayEnvironment?.[0].valueSha256).toBe("f".repeat(64));
    activate(second, third);
    expect(credentials(third).authDatabase).toEqual(credentials(first).authDatabase);
    expect(credentials(third).appDatabase).not.toEqual(credentials(second).appDatabase);
    expect(credentials(third).appDatabase).not.toEqual(credentials(first).appDatabase);
    delete first.record.privateState;
    delete second.record.privateState;
    expect(
      new URL(readHostedOperatorResourceBindings(third).authDatabase.runtimeUrl).password,
    ).toBe(credentials(third).authDatabase.runtimePassword);
  });

  it("rejects readiness, canonical ownership, resource, adoption and owner mismatches", () => {
    const source = fixture();
    const destination = pending(source);
    const invoke = (
      proof = requirePreparation(source.record),
      gateway = requireOperator(source.record).gatewayEnvironment ?? [],
    ) =>
      activateHostedOperatorSharedAuth({
        authPreparation: proof,
        gatewayEnvironment: gateway,
        source,
        target: destination,
      });
    expect(() =>
      invoke({ ...requirePreparation(source.record), catalogFingerprint: "0".repeat(64) }),
    ).toThrow("resource_mismatch");
    expect(() => invoke(requirePreparation(source.record), [])).toThrow();
    expect(() =>
      invoke(
        requirePreparation(source.record),
        (requireOperator(source.record).gatewayEnvironment ?? []).map((item) => ({
          ...item,
          valueSha256: "0".repeat(64),
        })),
      ),
    ).toThrow("resource_mismatch");
    activate(source, destination);
    expect(() =>
      readHostedOperatorResourceBindings({
        ...destination,
        authority: { ...authority, ownerUserId: "foreign" },
      }),
    ).toThrow();
    expect(() =>
      readHostedOperatorResourceBindings({
        ...destination,
        plan: { ...destination.plan, appDatabase: resource("foreign") },
      }),
    ).toThrow("resource_mismatch");
    const withoutAdoption = { ...destination.plan };
    delete withoutAdoption.authAdoption;
    expect(() =>
      readActiveHostedOperatorSharedAuth({ ...destination, plan: withoutAdoption }),
    ).toThrow("resource_mismatch");
    const files = decryptHostedRuntimeFiles(destination);
    if (files === undefined) {
      throw new Error("Missing checkpoint");
    }
    const body = z
      .looseObject({
        verification: z.looseObject({
          authPreparation: z.looseObject({ runtimeRole: z.string() }),
        }),
      })
      .parse(JSON.parse(files["protected-resource-credentials.json"]));
    body.verification.authPreparation.runtimeRole = "foreign_runtime";
    const tampered = encryptHostedRuntimeFiles({
      ...destination,
      files: { "protected-resource-credentials.json": JSON.stringify(body) },
    });
    expect(() =>
      readActiveHostedOperatorSharedAuth({
        ...destination,
        record: { ...destination.record, privateState: tampered },
      }),
    ).toThrow("resource_mismatch");
  });
  it("allows local continuation during an interrupted Gateway PATCH while blocking source planning", () => {
    const source = fixture();
    const destination = pending(source);
    activate(source, destination);
    expect(requirePreparation(source.record).assetSha256).not.toBe(
      source.plan.authSchema?.installer.sha256,
    );
    const sealed = readActiveHostedOperatorSharedAuth(destination)?.gatewayEnvironment;
    const destinationOperator = requireOperator(destination.record);
    destinationOperator.gatewayEnvironment = (
      requireOperator(source.record).gatewayEnvironment ?? []
    ).map((item) => ({
      ...item,
      pendingOperationRef: randomUUID(),
      pendingValueSha256: "0".repeat(64),
    }));
    const bindings = readHostedOperatorResourceBindings(destination);
    expect(readActiveHostedOperatorSharedAuth(destination)?.gatewayEnvironment).toEqual(sealed);
    expect(
      prepareHostedOperatorResourceCredentials({ ...destination, database: "appDatabase" })
        .privateState,
    ).toEqual(destination.record.privateState);
    destination.record.status = "prepared";
    destination.record.step = "bound";
    destinationOperator.authPreparation =
      readActiveHostedOperatorSharedAuth(destination)?.authPreparation;
    destinationOperator.receipts = destination.plan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-10-09T02:00:00Z",
      resourceVersion: "verified",
    }));
    expect(() => describeHostedOperatorSharedAuth(destination)).toThrow("reconciliation_required");
    expect(readHostedOperatorResourceBindings(destination)).toEqual(bindings);
  });

  it("never forwards secret content in malformed checkpoint errors", () => {
    const source = fixture();
    const destination = pending(source);
    const secret = credentials(destination).authDatabase.runtimePassword;
    destination.record.privateState = encryptHostedRuntimeFiles({
      ...destination,
      files: { "protected-resource-credentials.json": `broken-${secret}` },
    });
    try {
      readActiveHostedOperatorSharedAuth(destination);
      throw new Error("Expected rejection");
    } catch (error) {
      expect(String(error)).toContain("reconciliation_required");
      expect(String(error)).not.toContain(secret);
    }
  });
});
