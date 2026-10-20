import { describe, expect, it, vi } from "vitest";
import { normalActorOrganizationProofSchema } from "./hosted-operator-normal-actor-journal";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";
import {
  assertCompletedParticipantBootstrapApproval,
  inspectCompletedParticipantBootstrap,
  inspectPlanningParticipantBootstrap,
  retainCompletedParticipantGateway,
  inspectParticipantBootstrapPreparation,
} from "./hosted-operator-participant-bootstrap";
import {
  createHostedOperatorRealmLinkConfig,
  hostedOperatorRealmLinkConfigSha256,
} from "./hosted-operator-realm-link-config";

const requiredFixture = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing fixture value");
  }
  return value;
};

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

const completedEnrollmentBootstrap = () => {
  const record = completedRecord();
  const accountPlan = hostedOperatorPlanSchema.parse({
    ...desiredPlan(),
    stage: "auth-participants",
    effects: [{ id: "normal-accounts", kind: "normal-accounts", description: "Accounts only" }],
  });
  record.accountPreparation = {
    program: requiredFixture(accountPlan.normalActorProgram),
    programDigest: normalActorProgramDigest(requiredFixture(accountPlan.normalActorProgram)),
    accountOperationRef: "00000000-0000-4000-8000-000000000009",
    accountPlan,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    accountApprovalId: "original-account-approval",
    accountApprovedByCallId: "original-account-call",
    sealedState: {
      encryptedToken: "original-enrollment",
      keyVersion: "original-key",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    captures: [],
    accountsCompletedAt: observedAt,
  };
  return record;
};

const incompleteAppRecord = () => {
  const record = completedEnrollmentBootstrap();
  const operator = requiredFixture(record.operator);
  const preparation = requiredFixture(record.accountPreparation);
  const retainedAuth = requiredFixture(retainedOperatorAuthFromJournal(record));
  const appPlan = hostedOperatorPlanSchema.parse({
    ...operator.plan,
    stage: "app",
    normalActorPreparation: {
      accountOperationRef: preparation.accountOperationRef,
      accountPlanDigest: preparation.accountPlanDigest,
      programDigest: preparation.programDigest,
      accountApprovalId: preparation.accountApprovalId,
      accountApprovedByCallId: preparation.accountApprovedByCallId,
    },
    effects: [
      ...bootstrapPlan().effects,
      { id: "app-install", kind: "install", description: "App schema" },
      { id: "access", kind: "access", description: "Approved app access" },
      { id: "bindings", kind: "bindings", description: "App bindings" },
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway configuration" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
    ],
  });
  return hostedRuntimeJournalRecordSchema.parse({
    ...record,
    approvedByCallId: "app-call",
    retainedAuth,
    operator: {
      ...operator,
      operationRef: "00000000-0000-4000-8000-000000000010",
      approvalId: "app-approval",
      plan: appPlan,
      planDigest: operatorPlanDigest(appPlan),
      receipts: operator.receipts.filter((receipt) =>
        ["auth-resources", "app-resources", "auth-schema"].includes(receipt.effectId),
      ),
    },
  });
};

describe("completed enrollment and Gateway bootstrap handoff", () => {
  it("selects only the independently completed current bootstrap while preserving the original enrollment", () => {
    const record = completedEnrollmentBootstrap();
    const before = structuredClone(record.accountPreparation);
    const selected = inspectCompletedParticipantBootstrap(desiredPlan(), record);
    expect(selected?.auth.operationRef).toBe(operationRef);
    expect(selected?.candidate.origin).toBe("https://gateway.example");
    expect(record.accountPreparation).toEqual(before);
  });
  it.each([
    "live-lease",
    "pending-effect",
    "missing-receipt",
    "missing-auth",
    "unfinished-accounts",
    "wrong-program",
    "wrong-resource",
    "wrong-source",
  ])("does not advance %s", (change) => {
    const record = completedEnrollmentBootstrap();
    if (change === "live-lease") {
      record.leaseId = "00000000-0000-4000-8000-000000000008";
    }
    if (change === "pending-effect") {
      requiredFixture(record.operator).pendingEffectId = "gateway-delivery";
    }
    if (change === "missing-receipt") {
      requiredFixture(record.operator).receipts.pop();
    }
    if (change === "missing-auth") {
      delete requiredFixture(record.operator).authPreparation;
    }
    if (change === "unfinished-accounts") {
      delete requiredFixture(record.accountPreparation).accountsCompletedAt;
    }
    if (change === "wrong-program") {
      requiredFixture(record.accountPreparation).programDigest = "0".repeat(64);
    }
    if (change === "wrong-resource") {
      requiredFixture(record.accountPreparation).accountPlan.authDatabase.resourceId = "different";
    }
    const desired = desiredPlan();
    if (change === "wrong-source") {
      requiredFixture(desired.gatewayDelivery).gitSha = "0".repeat(40);
    }
    expect(inspectCompletedParticipantBootstrap(desired, record)).toBeUndefined();
  });
  it("selects completed retained Auth and enrolled accounts beneath an idle incomplete app plan", () => {
    const record = incompleteAppRecord();
    const before = structuredClone(record);
    const retained = requiredFixture(record.retainedAuth);
    const operator = requiredFixture(record.operator);
    expect(operator.receipts).toHaveLength(3);
    expect(retainedOperatorAuthFromJournal(record)).toBeUndefined();
    for (const desired of [operator.plan, retained.plan]) {
      const selected = inspectCompletedParticipantBootstrap(desired, record);
      expect(selected?.auth).toEqual(retained);
      expect(selected?.candidate.origin).toBe("https://gateway.example");
    }
    expect(record).toEqual(before);
  });

  it("preserves completed Auth provenance across an ordinary app branch change and readiness re-observation", () => {
    const record = incompleteAppRecord();
    const retained = requiredFixture(record.retainedAuth);
    retained.plan.selection.branch = "feature/original-auth";
    requiredFixture(retained.plan.deploymentBoundary).app.branch = "feature/original-auth";
    retained.planDigest = operatorPlanDigest(retained.plan);
    requiredFixture(requiredFixture(record.operator).authPreparation).observedAt =
      "2026-10-15T12:00:00Z";
    expect(
      inspectCompletedParticipantBootstrap(requiredFixture(record.operator).plan, record)?.auth,
    ).toEqual(retained);
  });

  it.each([
    "accountOperationRef",
    "accountPlanDigest",
    "accountApprovalId",
    "accountApprovedByCallId",
    "programDigest",
  ] as const)("rejects an app plan with changed original %s", (field) => {
    const record = incompleteAppRecord();
    const plan = requiredFixture(record.operator).plan;
    requiredFixture(plan.normalActorPreparation)[field] = "unrelated-authority";
    expect(inspectCompletedParticipantBootstrap(plan, record)).toBeUndefined();
  });

  it.each([
    "missing-retained-auth",
    "incomplete-retained-auth",
    "missing-private-state",
    "unfinished-accounts",
    "changed-account-plan",
    "changed-account-program",
    "changed-auth-target",
    "changed-auth-preparation",
    "changed-auth-resource",
    "changed-app-resource",
    "changed-endpoint",
    "changed-selection",
    "cleanup",
    "changed-candidate-operation",
    "changed-candidate-project",
    "changed-candidate-branch",
    "changed-candidate-repository",
    "unready-candidate",
    "pending-binding",
    "pending-effect",
    "pending-attempt",
    "lease",
    "lease-expiry",
  ] as const)("does not borrow completed Auth for app planning with %s", (change) => {
    const record = incompleteAppRecord();
    const operator = requiredFixture(record.operator);
    const preparation = requiredFixture(record.accountPreparation);
    const retained = requiredFixture(record.retainedAuth);
    const desired = structuredClone(operator.plan);
    const candidate = requiredFixture(operator.gatewayDeliveryCandidates)[0];
    const mutations = {
      "missing-retained-auth": () => {
        delete record.retainedAuth;
      },
      "incomplete-retained-auth": () => {
        retained.receipts.pop();
      },
      "missing-private-state": () => {
        delete record.privateState;
      },
      "unfinished-accounts": () => {
        delete preparation.accountsCompletedAt;
      },
      "changed-account-plan": () => {
        preparation.accountPlan.contextId = "unapproved-account-plan";
      },
      "changed-account-program": () => {
        preparation.program.actors[0].name = "Different account";
      },
      "changed-auth-target": () => {
        requiredFixture(operator.plan.authSchema).targetDigest = "0".repeat(64);
      },
      "changed-auth-preparation": () => {
        requiredFixture(operator.authPreparation).catalogFingerprint = "0".repeat(64);
      },
      "changed-auth-resource": () => {
        operator.plan.authDatabase.resourceId = "other-auth";
      },
      "changed-app-resource": () => {
        operator.plan.appDatabase.resourceId = "other-app";
      },
      "changed-endpoint": () => {
        operator.plan.neon.endpoint = "other.neon.tech";
      },
      "changed-selection": () => {
        operator.plan.selection.sessionId = "other-session";
      },
      cleanup: () => {
        operator.plan.action = "cleanup";
      },
      "changed-candidate-operation": () => {
        candidate.operationRef = "00000000-0000-4000-8000-000000000011";
      },
      "changed-candidate-project": () => {
        candidate.projectId = "other-gateway";
      },
      "changed-candidate-branch": () => {
        candidate.branch = "other-branch";
      },
      "changed-candidate-repository": () => {
        candidate.repoId = "other-repository";
      },
      "unready-candidate": () => {
        candidate.readyState = "BUILDING";
      },
      "pending-binding": () => {
        requiredFixture(operator.gatewayEnvironment)[0].pendingOperationRef = operationRef;
      },
      "pending-effect": () => {
        operator.pendingEffectId = "app-install";
      },
      "pending-attempt": () => {
        operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000012" };
      },
      lease: () => {
        record.leaseId = "00000000-0000-4000-8000-000000000013";
      },
      "lease-expiry": () => {
        record.leaseExpiresAt = "2027-01-01T00:00:00Z";
      },
    } satisfies Record<string, () => void>;
    mutations[change]();
    const before = structuredClone(record);
    expect(inspectCompletedParticipantBootstrap(desired, record)).toBeUndefined();
    expect(record).toEqual(before);
  });

  it("rechecks the actual current bootstrap approval separately", async () => {
    const selected = requiredFixture(
      inspectCompletedParticipantBootstrap(desiredPlan(), completedEnrollmentBootstrap()),
    );
    await expect(
      assertCompletedParticipantBootstrapApproval(context, selected, () =>
        Promise.resolve({
          approved: false,
          approvalId: selected.auth.approvalId,
          callId: selected.auth.approvedByCallId,
          planDigest: selected.auth.planDigest,
          action: "prepare",
        }),
      ),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });
});

const settledAppBootstrap = () => {
  const record = incompleteAppRecord();
  const operator = requiredFixture(record.operator);
  const currentPlan = structuredClone(operator.plan);
  requiredFixture(currentPlan.gatewayDelivery).gitSha = "d".repeat(40);
  operator.plan = currentPlan;
  operator.planDigest = operatorPlanDigest(currentPlan);
  operator.receipts = currentPlan.effects.map((effect) => ({
    effectId: effect.id,
    observedAt,
    resourceVersion: "completed-app-readback",
  }));
  const candidate = requiredFixture(requiredFixture(operator.gatewayDeliveryCandidates)[0]);
  candidate.operationRef = operator.operationRef;
  candidate.deploymentId = "completed-app-gateway";
  operator.deliveredGatewayDeploymentId = candidate.deploymentId;
  requiredFixture(operator.gatewayEnvironment)[0].valueSha256 =
    hostedOperatorRealmLinkConfigSha256(currentPlan);
  record.status = "prepared";
  record.step = "bound";
  record.environmentBound = true;
  record.proof = {
    actors: 1,
    tenants: 1,
    authenticatedBehavior: "unassessed",
    artifactHash: "a".repeat(64),
    manifestSha256: currentPlan.release.sha256,
    releaseId: currentPlan.release.id,
  };
  return record;
};

describe("settled app bootstrap planning handoff", () => {
  it("keeps original Auth authority while selecting the independently completed current app Gateway", () => {
    const record = settledAppBootstrap();
    const operator = requiredFixture(record.operator);
    const originalAuth = requiredFixture(record.retainedAuth);
    const before = structuredClone(record);
    expect(originalAuth.plan.gatewayDelivery?.gitSha).not.toBe(
      operator.plan.gatewayDelivery?.gitSha,
    );
    const selected = requiredFixture(inspectPlanningParticipantBootstrap(operator.plan, record));
    expect(selected.auth).toEqual(originalAuth);
    expect(selected.gateway?.operationRef).toBe(operator.operationRef);
    expect(selected.gateway?.approvalId).toBe(operator.approvalId);
    expect(selected.gateway?.plan.gatewayDelivery?.gitSha).toBe(
      operator.plan.gatewayDelivery?.gitSha,
    );
    expect(selected.candidate.deploymentId).toBe(operator.deliveredGatewayDeploymentId);
    expect(inspectCompletedParticipantBootstrap(operator.plan, record)).toBeUndefined();
    expect(record).toEqual(before);
  });

  it("round-trips both independent approvals through the private organization proof bootstrap codec", () => {
    const record = settledAppBootstrap();
    const selected = requiredFixture(
      inspectPlanningParticipantBootstrap(requiredFixture(record.operator).plan, record),
    );
    const serialized = JSON.stringify(selected);
    const restored = normalActorOrganizationProofSchema.shape.bootstrap.parse(
      JSON.parse(serialized),
    );
    expect(restored?.auth.approvalId).toBe(record.retainedAuth?.approvalId);
    expect(restored?.gateway?.approvalId).toBe(record.operator?.approvalId);
    expect(restored?.candidate.deploymentId).toBe(record.operator?.deliveredGatewayDeploymentId);
  });

  it("retains both exact snapshots across a new reservation and serialization/replay", () => {
    let record = settledAppBootstrap();
    const current = requiredFixture(record.operator);
    const desired = structuredClone(current.plan);
    const first = requiredFixture(inspectPlanningParticipantBootstrap(desired, record));
    record = retainCompletedParticipantGateway(record);
    record.status = "pending";
    record.step = "reserved";
    record.environmentBound = false;
    delete record.proof;
    current.operationRef = "00000000-0000-4000-8000-000000000014";
    current.plan = { ...desired, contextId: "next-reviewed-spec" };
    current.planDigest = operatorPlanDigest(current.plan);
    current.receipts = [];
    delete current.approvalId;
    const serialized = JSON.stringify(record);
    const replay = hostedRuntimeJournalRecordSchema.parse(JSON.parse(serialized));
    expect(inspectPlanningParticipantBootstrap(desired, replay)).toEqual(first);
    expect(replay.retainedAuth?.operationRef).toBe(first.auth.operationRef);
    expect(replay.retainedParticipantGateway?.completion.operationRef).toBe(
      first.gateway?.operationRef,
    );
  });

  it.each([
    "unbound",
    "proof-release",
    "proof-manifest",
    "pending-effect",
    "pending-attempt",
  ] as const)(
    "does not mask an invalid current prepared %s using valid retained Gateway evidence",
    (changed) => {
      let record = settledAppBootstrap();
      record = retainCompletedParticipantGateway(record);
      expect(record.retainedParticipantGateway).toBeDefined();
      const operator = requiredFixture(record.operator);
      const desired = structuredClone(operator.plan);
      if (changed === "unbound") {
        record.environmentBound = false;
      }
      if (changed === "proof-release") {
        requiredFixture(record.proof).releaseId = "another-release";
      }
      if (changed === "proof-manifest") {
        requiredFixture(record.proof).manifestSha256 = "0".repeat(64);
      }
      if (changed === "pending-effect") {
        operator.pendingEffectId = "gateway-delivery";
      }
      if (changed === "pending-attempt") {
        operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000015" };
      }
      expect(inspectPlanningParticipantBootstrap(desired, record)).toBeUndefined();
    },
  );

  it.each(["original-auth", "completed-app"])(
    "requires the separate %s approval",
    async (rejected) => {
      const record = settledAppBootstrap();
      const selected = requiredFixture(
        inspectPlanningParticipantBootstrap(requiredFixture(record.operator).plan, record),
      );
      const gateway = requiredFixture(selected.gateway);
      const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
        async (input) => {
          await Promise.resolve();
          const completionAuthority =
            input.planDigest === selected.auth.planDigest ? selected.auth : gateway;
          return {
            approved: !(rejected === "original-auth"
              ? completionAuthority === selected.auth
              : completionAuthority === gateway),
            approvalId: completionAuthority.approvalId,
            callId: input.callId,
            planDigest: input.planDigest,
            action: "prepare",
          };
        },
      );
      await expect(
        assertCompletedParticipantBootstrapApproval(context, selected, readApproval),
      ).rejects.toMatchObject({ code: "authorization_required" });
    },
  );

  it("checks both approvals under their original call and plan bindings", async () => {
    const record = settledAppBootstrap();
    const selected = requiredFixture(
      inspectPlanningParticipantBootstrap(requiredFixture(record.operator).plan, record),
    );
    const gateway = requiredFixture(selected.gateway);
    const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
      async (input) => {
        await Promise.resolve();
        const completionAuthority =
          input.planDigest === selected.auth.planDigest ? selected.auth : gateway;
        return {
          approved: true,
          approvalId: completionAuthority.approvalId,
          callId: input.callId,
          planDigest: input.planDigest,
          action: "prepare",
        };
      },
    );
    await assertCompletedParticipantBootstrapApproval(context, selected, readApproval);
    for (const completionAuthority of [selected.auth, gateway]) {
      expect(readApproval).toHaveBeenCalledWith(
        expect.objectContaining({
          callId: completionAuthority.approvedByCallId,
          planDigest: completionAuthority.planDigest,
          authority: context.authority,
        }),
      );
    }
  });

  it.each([
    "desired-source",
    "desired-realm",
    "unbound",
    "proof-release",
    "proof-manifest",
    "missing-receipt",
    "candidate-operation",
    "candidate-project",
    "candidate-repository",
    "candidate-branch",
    "candidate-unready",
    "pending-binding",
    "pending-effect",
    "lease",
    "private-state",
    "account-authority",
  ] as const)("rejects settled handoff with %s", (changed) => {
    const record = settledAppBootstrap();
    const operator = requiredFixture(record.operator);
    const desired = structuredClone(operator.plan);
    const candidate = requiredFixture(requiredFixture(operator.gatewayDeliveryCandidates)[0]);
    const mutations = {
      "desired-source": () => {
        requiredFixture(desired.gatewayDelivery).gitSha = "0".repeat(40);
      },
      "desired-realm": () => {
        requiredFixture(desired.gatewayBindings).operatorOrigin =
          "https://another-operator.example";
      },
      unbound: () => {
        record.environmentBound = false;
      },
      "proof-release": () => {
        requiredFixture(record.proof).releaseId = "another-release";
      },
      "proof-manifest": () => {
        requiredFixture(record.proof).manifestSha256 = "0".repeat(64);
      },
      "missing-receipt": () => {
        operator.receipts.pop();
      },
      "candidate-operation": () => {
        candidate.operationRef = operationRef;
      },
      "candidate-project": () => {
        candidate.projectId = "other-project";
      },
      "candidate-repository": () => {
        candidate.repoId = "other-repository";
      },
      "candidate-branch": () => {
        candidate.branch = "other-branch";
      },
      "candidate-unready": () => {
        candidate.readyState = "BUILDING";
      },
      "pending-binding": () => {
        requiredFixture(operator.gatewayEnvironment)[0].pendingOperationRef = operationRef;
      },
      "pending-effect": () => {
        operator.pendingEffectId = "gateway-delivery";
      },
      lease: () => {
        record.leaseId = "00000000-0000-4000-8000-000000000013";
      },
      "private-state": () => {
        delete record.privateState;
      },
      "account-authority": () => {
        requiredFixture(operator.plan.normalActorPreparation).accountApprovalId =
          "foreign-approval";
      },
    };
    mutations[changed]();
    expect(inspectPlanningParticipantBootstrap(desired, record)).toBeUndefined();
  });
});
