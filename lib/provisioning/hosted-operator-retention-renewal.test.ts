import { describe, expect, it } from "vitest";
import {
  createRetentionRenewalPlan,
  isRetentionRenewalDeliveryProvenance,
  isRetentionRenewalSuccessor,
  readPendingRetentionRenewalPlan,
  retentionRenewalDeliveryProvenance,
} from "./hosted-operator-retention-renewal";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";

const now = Date.parse("2026-10-18T12:00:00.000Z");
const operationRef = "b209b89b-0bad-4a60-820f-4e29d5e5a4cc";
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner_fixture",
  workspaceId: "workspace_fixture",
};

const originalPlan = (): HostedOperatorPlan =>
  hostedOperatorPlanSchema.parse({
    access: [{ actorId: "owner_actor", organizationId: "org_fixture", roles: ["member"] }],
    action: "prepare",
    appDatabase: {
      database: "app_fixture",
      migratorRole: "app_owner",
      resourceId: "app-resource",
      runtimeRole: "app_runtime",
    },
    authDatabase: {
      database: "auth_fixture",
      migratorRole: "auth_owner",
      resourceId: "auth-resource",
      runtimeRole: "auth_runtime",
    },
    contextId: "accepted-spec",
    cost: {
      class: "shared-recovery-group",
      description: "Preview resources",
      owner: "owner_fixture",
    },
    deploymentBoundary: {
      app: {
        branch: "preview",
        deploymentId: "dpl_app",
        environment: "preview",
        projectId: "prj_app",
      },
      authority,
      gateway: {
        branch: "preview",
        deploymentId: "dpl_gateway",
        environment: "preview",
        projectId: "prj_gateway",
      },
      operator: {
        deploymentId: "dpl_operator",
        environment: "production",
        projectId: "prj_operator",
      },
      teamId: "team_fixture",
      verification: {
        gatewayOrigin: "https://gateway.example.test",
        jwksUrl: "https://gateway.example.test/_platform/jwks.json",
        publicOrigin: "https://app.example.test",
      },
    },
    delivery: {
      branch: "preview",
      gitSha: "1".repeat(40),
      projectId: "prj_app",
      repoId: "app-repository",
    },
    effects: [
      { description: "Prepare resources", id: "resources", kind: "resources" },
      { description: "Install schema", id: "install", kind: "install" },
      {
        description: "Confirm Auth organization membership",
        id: "auth-membership:org_fixture",
        kind: "auth-membership",
      },
      { description: "Grant approved access", id: "access", kind: "access" },
      {
        description: "Bind only app-owned runtime URL and public verification context.",
        id: "bindings",
        kind: "bindings",
      },
      { description: "Deliver app Preview", id: "delivery", kind: "delivery" },
      { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
      { description: "Deliver Gateway", id: "gateway-delivery", kind: "gateway-delivery" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: ["spend-review"],
      operatorOrigin: "https://operator.example.test",
      sourceWorkload: {
        audience: "https://vercel.com/team_fixture",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: "team_fixture",
        projectId: "prj_gateway",
        subject: "gateway-workload",
      },
    },
    gatewayDelivery: {
      branch: "preview",
      gitSha: "2".repeat(40),
      projectId: "prj_gateway",
      repoId: "gateway-repository",
    },
    authMembership: {
      actorId: "owner_actor",
      bootstrapPlanDigest: "8".repeat(64),
      identityCapture: {
        capturedAt: "2026-10-17T19:00:00.000Z",
        realmSessionId: "fixture-realm-session",
      },
      identityNonceSha256: "5".repeat(64),
      identityProof: { reference: "fixture-proof", sha256: "6".repeat(64) },
      identityVerification: {
        audience: "https://app.example.test",
        issuer: "https://app.example.test",
        jwksUrl: "https://app.example.test/jwks",
        transportSource: {
          audience: "https://vercel.com/team_fixture",
          environment: "preview",
          issuer: "https://oidc.vercel.com/team_fixture",
          ownerId: "team_fixture",
          projectId: "prj_gateway",
        },
      },
      kind: "create-owned-organization",
      name: "Fixture organization",
      organizationId: "org_fixture",
      slug: "fixture-organization",
    },
    installer: { reference: "app-installer", sha256: "3".repeat(64) },
    neon: {
      branchId: "br_fixture",
      connectionRef: "explicit-connection",
      endpoint: "ep-fixture.us-east-1.aws.neon.tech",
      projectId: "neon-fixture",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: "preview",
      origin: "https://app.example.test",
      projectId: "prj_gateway",
    },
    release: { artifactRef: "release-artifact", id: "release_fixture", sha256: "4".repeat(64) },
    retention: {
      expiresAt: "2026-10-17T20:00:16.471Z",
      policy: "Retain resources for the selected Preview",
    },
    selection: {
      appId: "spend-review",
      branch: "preview",
      environment: "preview",
      projectId: "prj_app",
      sessionId: "session_fixture",
    },
    stage: "app",
    version: 1,
  });

const appCandidate = {
  branch: "preview",
  deploymentId: "app-deployment",
  operationRef,
  origin: "https://app-deployment.example.test",
  projectId: "prj_app",
  readyState: "READY",
  repoId: "app-repository",
};
const gatewayCandidate = {
  branch: "preview",
  deploymentId: "gateway-deployment",
  gatewayAliasAttempted: true,
  operationRef,
  origin: "https://gateway-deployment.example.test",
  projectId: "prj_gateway",
  readyState: "READY",
  repoId: "gateway-repository",
};

const journal = (plan = originalPlan()): HostedRuntimeJournalRecord => {
  const effects = plan.effects.slice(0, -1);
  const operator = {
    approvalId: "approval_old",
    deliveryCandidates: [appCandidate],
    gatewayDeliveryCandidates: [gatewayCandidate],
    mode: "protected-operator-v1" as const,
    operationRef,
    pendingEffectAttempt: { id: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799" },
    pendingEffectId: "gateway-delivery",
    plan,
    planDigest: operatorPlanDigest(plan),
    receipts: effects.map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-10-17T19:00:00.000Z",
      resourceVersion: `observed-${effect.id}`,
    })),
  };
  return hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "call_old",
    kind: "app-runtime",
    operator,
    privateState: {
      encryptedToken: "encrypted_fixture",
      keyVersion: "fixture-key",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    request: {
      appId: plan.selection.appId,
      branch: plan.selection.branch,
      environment: "preview",
      installationId: "installation_fixture",
      projectId: plan.selection.projectId,
      scopeId: "team_fixture",
      scopeType: "team",
      sessionId: plan.selection.sessionId,
    },
    status: "pending",
    step: "reserved",
    version: 1,
  });
};

describe("approved retention renewal", () => {
  it("does not replace an unknown worker attempt with deployment-only renewal recovery", () => {
    const record = journal();
    const { operator } = record;
    if (operator === undefined) {
      throw new Error("Expected pending operator");
    }
    const pendingIndex = operator.plan.effects.findIndex((effect) => effect.kind === "install");
    const pending = operator.plan.effects[pendingIndex];
    if (pending === undefined) {
      throw new Error("Expected worker install effect");
    }
    const preceding = new Set(operator.plan.effects.slice(0, pendingIndex).map(({ id }) => id));
    operator.pendingEffectId = pending.id;
    operator.receipts = operator.receipts.filter(({ effectId }) => preceding.has(effectId));
    expect(createRetentionRenewalPlan(record, now)).toBeUndefined();
  });

  it("changes only expiry and the configured Preview grant, retaining old pending evidence", () => {
    const record = journal();
    const renewed = createRetentionRenewalPlan(record, now);
    if (renewed === undefined) {
      throw new Error("Expected an eligible expired app plan");
    }
    expect(isRetentionRenewalSuccessor(record, renewed, now)).toBe(true);
    expect(renewed?.retention.expiresAt).toBe(new Date(now + 24 * 60 * 60 * 1000).toISOString());
    expect(renewed?.appTrustedSources).toEqual({
      gatewayPreview: { from: "preview", projectId: "prj_gateway", to: "preview" },
    });
    expect(renewed.gatewayBindings?.trustedSources).toEqual({
      appPreview: { from: "preview", projectId: "prj_app", to: "preview" },
    });
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...renewed,
        gatewayBindings: {
          ...renewed.gatewayBindings,
          trustedSources: {
            appPreview: { from: "preview", projectId: "foreign-app", to: "preview" },
          },
        },
      }).success,
    ).toBe(false);
    expect(renewed?.effects.find((effect) => effect.id === "bindings")?.description).toBe(
      "Bind app-owned runtime URL and public verification context, and allow the configured Gateway Preview to reach this app Preview.",
    );
    expect(record.operator?.receipts).toHaveLength(7);
    expect(record.operator?.pendingEffectId).toBe("gateway-delivery");
    expect(record.operator?.pendingEffectAttempt).toBeDefined();
    expect(record.operator?.gatewayDeliveryCandidates).toEqual([gatewayCandidate]);

    const { delivery } = renewed;
    if (delivery === undefined) {
      throw new Error("Expected delivery scope");
    }
    const changedAccess = hostedOperatorPlanSchema.parse({
      ...renewed,
      access: [{ actorId: "different_actor", organizationId: "org_fixture", roles: ["member"] }],
    });
    const changedSource = hostedOperatorPlanSchema.parse({
      ...renewed,
      delivery: { ...delivery, gitSha: "5".repeat(40) },
    });
    expect(isRetentionRenewalSuccessor(record, changedAccess, now)).toBe(false);
    expect(isRetentionRenewalSuccessor(record, changedSource, now)).toBe(false);
  });

  it("exposes both archived candidate sets only under the exact renewed source provenance", () => {
    const prior = journal();
    const renewedPlan = createRetentionRenewalPlan(prior, now);
    if (renewedPlan === undefined || prior.operator === undefined) {
      throw new Error("Expected an eligible expired app plan");
    }
    const olderGatewayCandidates = Array.from({ length: 9 }, (_, index) => ({
      ...gatewayCandidate,
      deploymentId: `older-gateway-${index}`,
      operationRef: `11111111-1111-4111-8111-${String(index + 1).padStart(12, "0")}`,
    }));
    prior.operator.gatewayDeliveryCandidates = [...olderGatewayCandidates, gatewayCandidate];
    const immutableEffectIds = new Set(
      prior.operator.plan.effects
        .filter((effect) => ["resources", "install", "auth-membership"].includes(effect.kind))
        .map((effect) => effect.id),
    );
    const record = hostedRuntimeJournalRecordSchema.parse({
      ...prior,
      approvedByCallId: "operator:unapproved-plan",
      operator: {
        ...prior.operator,
        approvalId: undefined,
        plan: renewedPlan,
        planDigest: operatorPlanDigest(renewedPlan),
        pendingEffectId: undefined,
        pendingEffectAttempt: undefined,
        deliveryCandidates: [],
        gatewayDeliveryCandidates: [],
        receipts: prior.operator.receipts.filter((receipt) =>
          immutableEffectIds.has(receipt.effectId),
        ),
        retainedRenewalOperations: [
          { approvedByCallId: prior.approvedByCallId, operator: prior.operator },
        ],
      },
    });
    expect(readPendingRetentionRenewalPlan(record, now)).toEqual(renewedPlan);
    expect(readPendingRetentionRenewalPlan(record, now)).toEqual(renewedPlan);
    const [provenance] = retentionRenewalDeliveryProvenance(record);
    if (provenance === undefined) {
      throw new Error("Expected retained delivery provenance");
    }
    expect(provenance).toMatchObject({
      approvedByCallId: "call_old",
      approvalId: "approval_old",
      operationRef,
      planDigest: operatorPlanDigest(prior.operator.plan),
      deliveryCandidates: [appCandidate],
      gatewayDeliveryCandidates: [gatewayCandidate],
    });
    expect(isRetentionRenewalDeliveryProvenance(provenance, renewedPlan, operationRef)).toBe(true);
    expect(prior.operator.gatewayDeliveryCandidates).toEqual([
      ...olderGatewayCandidates,
      gatewayCandidate,
    ]);
    expect(
      record.operator?.retainedRenewalOperations?.[0]?.operator.gatewayDeliveryCandidates,
    ).toEqual(prior.operator.gatewayDeliveryCandidates);
    expect(
      isRetentionRenewalDeliveryProvenance(
        provenance,
        {
          ...renewedPlan,
          release: { ...renewedPlan.release, sha256: "6".repeat(64) },
        },
        operationRef,
      ),
    ).toBe(false);
  });
});
