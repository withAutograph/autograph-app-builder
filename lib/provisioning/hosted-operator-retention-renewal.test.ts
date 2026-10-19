import { describe, expect, it } from "vitest";
import {
  createRetentionRenewalPlan,
  isRetentionRenewalDeliveryProvenance,
  isRetentionRenewalSuccessor,
  readPendingRetentionRenewalPlan,
  retentionRenewalDeliveryProvenance,
  retentionRenewalBindingProvenance,
  isRetentionRenewalBindingProvenance,
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

const journal = (
  plan = originalPlan(),
  pendingEffectId = "gateway-delivery",
): HostedRuntimeJournalRecord => {
  const effects = plan.effects.slice(
    0,
    plan.effects.findIndex((effect) => effect.id === pendingEffectId),
  );
  const operator = {
    approvalId: "approval_old",
    deliveryCandidates: [appCandidate],
    gatewayDeliveryCandidates: [gatewayCandidate],
    mode: "protected-operator-v1" as const,
    operationRef,
    pendingEffectAttempt: { id: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799" },
    pendingEffectId,
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

const changeCurrentPlan = (
  record: HostedRuntimeJournalRecord,
  change: (plan: HostedOperatorPlan) => HostedOperatorPlan,
) => {
  const current = record.operator;
  if (current === undefined) {
    throw new Error("Expected current operator");
  }
  current.plan = hostedOperatorPlanSchema.parse(change(current.plan));
  current.planDigest = operatorPlanDigest(current.plan);
};
const requireFixtureValue = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Expected configured Gateway fixture value");
  }
  return value;
};

describe("approved retention renewal", () => {
  it.each(["bindings", "gateway-bindings"] as const)(
    "renews pending %s while retaining its exact unknown attempt and row provenance",
    (kind) => {
      const prior = journal(originalPlan(), kind);
      const previous = requireFixtureValue(prior.operator);
      const row = {
        branch: "preview",
        comment: `App Builder protected operator ${operationRef}`,
        id: "existing-row",
        key: "PLATFORM_ORIGIN",
        operationRef,
        projectId: "prj_app",
      };
      if (kind === "bindings") {
        previous.managedEnvironment = [row];
      } else {
        previous.gatewayEnvironment = [
          { ...row, key: "PLATFORM_GATEWAY_PROJECT_BINDINGS", projectId: "prj_gateway" },
        ];
      }
      const renewedPlan = requireFixtureValue(createRetentionRenewalPlan(prior, now));
      expect(isRetentionRenewalSuccessor(prior, renewedPlan, now)).toBe(true);
      const successor = {
        ...prior,
        operator: {
          ...previous,
          plan: renewedPlan,
          planDigest: operatorPlanDigest(renewedPlan),
          retainedRenewalOperations: [
            { approvedByCallId: prior.approvedByCallId, operator: previous },
          ],
        },
      };
      const provenance = requireFixtureValue(retentionRenewalBindingProvenance(successor, kind));
      expect(provenance.pendingEffectAttempt).toEqual(previous.pendingEffectAttempt);
      expect(provenance.rows).toEqual(
        kind === "bindings" ? previous.managedEnvironment : previous.gatewayEnvironment,
      );
      expect(
        isRetentionRenewalBindingProvenance(provenance, renewedPlan, operationRef, kind, kind),
      ).toBe(true);
      expect(
        isRetentionRenewalBindingProvenance(
          provenance,
          renewedPlan,
          "different-operation",
          kind,
          kind,
        ),
      ).toBe(false);
      expect(
        isRetentionRenewalBindingProvenance(
          { ...provenance, planDigest: "0".repeat(64) },
          renewedPlan,
          operationRef,
          kind,
          kind,
        ),
      ).toBe(false);
      expect(previous.pendingEffectId).toBe(kind);
      expect(previous.receipts).toHaveLength(
        previous.plan.effects.findIndex((effect) => effect.id === kind),
      );
      const missingReceipt = structuredClone(prior);
      requireFixtureValue(missingReceipt.operator).receipts.pop();
      expect(createRetentionRenewalPlan(missingReceipt, now)).toBeUndefined();
      const activeLease = {
        ...prior,
        leaseId: "0b0e9c7b-b48f-4f8d-99be-9b74c9606799",
        leaseExpiresAt: new Date(now + 1000).toISOString(),
      };
      expect(createRetentionRenewalPlan(activeLease, now)).toBeUndefined();
    },
  );

  it("keeps pending app delivery outside binding renewal support", () => {
    expect(createRetentionRenewalPlan(journal(originalPlan(), "delivery"), now)).toBeUndefined();
  });

  it("does not classify a pending binding with no actual attempt as fresh setup", () => {
    const record = journal(originalPlan(), "bindings");
    delete requireFixtureValue(record.operator).pendingEffectAttempt;
    expect(createRetentionRenewalPlan(record, now)).toBeUndefined();
  });

  it.each(["bindings", "gateway-bindings"] as const)(
    "retains original %s uncertainty when a renewed readback expires before a new attempt",
    (kind) => {
      const original = journal(originalPlan(), kind);
      const originalOperator = requireFixtureValue(original.operator);
      const firstPlan = requireFixtureValue(createRetentionRenewalPlan(original, now));
      const first = {
        ...original,
        approvedByCallId: "renewed-approved-call",
        operator: {
          ...originalOperator,
          approvalId: "renewed-approval",
          plan: firstPlan,
          planDigest: operatorPlanDigest(firstPlan),
          pendingEffectId: undefined,
          pendingEffectAttempt: undefined,
          retainedRenewalOperations: [
            { approvedByCallId: original.approvedByCallId, operator: originalOperator },
          ],
        },
      };
      const secondPlan = requireFixtureValue(
        createRetentionRenewalPlan(first, Date.parse(firstPlan.retention.expiresAt) + 1),
      );
      const { retainedRenewalOperations, ...newerPredecessor } = first.operator;
      const second = {
        ...first,
        operator: {
          ...first.operator,
          plan: secondPlan,
          planDigest: operatorPlanDigest(secondPlan),
          retainedRenewalOperations: [
            ...retainedRenewalOperations,
            { approvedByCallId: first.approvedByCallId, operator: newerPredecessor },
          ],
        },
      };
      const provenance = requireFixtureValue(retentionRenewalBindingProvenance(second, kind));
      expect(provenance.approvedByCallId).toBe(original.approvedByCallId);
      expect(provenance.pendingEffectAttempt).toEqual(originalOperator.pendingEffectAttempt);
      expect(provenance.planDigest).toBe(originalOperator.planDigest);
      expect(
        isRetentionRenewalBindingProvenance(provenance, secondPlan, operationRef, kind, kind),
      ).toBe(true);
      const noHistory = {
        ...first,
        operator: { ...first.operator, retainedRenewalOperations: [] },
      };
      expect(
        createRetentionRenewalPlan(noHistory, Date.parse(firstPlan.retention.expiresAt) + 1),
      ).toBeUndefined();
    },
  );

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

  it("retains a consumed Realm link only through exact approved renewal delivery evidence", () => {
    const original = journal();
    const originalOperator = original.operator;
    if (originalOperator === undefined) {
      throw new Error("Expected pending operator");
    }
    const linked = hostedRuntimeJournalRecordSchema.parse({
      ...original,
      operator: {
        ...originalOperator,
        gatewayDeliveryCandidates: [
          {
            ...gatewayCandidate,
            operationRef: "f5e1999a-bb1e-44d1-a5f3-6a68ef53897c",
          },
        ],
        deliveredGatewayDeploymentId: gatewayCandidate.deploymentId,
        identityLink: {
          audience: "https://app.example.test",
          authResourceId: originalOperator.plan.authDatabase.resourceId,
          bootstrapPlanDigest: "8".repeat(64),
          browserOrigin: originalOperator.plan.gatewayBindings?.authBrowserOrigin,
          consumedAt: "2026-10-17T19:30:00.000Z",
          endpointOrigin: gatewayCandidate.origin,
          expiresAt: "2026-10-17T20:00:00.000Z",
          issuer: originalOperator.plan.deploymentBoundary?.verification.publicOrigin,
          nonceSha256: "5".repeat(64),
          organizationId: "org_fixture",
          ownerSessionId: originalOperator.plan.selection.sessionId,
          proofRef: "fixture-proof",
          proofSha256: "6".repeat(64),
        },
      },
    });
    const previousOperator = linked.operator;
    if (previousOperator === undefined) {
      throw new Error("Expected linked pending operator");
    }
    const renewedPlan = createRetentionRenewalPlan(linked, now);
    if (renewedPlan === undefined) {
      throw new Error("Expected an eligible retained renewal");
    }
    const immutableEffectIds = new Set(
      previousOperator.plan.effects
        .filter((effect) => ["resources", "install", "auth-membership"].includes(effect.kind))
        .map((effect) => effect.id),
    );
    const renewed = hostedRuntimeJournalRecordSchema.parse({
      ...linked,
      approvedByCallId: "operator:unapproved-plan",
      operator: {
        ...previousOperator,
        approvalId: undefined,
        plan: renewedPlan,
        planDigest: operatorPlanDigest(renewedPlan),
        pendingEffectId: undefined,
        pendingEffectAttempt: undefined,
        deliveryCandidates: [],
        gatewayDeliveryCandidates: [],
        deliveredGatewayDeploymentId: undefined,
        receipts: previousOperator.receipts.filter((receipt) =>
          immutableEffectIds.has(receipt.effectId),
        ),
        retainedRenewalOperations: [
          { approvedByCallId: linked.approvedByCallId, operator: previousOperator },
        ],
      },
    });
    expect(renewed.operator?.gatewayDeliveryCandidates).toEqual([]);
    expect(renewed.operator?.identityLink).toEqual(previousOperator.identityLink);

    const invalidRecords = [
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0];
        if (retained !== undefined) {
          retained.approvedByCallId = "operator:unapproved-plan";
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained !== undefined) {
          retained.planDigest = "0".repeat(64);
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained !== undefined) {
          delete retained.approvalId;
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained !== undefined) {
          retained.deliveredGatewayDeploymentId = "other-deployment";
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained?.gatewayDeliveryCandidates?.[0] !== undefined) {
          retained.gatewayDeliveryCandidates[0].repoId = "other-repository";
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained?.gatewayDeliveryCandidates?.[0] !== undefined) {
          retained.gatewayDeliveryCandidates[0].readyState = "ERROR";
        }
      },
      (record: typeof renewed) => {
        const retained = record.operator?.retainedRenewalOperations?.[0]?.operator;
        if (retained?.gatewayDeliveryCandidates?.[0] !== undefined) {
          retained.gatewayDeliveryCandidates[0].branch = "other-branch";
        }
      },
      (record: typeof renewed) => {
        if (record.operator?.identityLink !== undefined) {
          record.operator.identityLink.proofSha256 = "7".repeat(64);
        }
      },
      (record: typeof renewed) => {
        if (record.operator?.identityLink !== undefined) {
          record.operator.identityLink.ownerSessionId = "other-owner-session";
        }
      },
      (record: typeof renewed) => {
        changeCurrentPlan(record, (plan) => {
          const boundary = requireFixtureValue(plan.deploymentBoundary);
          const gatewayBindings = requireFixtureValue(plan.gatewayBindings);
          const sourceWorkload = requireFixtureValue(gatewayBindings.sourceWorkload);
          const gatewayDelivery = requireFixtureValue(plan.gatewayDelivery);
          const publicGateway = requireFixtureValue(plan.publicGateway);
          return {
            ...plan,
            appTrustedSources: {
              gatewayPreview: { from: "preview", projectId: "other-project", to: "preview" },
            },
            deploymentBoundary: {
              ...boundary,
              gateway: { ...boundary.gateway, projectId: "other-project" },
            },
            gatewayBindings: {
              ...gatewayBindings,
              sourceWorkload: { ...sourceWorkload, projectId: "other-project" },
            },
            gatewayDelivery: { ...gatewayDelivery, projectId: "other-project" },
            publicGateway: { ...publicGateway, projectId: "other-project" },
          };
        });
      },
      (record: typeof renewed) => {
        changeCurrentPlan(record, (plan) => {
          const boundary = requireFixtureValue(plan.deploymentBoundary);
          const gatewayDelivery = requireFixtureValue(plan.gatewayDelivery);
          const publicGateway = requireFixtureValue(plan.publicGateway);
          return {
            ...plan,
            deploymentBoundary: {
              ...boundary,
              gateway: { ...boundary.gateway, branch: "other-branch" },
            },
            gatewayDelivery: { ...gatewayDelivery, branch: "other-branch" },
            publicGateway: { ...publicGateway, branch: "other-branch" },
          };
        });
      },
      (record: typeof renewed) => {
        changeCurrentPlan(record, (plan) => ({
          ...plan,
          gatewayDelivery: {
            ...requireFixtureValue(plan.gatewayDelivery),
            gitSha: "9".repeat(40),
          },
        }));
      },
      (record: typeof renewed) => {
        changeCurrentPlan(record, (plan) => {
          const gatewayBindings = requireFixtureValue(plan.gatewayBindings);
          const sourceWorkload = requireFixtureValue(gatewayBindings.sourceWorkload);
          return {
            ...plan,
            gatewayBindings: {
              ...gatewayBindings,
              sourceWorkload: { ...sourceWorkload, audience: "https://other.example" },
            },
          };
        });
      },
    ];
    for (const mutate of invalidRecords) {
      const invalid = structuredClone(renewed);
      mutate(invalid);
      expect(hostedRuntimeJournalRecordSchema.safeParse(invalid).success).toBe(false);
    }
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
