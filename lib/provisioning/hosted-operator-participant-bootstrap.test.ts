import { describe, expect, it } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import { normalActorProgramSchema } from "./hosted-operator-normal-actor-program";
import { inspectParticipantBootstrapPreparation } from "./hosted-operator-participant-bootstrap";
import {
  createHostedOperatorRealmLinkConfig,
  hostedOperatorRealmLinkConfigSha256,
} from "./hosted-operator-realm-link-config";

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

const operationRef = "00000000-0000-4000-8000-000000000001";
const observedAt = "2026-10-14T12:00:00Z";
const sourceWorkload = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  environment: "preview" as const,
  subject: "builder-workload",
};
const desiredPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...bootstrapPlan(),
    normalActorProgram: normalActorProgramSchema.parse({
      version: 1,
      appId: context.target.appId,
      origin: "https://apps.example",
      actors: [
        {
          actorKey: "owner",
          email: "owner@example.test",
          name: "Owner",
          account: "create-email-password",
        },
      ],
      organizations: [],
      memberships: [],
      appAccess: [],
    }),
    publicGateway: {
      projectId: "gateway",
      branch: context.target.branch,
      origin: "https://apps.example",
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
        branch: context.target.branch,
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
    gatewayBindings: {
      authBrowserOrigin: "https://apps.example",
      builderCallbackOrigin: "https://builder.example",
      operatorOrigin: "https://operator.example",
      catalogAppIds: [context.target.appId],
      sourceWorkload,
    },
    gatewayDelivery: {
      projectId: "gateway",
      branch: context.target.branch,
      repoId: "gateway-repo",
      gitSha: "c".repeat(40),
    },
    effects: [
      ...bootstrapPlan().effects,
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway configuration" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
    ],
  });
const completedRecord = (plan: HostedOperatorPlan = desiredPlan()) =>
  hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "ordinary-public-approval",
    request: context.target,
    status: "pending",
    step: "reserved",
    privateState: {
      encryptedToken: "private-ciphertext",
      keyVersion: "key-version",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    operator: {
      mode: "protected-operator-v1",
      approvalId: "actual-approval",
      operationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      authPreparation: {
        assetSha256: "d".repeat(64),
        catalogFingerprint: "e".repeat(64),
        database: plan.authDatabase.database,
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: plan.authSchema?.targetDigest,
        observedAt,
      },
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt,
        resourceVersion: "actual-readback",
      })),
      gatewayEnvironment: [
        {
          key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
          id: "owned-environment-row",
          projectId: "gateway",
          branch: context.target.branch,
          operationRef,
          comment: `App Builder protected operator ${operationRef}`,
          valueSha256: hostedOperatorRealmLinkConfigSha256(plan),
        },
      ],
      gatewayDeliveryCandidates: [
        {
          projectId: "gateway",
          branch: context.target.branch,
          repoId: "gateway-repo",
          operationRef,
          origin: "https://gateway.example",
          deploymentId: "gateway-delivery",
          readyState: "READY",
        },
      ],
      deliveredGatewayDeploymentId: "gateway-delivery",
    },
  });

describe("participant bootstrap planning evidence", () => {
  it("requires a completed capture configuration rather than any READY Gateway", () => {
    const desired = desiredPlan();
    const legacy = hostedOperatorPlanSchema.parse({ ...desired, normalActorProgram: undefined });
    const record = completedRecord(legacy);
    const result = inspectParticipantBootstrapPreparation(desired, record);
    expect(result.auth).toBeDefined();
    expect(result.gatewayPrepared).toBe(false);
    expect(inspectParticipantBootstrapPreparation(desired, completedRecord()).gatewayPrepared).toBe(
      true,
    );
  });
  it("uses completed Auth provenance after the accounts-only phase replaces the current receipts", () => {
    const desired = desiredPlan();
    const record = completedRecord();
    record.retainedAuth = retainedOperatorAuthFromJournal(record);
    const accounts = hostedOperatorPlanSchema.parse({
      ...desired,
      stage: "auth-participants",
      effects: [{ id: "normal-accounts", kind: "normal-accounts", description: "Normal accounts" }],
    });
    if (record.operator === undefined) {
      throw new Error("fixture operator missing");
    }
    record.operator.plan = accounts;
    record.operator.planDigest = operatorPlanDigest(accounts);
    record.operator.operationRef = "00000000-0000-4000-8000-000000000002";
    record.operator.receipts = [
      { effectId: "normal-accounts", observedAt, resourceVersion: "accounts-readback" },
    ];
    record.status = "participants-prepared";
    const before = structuredClone(record);
    expect(inspectParticipantBootstrapPreparation(desired, record).gatewayPrepared).toBe(true);
    expect(record).toEqual(before);
    record.retainedAuth = undefined;
    expect(inspectParticipantBootstrapPreparation(desired, record).gatewayPrepared).toBe(false);
  });
  it("does not reuse a retained hash when the current Gateway row has an unfinished update", () => {
    const desired = desiredPlan();
    const record = completedRecord();
    record.retainedAuth = retainedOperatorAuthFromJournal(record);
    const row = record.operator?.gatewayEnvironment?.[0];
    if (row === undefined) {
      throw new Error("fixture row missing");
    }
    row.pendingOperationRef = "00000000-0000-4000-8000-000000000002";
    row.pendingValueSha256 = "a".repeat(64);
    expect(inspectParticipantBootstrapPreparation(desired, record).auth).toBeDefined();
    expect(inspectParticipantBootstrapPreparation(desired, record).gatewayPrepared).toBe(false);
  });
  it("accepts a newer completed deployment that updates a row owned by its original operation", () => {
    const desired = desiredPlan();
    const record = completedRecord();
    const { operator } = record;
    const candidate = operator?.gatewayDeliveryCandidates?.[0];
    if (operator === undefined || candidate === undefined) {
      throw new Error("fixture operator missing");
    }
    const newOperation = "00000000-0000-4000-8000-000000000004";
    operator.operationRef = newOperation;
    candidate.operationRef = newOperation;
    const observed = hostedRuntimeJournalRecordSchema.parse(record);
    expect(observed.operator?.gatewayEnvironment?.[0].operationRef).toBe(operationRef);
    expect(inspectParticipantBootstrapPreparation(desired, observed).gatewayPrepared).toBe(true);
  });
  it.each(["changed-owner", "changed-id", "missing-known-row"])(
    "requires the current row to match its completed observed provenance: %s",
    (change) => {
      const desired = desiredPlan();
      const record = completedRecord();
      const { operator } = record;
      const row = operator?.gatewayEnvironment?.[0];
      if (operator === undefined || row === undefined) {
        throw new Error("fixture row missing");
      }
      record.retainedAuth = retainedOperatorAuthFromJournal(record);
      operator.plan = hostedOperatorPlanSchema.parse({
        ...desired,
        stage: "auth-participants",
        effects: [
          { id: "normal-accounts", kind: "normal-accounts", description: "Normal accounts" },
        ],
      });
      operator.planDigest = operatorPlanDigest(operator.plan);
      operator.operationRef = "00000000-0000-4000-8000-000000000002";
      operator.receipts = [
        { effectId: "normal-accounts", observedAt, resourceVersion: "accounts-readback" },
      ];
      record.status = "participants-prepared";
      if (change === "changed-owner") {
        row.operationRef = "00000000-0000-4000-8000-000000000003";
        row.comment = `App Builder protected operator ${row.operationRef}`;
      }
      if (change === "changed-id") {
        row.id = "another-owned-row";
      }
      if (change === "missing-known-row") {
        const retained = record.retainedAuth;
        if (retained === undefined) {
          throw new Error("fixture retained Auth missing");
        }
        retained.gatewayEnvironment = [];
      }
      expect(
        inspectParticipantBootstrapPreparation(
          desired,
          hostedRuntimeJournalRecordSchema.parse(record),
        ).gatewayPrepared,
      ).toBe(false);
    },
  );
  it("makes participant contents irrelevant to the capture configuration", () => {
    const desired = desiredPlan();
    const changed = hostedOperatorPlanSchema.parse({
      ...desired,
      normalActorProgram: {
        ...desired.normalActorProgram,
        actors: [
          {
            actorKey: "second",
            email: "second@example.test",
            name: "Second",
            account: "create-email-password",
          },
        ],
      },
    });
    expect(operatorPlanDigest(changed)).not.toBe(operatorPlanDigest(desired));
    expect(hostedOperatorRealmLinkConfigSha256(changed)).toBe(
      hostedOperatorRealmLinkConfigSha256(desired),
    );
    expect(inspectParticipantBootstrapPreparation(changed, completedRecord()).gatewayPrepared).toBe(
      true,
    );
  });
  it("plans a new Gateway delivery when the approved source changes", () => {
    const desired = desiredPlan();
    const changed = hostedOperatorPlanSchema.parse({
      ...desired,
      gatewayDelivery: { ...desired.gatewayDelivery, gitSha: "a".repeat(40) },
    });
    expect(inspectParticipantBootstrapPreparation(changed, completedRecord()).gatewayPrepared).toBe(
      false,
    );
  });
  it.each(["missing-hash", "pending-write", "wrong-operation", "wrong-project", "wrong-branch"])(
    "requires the exact recorded environment value: %s",
    (change) => {
      const record = completedRecord();
      const row = record.operator?.gatewayEnvironment?.[0];
      if (row === undefined) {
        throw new Error("fixture row missing");
      }
      if (change === "missing-hash") {
        row.valueSha256 = undefined;
      }
      if (change === "pending-write") {
        row.pendingOperationRef = operationRef;
        row.pendingValueSha256 = "a".repeat(64);
      }
      if (change === "wrong-operation") {
        row.operationRef = "00000000-0000-4000-8000-000000000003";
      }
      if (change === "wrong-project") {
        row.projectId = "another-project";
      }
      if (change === "wrong-branch") {
        row.branch = "another-branch";
      }
      expect(inspectParticipantBootstrapPreparation(desiredPlan(), record).gatewayPrepared).toBe(
        false,
      );
    },
  );
  it.each([
    "wrong-operation",
    "not-ready",
    "missing-receipt",
    "missing-auth",
    "different-auth-target",
  ])("requires completed physical Auth and the approved delivery: %s", (change) => {
    const record = completedRecord();
    const { operator } = record;
    const candidate = operator?.gatewayDeliveryCandidates?.[0];
    if (operator === undefined || candidate === undefined) {
      throw new Error("fixture operator missing");
    }
    if (change === "wrong-operation") {
      candidate.operationRef = "00000000-0000-4000-8000-000000000003";
    }
    if (change === "not-ready") {
      candidate.readyState = "BUILDING";
    }
    if (change === "missing-receipt") {
      operator.receipts = operator.receipts.filter(
        (receipt) => receipt.effectId !== "gateway-delivery",
      );
    }
    if (change === "missing-auth") {
      operator.authPreparation = undefined;
    }
    if (change === "different-auth-target") {
      const readiness = operator.authPreparation;
      if (readiness === undefined) {
        throw new Error("fixture auth missing");
      }
      operator.authPreparation = { ...readiness, targetDigest: "a".repeat(64) };
    }
    expect(inspectParticipantBootstrapPreparation(desiredPlan(), record).gatewayPrepared).toBe(
      false,
    );
  });
});

describe("Realm link configuration codec", () => {
  it("preserves link destinations and binds the sender for owner and participant handoffs", () => {
    const desired = desiredPlan();
    const ownerPlan = { ...desired, normalActorProgram: undefined };
    const owner = createHostedOperatorRealmLinkConfig(ownerPlan);
    const participant = createHostedOperatorRealmLinkConfig(desired);
    for (const configuration of [owner, participant]) {
      expect(configuration).toMatchObject({
        browserOrigin: "https://apps.example",
        builderCallbackOrigin: "https://builder.example",
        builderCallbackPath: "/api/hosted-operator/realm-identity",
        operatorOrigin: "https://operator.example",
      });
      expect(configuration.identityHandoff.sender).toEqual(sourceWorkload);
    }
    expect(owner.browserSessionCapture).toBeUndefined();
    expect(participant.browserSessionCapture).toMatchObject({
      path: "/api/hosted-operator/realm-browser-session",
    });
    expect(participant.browserSessionCapture?.sender).toEqual(sourceWorkload);
    expect(hostedOperatorRealmLinkConfigSha256(ownerPlan)).not.toBe(
      hostedOperatorRealmLinkConfigSha256(desired),
    );
  });
  it("binds the desired sender and rejects unsafe origins", () => {
    const desired = desiredPlan();
    const { gatewayBindings: bindings } = desired;
    if (bindings === undefined) {
      throw new Error("fixture bindings missing");
    }
    expect(
      hostedOperatorRealmLinkConfigSha256({
        ...desired,
        gatewayBindings: {
          ...bindings,
          sourceWorkload: { ...sourceWorkload, projectId: "other-builder" },
        },
      }),
    ).not.toBe(hostedOperatorRealmLinkConfigSha256(desired));
    expect(() =>
      createHostedOperatorRealmLinkConfig({
        ...desired,
        gatewayBindings: { ...bindings, builderCallbackOrigin: "https://builder.example/callback" },
      }),
    ).toThrow();
  });
});
