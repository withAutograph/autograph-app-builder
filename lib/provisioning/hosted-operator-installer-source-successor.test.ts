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

describe("hosted operator installer source successor", () => {
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
    record.operator!.receipts.push({
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
    expect(isInstallerSourceSuccessor(record, candidate!, now)).toBe(true);

    const pendingAuth = structuredClone(record);
    pendingAuth.operator!.pendingEffectId = "auth-schema";
    expect(isInstallerSourceSuccessor(pendingAuth, candidate!, now)).toBe(false);

    const missingAuthReceipt = structuredClone(record);
    missingAuthReceipt.operator!.receipts = missingAuthReceipt.operator!.receipts.filter(
      (receipt) => receipt.effectId !== "auth-schema",
    );
    expect(isInstallerSourceSuccessor(missingAuthReceipt, candidate!, now)).toBe(false);
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
    expect(isInstallerSourceSuccessor(record, repaired!, now)).toBe(true);
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
    wrongPendingEffect.operator!.pendingEffectId = "access";
    const completedInstall = makeRecord();
    completedInstall.operator!.receipts.push({
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
    afterInstall.operator!.receipts.push({
      effectId: "access",
      observedAt: "2027-01-01T00:00:00.000Z",
      resourceVersion: "fixture-access",
    });
    const corruptDigest = makeRecord();
    corruptDigest.operator!.planDigest = "f".repeat(64);
    const candidate = hostedOperatorPlanSchema.parse({
      ...plan,
      installer: { ...plan.installer, sha256: "e".repeat(64) },
    });

    expect(isInstallerSourceSuccessor(afterInstall, candidate, now)).toBe(false);
    expect(isInstallerSourceSuccessor(corruptDigest, candidate, now)).toBe(false);
  });
});
