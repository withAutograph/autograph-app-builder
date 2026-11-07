import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  retainedOperatorAuthSchema,
} from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import { decryptHostedRuntimeFiles } from "./hosted-runtime-service";
import {
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
  rewrapOwnedAppResourceCredentials,
} from "./hosted-operator-resource-credentials";
import { ownedAppResourceSourceSchema } from "./owned-app-resource-source-contract";
import { plan as basePlan, authority } from "./public-release-test-fixture";
import type { ResourceCredentialInput } from "./hosted-operator-resource-credentials";

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const hash = (value: ResourceCredentialInput["record"]["privateState"]) =>
  createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fixture = () => {
  const sourcePlan = hostedOperatorPlanSchema.parse({
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
    deploymentBoundary: {
      app: { branch: "preview", environment: "preview", projectId: basePlan.project.projectId },
      authority,
      composition: "single-project-services",
      gateway: { branch: "preview", environment: "preview", projectId: basePlan.project.projectId },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator-infrastructure",
      },
      teamId: basePlan.project.teamId,
      verification: {
        gatewayOrigin: basePlan.publicOrigin,
        jwksUrl: `${basePlan.publicOrigin}/_platform/jwks.json`,
        publicOrigin: basePlan.publicOrigin,
      },
    },
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
      origin: basePlan.publicOrigin,
      projectId: basePlan.project.projectId,
    },
    release: { artifactRef: "source-release", id: "release", sha256: "f".repeat(64) },
    resourcesInstaller: { reference: "resource-worker", sha256: "e".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    runtimePreparation: "single-project-resources-v1",
    selection: {
      appId: basePlan.selection.appId,
      branch: "preview",
      environment: "preview",
      projectId: basePlan.project.projectId,
      sessionId: basePlan.selection.sessionId,
    },
    stage: "auth-bootstrap",
    version: 1,
  });
  const retained = retainedOperatorAuthSchema.parse({
    approvalId: "source-approval",
    approvedByCallId: "source-call",
    authPreparation: {
      assetSha256: "9".repeat(64),
      catalogFingerprint: "b".repeat(64),
      database: "auth",
      observedAt: "2026-11-03T00:00:00Z",
      runtimeRole: "auth_runtime",
      targetDigest: sourcePlan.authSchema?.targetDigest,
    },
    operationRef: basePlan.runtime.operationRef,
    plan: sourcePlan,
    planDigest: operatorPlanDigest(sourcePlan),
    receipts: sourcePlan.effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-11-03T00:00:00Z",
      resourceVersion: "observed",
    })),
  });
  const config = { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture" };
  const target = {
    ...sourcePlan.selection,
    installationId: "installation",
    scopeId: basePlan.project.teamId,
    scopeType: "team" as const,
  };
  const record = hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: retained.approvedByCallId,
    kind: "app-runtime",
    operator: {
      approvalId: retained.approvalId,
      authPreparation: retained.authPreparation,
      mode: "protected-operator-v1",
      operationRef: retained.operationRef,
      plan: sourcePlan,
      planDigest: retained.planDigest,
      receipts: retained.receipts,
    },
    request: target,
    retainedAuth: retained,
    status: "pending",
    step: "reserved",
    version: 1,
  });
  const source: ResourceCredentialInput = { authority, config, plan: sourcePlan, record, target };
  record.privateState = prepareHostedOperatorResourceCredentials({
    ...source,
    database: "authDatabase",
  }).privateState;
  const nextTarget = { ...target, sessionId: "new-revision-session" };
  const reference = ownedAppResourceSourceSchema.parse({
    kind: "owned-app-resources-v1",
    scopeDigest: "a".repeat(64),
    source: {
      checkpointSha256: hash(record.privateState),
      operationRef: retained.operationRef,
      planDigest: retained.planDigest,
      target,
    },
  });
  const nextPlan = hostedOperatorPlanSchema.parse({
    ...sourcePlan,
    existingResources: reference,
    selection: { ...sourcePlan.selection, sessionId: nextTarget.sessionId },
  });
  const nextRecord = hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "new-current-approval",
    kind: "app-runtime",
    request: nextTarget,
    status: "pending",
    step: "reserved",
    version: 1,
  });
  const targetInput: ResourceCredentialInput = {
    authority,
    config,
    plan: nextPlan,
    record: nextRecord,
    target: nextTarget,
  };
  return { source, target: targetInput };
};
it("rewraps all four original owned credentials into fresh revision AAD without changing either database pair", () => {
  const { source, target } = fixture();
  const original = structuredClone(source.record);
  const sealed = rewrapOwnedAppResourceCredentials({ source, target });
  expect(sealed).not.toEqual(source.record.privateState);
  target.record.privateState = sealed;
  expect(readHostedOperatorResourceBindings(target)).toEqual(
    readHostedOperatorResourceBindings(source),
  );
  expect(source.record).toEqual(original);
  expect(() => decryptHostedRuntimeFiles({ ...source, record: target.record })).toThrow();
  expect(rewrapOwnedAppResourceCredentials({ source, target })).toEqual(sealed);
});
it("refuses a pre-existing target credential pair instead of silently rotating either resource", () => {
  const { source, target } = fixture();
  target.record.privateState = prepareHostedOperatorResourceCredentials({
    ...target,
    database: "appDatabase",
  }).privateState;
  expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow("resource_mismatch");
});
it.each(["ownerUserId", "workspaceId", "issuer", "audience"] as const)(
  "refuses different source authority %s",
  (key) => {
    const { source, target } = fixture();
    source.authority = { ...source.authority, [key]: `${source.authority[key]}-other` };
    expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow(
      "resource_mismatch",
    );
  },
);
it.each(["projectId", "installationId", "scopeId"] as const)(
  "refuses a different current target %s",
  (key) => {
    const { source, target } = fixture();
    target.target = { ...target.target, [key]: "foreign" };
    expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow(
      "resource_mismatch",
    );
  },
);
it.each(["appDatabase", "authDatabase"] as const)(
  "refuses a changed %s physical role/database identity",
  (database) => {
    const { source, target } = fixture();
    target.plan = {
      ...target.plan,
      [database]: { ...target.plan[database], runtimeRole: "other_runtime" },
    };
    expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow(
      "resource_mismatch",
    );
  },
);
it("refuses an altered original sealed checkpoint before returning new ciphertext", () => {
  const { source, target } = fixture();
  source.record.privateState = prepareHostedOperatorResourceCredentials({
    ...source,
    database: "authDatabase",
    record: { ...source.record, privateState: undefined },
  }).privateState;
  expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow("resource_mismatch");
});
it("refuses a changed original source plan digest", () => {
  const { source, target } = fixture();
  source.plan = { ...source.plan, release: { ...source.plan.release, id: "different-release" } };
  expect(() => rewrapOwnedAppResourceCredentials({ source, target })).toThrow("resource_mismatch");
});
