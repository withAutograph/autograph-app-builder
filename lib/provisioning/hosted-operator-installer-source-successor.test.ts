import { describe, expect, it } from "vitest";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import {
  createInstallerSourceSuccessorPlan,
  isInstallerSourceSuccessor,
} from "./hosted-operator-installer-source-successor";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";

const now = Date.parse("2028-01-01T00:00:00.000Z");
const plan = hostedOperatorPlanSchema.parse({
  action: "prepare",
  access: [{ actorId: "reviewer", organizationId: "org_fixture", roles: ["reviewer"] }],
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "fixture-context",
  cost: {
    class: "shared-recovery-group",
    description: "Synthetic recovery fixture",
    owner: "Fixture owner",
  },
  effects: [
    {
      description: "Observe existing resources",
      id: "resources",
      kind: "resources",
    },
    {
      description: "Install the app release",
      id: "app-install",
      kind: "install",
    },
    { description: "Grant approved app access", id: "access", kind: "access" },
    { description: "Bind app runtime", id: "bindings", kind: "bindings" },
  ],
  installer: {
    reference: "generated-app-protected-installer-v1",
    sha256: "a".repeat(64),
  },
  neon: {
    branchId: "br_fixture",
    connectionRef: "owned-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-fixture",
    source: "synthetic-only",
  },
  release: {
    artifactRef: "fixture-release",
    id: "release-fixture",
    sha256: "b".repeat(64),
  },
  retention: {
    expiresAt: "2030-01-01T00:00:00.000Z",
    policy: "Retain fixture resources",
  },
  selection: {
    appId: "spend-review",
    branch: "preview",
    environment: "preview",
    projectId: "prj_fixture",
    sessionId: "session_fixture",
  },
  stage: "app",
  version: 1,
});

const makeRecord = (sourcePlan: HostedOperatorPlan = plan): HostedRuntimeJournalRecord =>
  hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "approved-plan-call",
    kind: "app-runtime",
    privateState: {
      encryptedToken: "fixture-ciphertext",
      keyVersion: "key-v1",
      tokenIv: "fixture-iv",
      tokenTag: "fixture-tag",
    },
    request: {
      appId: sourcePlan.selection.appId,
      branch: sourcePlan.selection.branch,
      environment: "preview",
      installationId: "icfg_fixture",
      projectId: sourcePlan.selection.projectId,
      scopeId: "team_fixture",
      scopeType: "team",
      sessionId: sourcePlan.selection.sessionId,
    },
    status: "pending",
    step: "reserved",
    version: 1,
    operator: {
      approvalId: "approval-fixture",
      fenceGeneration: 7,
      mode: "protected-operator-v1",
      operationRef: "fcc825bc-d683-422c-8b58-0d0a065ceb57",
      pendingEffectAttempt: {
        contextDigest: "c".repeat(64),
        id: "1f1f76b5-1c9c-4dd2-b437-8b88a5e02422",
      },
      pendingEffectId: "app-install",
      plan: sourcePlan,
      planDigest: operatorPlanDigest(sourcePlan),
      receipts: [
        {
          effectId: "resources",
          observedAt: "2027-01-01T00:00:00.000Z",
          resourceVersion: "fixture-resources",
        },
      ],
      workerCheckpoints: [
        {
          attemptId: "1f1f76b5-1c9c-4dd2-b437-8b88a5e02422",
          contextDigest: "c".repeat(64),
          effectId: "generated_app.prepare_schema_revision",
          fenceGeneration: 7,
          operationRef: "fcc825bc-d683-422c-8b58-0d0a065ceb57",
          parentEffectId: "app-install",
          receipt: { readbackSha256: "d".repeat(64), state: "applied" },
          resourceId: "app-resource",
          sequence: 1,
          tenantId: "org_fixture",
        },
      ],
    },
  });

const requireDefined = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected the fixture value to be defined");
  }
  return value;
};

const requireOperator = (record: HostedRuntimeJournalRecord) => {
  const { operator } = record;
  if (operator === undefined) {
    throw new Error("Expected the fixture operator record to be defined");
  }
  return operator;
};

const makeIdleRecord = (sourcePlan: HostedOperatorPlan = plan): HostedRuntimeJournalRecord => {
  const record = makeRecord(sourcePlan);
  const operator = requireOperator(record);
  delete operator.pendingEffectId;
  delete operator.pendingEffectAttempt;
  delete operator.workerCheckpoints;
  record.executionObservation = {
    state: "settled",
    attemptRef: "5b61f372-3afb-46e8-a7e1-06be519b72ab",
    operationRef: operator.operationRef,
    planDigest: operator.planDigest,
    callId: record.approvedByCallId,
    approvalId: requireDefined(operator.approvalId),
    outcome: { status: "blocked", code: "resource_mismatch" },
  };
  return record;
};

describe("hosted operator installer source successor", () => {
  it("proposes only an installer digest replacement for a settled idle app-install inspection", () => {
    const record = makeIdleRecord();
    const original = structuredClone(record);
    const candidate = createInstallerSourceSuccessorPlan(
      record,
      { id: plan.installer.reference, sha256: "e".repeat(64) },
      now,
    );
    expect(candidate).toEqual({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });
    expect(record).toEqual(original);
  });

  it.each([
    "missing observation",
    "running observation",
    "nonblocked observation",
    "operation mismatch",
    "plan mismatch",
    "call mismatch",
    "approval mismatch",
    "pending attempt",
    "lease id",
    "lease expiry",
    "install checkpoint",
    "missing prerequisite",
    "later receipt",
    "unapproved",
    "missing private state",
  ])("rejects idle recovery with %s", (failure) => {
    const record = makeIdleRecord();
    const operator = requireOperator(record);
    const observation = requireDefined(record.executionObservation);
    switch (failure) {
      case "missing observation": {
        delete record.executionObservation;
        break;
      }
      case "running observation": {
        record.executionObservation = {
          state: "running",
          attemptRef: observation.attemptRef,
          operationRef: observation.operationRef,
          planDigest: observation.planDigest,
          callId: observation.callId,
          approvalId: observation.approvalId,
        };
        break;
      }
      case "nonblocked observation": {
        record.executionObservation = {
          ...observation,
          state: "settled",
          outcome: { status: "prepared" },
        };
        break;
      }
      case "operation mismatch": {
        observation.operationRef = "bcff62cf-8b7e-49b2-8c69-eef3063e11ca";
        break;
      }
      case "plan mismatch": {
        observation.planDigest = "f".repeat(64);
        break;
      }
      case "call mismatch": {
        observation.callId = "other-call";
        break;
      }
      case "approval mismatch": {
        observation.approvalId = "other-approval";
        break;
      }
      case "pending attempt": {
        operator.pendingEffectAttempt = requireOperator(makeRecord()).pendingEffectAttempt;
        break;
      }
      case "lease id": {
        record.leaseId = "bcff62cf-8b7e-49b2-8c69-eef3063e11ca";
        break;
      }
      case "lease expiry": {
        record.leaseExpiresAt = "2027-01-01T00:00:00.000Z";
        break;
      }
      case "install checkpoint": {
        operator.workerCheckpoints = requireOperator(makeRecord()).workerCheckpoints;
        break;
      }
      case "missing prerequisite": {
        operator.receipts = [];
        break;
      }
      case "later receipt": {
        operator.receipts.push({
          effectId: "access",
          observedAt: "2027-01-01T00:00:00.000Z",
          resourceVersion: "fixture",
        });
        break;
      }
      case "unapproved": {
        record.approvedByCallId = "operator:unapproved-plan";
        break;
      }
      case "missing private state": {
        delete record.privateState;
        break;
      }
      default: {
        throw new Error("Unknown idle recovery fixture mutation");
      }
    }
    expect(
      createInstallerSourceSuccessorPlan(
        record,
        { id: plan.installer.reference, sha256: "e".repeat(64) },
        now,
      ),
    ).toBeUndefined();
  });

  it("does not select a later app install past an unreceipted Auth install", () => {
    const authFirst = hostedOperatorPlanSchema.parse({
      ...plan,
      effects: [
        plan.effects[0],
        { id: "auth-schema", kind: "install", description: "Prepare Auth" },
        ...plan.effects.slice(1),
      ],
    });
    expect(
      createInstallerSourceSuccessorPlan(
        makeIdleRecord(authFirst),
        { id: plan.installer.reference, sha256: "e".repeat(64) },
        now,
      ),
    ).toBeUndefined();
  });

  it("recovers the pending app install after its separate Auth install prerequisite", () => {
    const fullPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      effects: plan.effects.flatMap((effect) =>
        effect.id === "app-install"
          ? [
              { id: "auth-schema", kind: "install", description: "Prepare shared Auth schema" },
              effect,
            ]
          : [effect],
      ),
    });
    const record = makeRecord(fullPlan);
    requireOperator(record).receipts.push({
      effectId: "auth-schema",
      observedAt: "2027-01-01T00:00:00.000Z",
      resourceVersion: "fixture-auth-schema",
    });
    const candidate = createInstallerSourceSuccessorPlan(
      record,
      { id: fullPlan.installer.reference, sha256: "e".repeat(64) },
      now,
    );
    expect(candidate).toBeDefined();
    expect(isInstallerSourceSuccessor(record, requireDefined(candidate), now)).toBe(true);

    const pendingAuth = structuredClone(record);
    requireOperator(pendingAuth).pendingEffectId = "auth-schema";
    expect(isInstallerSourceSuccessor(pendingAuth, requireDefined(candidate), now)).toBe(false);

    const missingAuthReceipt = structuredClone(record);
    requireOperator(missingAuthReceipt).receipts = requireOperator(
      missingAuthReceipt,
    ).receipts.filter((receipt) => receipt.effectId !== "auth-schema");
    expect(isInstallerSourceSuccessor(missingAuthReceipt, requireDefined(candidate), now)).toBe(
      false,
    );
  });

  it("preserves marked uncertain install recovery with expired lease and retained worker checkpoints", () => {
    const record = makeRecord();
    record.leaseId = "bcff62cf-8b7e-49b2-8c69-eef3063e11ca";
    record.leaseExpiresAt = "2027-01-01T00:00:00.000Z";
    expect(record.executionObservation).toBeUndefined();
    expect(
      createInstallerSourceSuccessorPlan(
        record,
        { id: plan.installer.reference, sha256: "e".repeat(64) },
        now,
      ),
    ).toBeDefined();
  });

  it("changes only the pinned installer digest and preserves approved plan expiry", () => {
    const record = makeRecord();
    const repaired = createInstallerSourceSuccessorPlan(
      record,
      { id: plan.installer.reference, sha256: "e".repeat(64) },
      now,
    );

    expect(repaired).toBeDefined();
    expect(repaired?.installer).toEqual({
      reference: plan.installer.reference,
      sha256: "e".repeat(64),
    });
    expect(repaired?.retention).toEqual(plan.retention);
    expect(isInstallerSourceSuccessor(record, requireDefined(repaired), now)).toBe(true);
    expect(record.operator?.plan).toEqual(plan);
  });

  it("rejects changes to any other plan field or an unexpired-plan violation", () => {
    const record = makeRecord();
    const changedExpiry = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
      retention: { ...plan.retention, expiresAt: "2031-01-01T00:00:00.000Z" },
    });
    const changedEffect = hostedOperatorPlanSchema.parse({
      ...plan,
      effects: plan.effects.map((effect) =>
        effect.id === "app-install" ? { ...effect, description: "Changed install intent" } : effect,
      ),
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });
    const expired = makeRecord({
      ...plan,
      retention: { ...plan.retention, expiresAt: "2027-01-01T00:00:00.000Z" },
    });

    expect(isInstallerSourceSuccessor(record, changedExpiry, now)).toBe(false);
    expect(isInstallerSourceSuccessor(record, changedEffect, now)).toBe(false);
    expect(
      createInstallerSourceSuccessorPlan(
        expired,
        { id: plan.installer.reference, sha256: "e".repeat(64) },
        now,
      ),
    ).toBeUndefined();
  });

  it("rejects unapproved, private-state-free, or actively leased records", () => {
    const unapproved = makeRecord();
    unapproved.approvedByCallId = "operator:unapproved-plan";
    const noPrivateState = makeRecord();
    delete noPrivateState.privateState;
    const activeLease = makeRecord();
    activeLease.leaseId = "03d1b9c1-d78f-4d7a-8d60-5880fcd13480";
    activeLease.leaseExpiresAt = "2028-01-01T00:01:00.000Z";
    const candidate = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });

    expect(isInstallerSourceSuccessor(unapproved, candidate, now)).toBe(false);
    expect(isInstallerSourceSuccessor(noPrivateState, candidate, now)).toBe(false);
    expect(isInstallerSourceSuccessor(activeLease, candidate, now)).toBe(false);
  });

  it("requires the matching outstanding install effect with no install receipt", () => {
    const wrongPendingEffect = makeRecord();
    requireOperator(wrongPendingEffect).pendingEffectId = "access";
    const completedInstall = makeRecord();
    requireOperator(completedInstall).receipts.push({
      effectId: "app-install",
      observedAt: "2027-01-01T00:00:00.000Z",
      resourceVersion: "fixture-install",
    });
    const candidate = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });

    expect(isInstallerSourceSuccessor(wrongPendingEffect, candidate, now)).toBe(false);
    expect(isInstallerSourceSuccessor(completedInstall, candidate, now)).toBe(false);
  });

  it("requires the same generated worker identity and a changed digest", () => {
    const record = makeRecord();
    expect(
      createInstallerSourceSuccessorPlan(
        record,
        { id: "different-worker", sha256: "e".repeat(64) },
        now,
      ),
    ).toBeUndefined();
    expect(
      createInstallerSourceSuccessorPlan(
        record,
        { id: plan.installer.reference, sha256: plan.installer.sha256 },
        now,
      ),
    ).toBeUndefined();
  });

  it("rejects receipts outside already observed prerequisite effects and corrupt old digests", () => {
    const afterInstall = makeRecord();
    requireOperator(afterInstall).receipts.push({
      effectId: "access",
      observedAt: "2027-01-01T00:00:00.000Z",
      resourceVersion: "fixture-access",
    });
    const corruptDigest = makeRecord();
    requireOperator(corruptDigest).planDigest = "f".repeat(64);
    const candidate = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });

    expect(isInstallerSourceSuccessor(afterInstall, candidate, now)).toBe(false);
    expect(isInstallerSourceSuccessor(corruptDigest, candidate, now)).toBe(false);
  });
});
