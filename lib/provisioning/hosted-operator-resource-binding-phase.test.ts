import { encryptHostedRuntimeFiles } from "./hosted-runtime-service";
import { describe, expect, it } from "vitest";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedOperatorContext } from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import {
  normalActorProgramSchema,
  normalActorProgramDigest,
} from "./hosted-operator-normal-actor-program";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import { createAppInstallationPlanningResourceReader } from "./hosted-operator-installation-planning-resources";
import {
  requireFinalResourceBindingPhase,
  selectAuthPlanningResourceBindingRow,
} from "./hosted-operator-resource-binding-phase";

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

const phaseFixture = (participants = false) => {
  const record = completedRecord();
  const { operator } = record;
  if (operator === undefined) {
    throw new Error("fixture operator missing");
  }
  operator.fenceGeneration = 1;
  if (participants) {
    operator.plan = hostedOperatorPlanSchema.parse({
      ...operator.plan,
      stage: "auth-participants",
      effects: [{ id: "normal-accounts", kind: "normal-accounts", description: "Normal accounts" }],
    });
    operator.planDigest = operatorPlanDigest(operator.plan);
    operator.receipts = [
      { effectId: "normal-accounts", observedAt, resourceVersion: "actual-accounts" },
    ];
    record.status = "participants-prepared";
  }
  const row = { record: hostedRuntimeJournalRecordSchema.parse(record), revision: 2 };
  return { row, input: { plan: operator.plan, privateState: record.privateState } };
};

describe("read-only completed resource binding phase", () => {
  const encryptedPhaseFixture = (participants = false) => {
    const f = phaseFixture(participants);
    const raw = encryptHostedRuntimeFiles({
      authority,
      target: context.target,
      files: { "synthetic.json": "synthetic-only" },
      config: { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "synthetic_v1" },
    });
    f.row.record = hostedRuntimeJournalRecordSchema.parse({ ...f.row.record, privateState: raw });
    f.input.privateState = raw;
    return { ...f, raw };
  };
  it.each([false, true])(
    "accepts unchanged actual encryption output across the journal parser, participants=%s",
    (participants) => {
      const f = encryptedPhaseFixture(participants);
      expect(Object.keys(f.raw)).not.toEqual(Object.keys(f.row.record.privateState ?? {}));
      expect(f.raw).toEqual(f.row.record.privateState);
      expect(requireFinalResourceBindingPhase(f.row, f.input)).toBe(f.row);
    },
  );
  it.each(["encryptedToken", "tokenIv", "tokenTag", "keyVersion"] as const)(
    "rejects a changed encrypted envelope %s",
    (field) => {
      const f = encryptedPhaseFixture();
      f.raw[field] += "-changed";
      expect(() => requireFinalResourceBindingPhase(f.row, f.input)).toThrow(
        "operation_in_progress",
      );
    },
  );
  it.each(["encryptedToken", "tokenIv", "tokenTag", "keyVersion"] as const)(
    "rejects a missing encrypted envelope %s",
    (field) => {
      const f = encryptedPhaseFixture();
      Reflect.deleteProperty(f.raw, field);
      expect(
        hostedRuntimeJournalRecordSchema.safeParse({ ...f.row.record, privateState: f.raw })
          .success,
      ).toBe(false);
      expect(() => requireFinalResourceBindingPhase(f.row, f.input)).toThrow(
        "operation_in_progress",
      );
    },
  );

  it.each([false, true])(
    "opens only completed idle Auth phase, participants=%s",
    (participants) => {
      const f = phaseFixture(participants);
      expect(requireFinalResourceBindingPhase(f.row, f.input)).toBe(f.row);
    },
  );
  it.each([
    "approval",
    "fence",
    "pending-effect",
    "pending-attempt",
    "missing-receipt",
    "missing-private-state",
    "different-private-state",
    "different-input-plan",
    "different-stored-digest",
    "lease",
    "expired-lease",
    "wrong-step",
    "missing-readiness",
  ])("rejects incomplete or changed bootstrap boundary: %s", (change) => {
    const f = phaseFixture();
    const { operator } = f.row.record;
    if (operator === undefined) {
      throw new Error("fixture operator missing");
    }
    if (change === "approval") {
      operator.approvalId = undefined;
    }
    if (change === "fence") {
      operator.fenceGeneration = undefined;
    }
    if (change === "pending-effect") {
      operator.pendingEffectId = "gateway-bindings";
    }
    if (change === "pending-attempt") {
      operator.pendingEffectAttempt = {
        id: "00000000-0000-4000-8000-000000000010",
      };
    }
    if (change === "missing-receipt") {
      operator.receipts = operator.receipts.slice(1);
    }
    if (change === "missing-private-state") {
      f.row.record.privateState = undefined;
      f.input.privateState = undefined;
    }
    if (change === "different-private-state") {
      f.input.privateState = {
        encryptedToken: "different",
        keyVersion: "version",
        tokenIv: "iv",
        tokenTag: "tag",
      };
    }
    if (change === "different-input-plan") {
      f.input.plan = { ...f.input.plan, contextId: "another-selection" };
    }
    if (change === "different-stored-digest") {
      operator.planDigest = "a".repeat(64);
    }
    if (change === "lease") {
      f.row.record.leaseId = "00000000-0000-4000-8000-000000000011";
    }
    if (change === "expired-lease") {
      f.row.record.leaseId = "00000000-0000-4000-8000-000000000011";
      f.row.record.leaseExpiresAt = "2000-01-01T00:00:00Z";
    }
    if (change === "wrong-step") {
      f.row.record.step = "planned";
    }
    if (change === "missing-readiness") {
      operator.authPreparation = undefined;
    }
    expect(() => requireFinalResourceBindingPhase(f.row, f.input)).toThrow();
  });
  it.each(["targetDigest", "database", "runtimeRole"] as const)(
    "requires completed Auth readiness to match the actual %s",
    (field) => {
      const f = phaseFixture();
      const preparation = f.row.record.operator?.authPreparation;
      if (preparation === undefined) {
        throw new Error("fixture Auth readiness missing");
      }
      preparation[field] = field === "targetDigest" ? "a".repeat(64) : "another_auth_identity";
      expect(() => requireFinalResourceBindingPhase(f.row, f.input)).toThrow();
    },
  );
  it("does not permit pending accounts or an unrelated completed status to use the idle read", () => {
    const f = phaseFixture(true);
    f.row.record.status = "pending";
    expect(() => requireFinalResourceBindingPhase(f.row, f.input)).toThrow();
    const bootstrap = phaseFixture();
    bootstrap.row.record.status = "participants-prepared";
    expect(() => requireFinalResourceBindingPhase(bootstrap.row, bootstrap.input)).toThrow();
  });
  it("retains existing leased final verification and prepared app reads", () => {
    const leased = phaseFixture();
    leased.row.record.leaseId = "00000000-0000-4000-8000-000000000011";
    leased.row.record.leaseExpiresAt = "2099-01-01T00:00:00Z";
    expect(requireFinalResourceBindingPhase(leased.row, leased.input)).toBe(leased.row);
    const prepared = phaseFixture();
    prepared.row.record.status = "prepared";
    prepared.row.record.step = "bound";
    expect(requireFinalResourceBindingPhase(prepared.row, prepared.input)).toBe(prepared.row);
  });
});

describe("retained installation metadata resource authority", () => {
  const fixture = () => {
    const f = phaseFixture();
    f.row.record.retainedAuth = retainedOperatorAuthFromJournal(f.row.record);
    const retained = f.row.record.retainedAuth;
    if (retained === undefined) {
      throw new Error("Fixture retained completion missing");
    }
    const original = structuredClone(retained);
    const accounts = phaseFixture(true);
    f.row.record.operator = accounts.row.record.operator;
    f.row.record.status = "participants-prepared";
    let approvalAvailable = true;
    let metadataReads = 0;
    const desired = hostedOperatorPlanSchema.parse({
      ...f.input.plan,
      stage: "app",
      normalActorPreparation: {
        accountOperationRef: operationRef,
        accountPlanDigest: operatorPlanDigest(accounts.input.plan),
        programDigest: normalActorProgramDigest(
          normalActorProgramSchema.parse(f.input.plan.normalActorProgram),
        ),
        accountApprovalId: "actual-approval",
        accountApprovedByCallId: "ordinary-public-approval",
      },
      effects: [
        ...f.input.plan.effects.filter((effect) => ["resources", "install"].includes(effect.kind)),
        { id: "access", kind: "access", description: "Access" },
        { id: "bindings", kind: "bindings", description: "Bindings" },
        ...f.input.plan.effects.filter((effect) =>
          ["gateway-bindings", "gateway-delivery"].includes(effect.kind),
        ),
      ],
    });
    const reader = createAppInstallationPlanningResourceReader({
      assertPlanningAuthorized: async () => {
        await Promise.resolve();
      },
      store: { read: async () => await Promise.resolve(structuredClone(f.row)) },
      readResourceBindings: async (input) => {
        await Promise.resolve();
        const selected = requireFinalResourceBindingPhase(
          selectAuthPlanningResourceBindingRow(f.row, input.plan),
          input,
        );
        // The canonical resource port must re-read the original approval before decryption.
        if (!approvalAvailable || selected.record.operator?.approvalId !== original.approvalId) {
          throw new HostedOperatorError("authorization_required");
        }
        return {
          appDatabase: { runtimeUrl: "private-app-runtime", migrationUrl: "private-app-migration" },
          authDatabase: {
            runtimeUrl: "private-auth-runtime",
            migrationUrl: "private-auth-migration",
          },
        };
      },
      readActiveCustomers: async (input) => {
        await input.assertCurrent();
        expect(input.plan).toEqual(desired);
        expect(input.runtimeUrl).toBe("private-app-runtime");
        metadataReads += 1;
        await input.assertCurrent();
        return ["retained-customer"];
      },
    });
    return {
      ...f,
      desired,
      reader,
      metadataReads: () => metadataReads,
      revoke: () => {
        approvalAvailable = false;
      },
      pendingApp: () => {
        const operator = f.row.record.operator;
        if (operator === undefined) {
          throw new Error("Fixture operator missing");
        }
        operator.plan = desired;
        operator.planDigest = operatorPlanDigest(desired);
        operator.approvalId = undefined;
        operator.receipts = [];
        f.row.record.approvedByCallId = "operator:unapproved-plan";
        f.row.record.status = "pending";
        f.row.revision += 1;
      },
    };
  };
  const scopes = [
    {
      appId: context.target.appId,
      actorId: "retained-actor",
      organizationId: "retained-customer",
      role: "member",
    },
  ];
  it("reads installed targets before and after an unapproved app reservation without approving it", async () => {
    const f = fixture();
    const beforeAccounts = structuredClone(f.row);
    expect(await f.reader(context, f.desired, scopes)).toEqual(["retained-customer"]);
    expect(f.row).toEqual(beforeAccounts);
    f.pendingApp();
    const before = structuredClone(f.row);
    expect(await f.reader(context, f.desired, scopes)).toEqual(["retained-customer"]);
    expect(f.row).toEqual(before);
    expect(f.row.record.operator?.approvalId).toBeUndefined();
    expect(f.metadataReads()).toBe(2);
  });
  it.each([
    "missing",
    "missing-receipt",
    "foreign-resource",
    "foreign-selection",
    "revoked",
    "expired",
  ] as const)(
    "refuses %s retained authority without reading metadata or changing the journal",
    async (failure) => {
      const f = fixture();
      f.pendingApp();
      const retained = f.row.record.retainedAuth;
      if (retained === undefined) {
        throw new Error("Fixture retained authority missing");
      }
      if (failure === "missing") {
        delete f.row.record.retainedAuth;
      } else if (failure === "missing-receipt") {
        retained.receipts = retained.receipts.slice(1);
      } else if (failure === "foreign-resource") {
        retained.plan.appDatabase.database = "foreign";
        retained.planDigest = operatorPlanDigest(retained.plan);
      } else if (failure === "foreign-selection") {
        retained.plan.selection.sessionId = "foreign-session";
        retained.planDigest = operatorPlanDigest(retained.plan);
      } else {
        // Both revoked and expired canonical approvals are denied by the authoritative resource port.
        f.revoke();
      }
      const before = structuredClone(f.row);
      await expect(f.reader(context, f.desired, scopes)).rejects.toBeInstanceOf(
        HostedOperatorError,
      );
      expect(f.metadataReads()).toBe(0);
      expect(f.row).toEqual(before);
    },
  );
});
