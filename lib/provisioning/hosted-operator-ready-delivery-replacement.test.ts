import { describe, expect, it, vi } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { HostedRuntimeJournalRecord } from "./hosted-runtime-journal";
import {
  createRetentionRenewalPlan,
  retentionRenewalDeliveryProvenance,
} from "./hosted-operator-retention-renewal";
import {
  readyDeliveryReplacementIntentSchema,
  type ReadyDeliveryReplacementIntent,
} from "./hosted-operator-ready-delivery-replacement-intent";
import {
  isReadyDeliveryReplacementSuccessor,
  resolveReadyDeliveryReplacementPredecessor,
} from "./hosted-operator-ready-delivery-replacement";
import {
  createNativePreviewRecoveryPlan,
  readNativePreviewRecoveryPlan,
  withExternallyManagedHostProtection,
} from "./hosted-operator-native-preview-recovery";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import { createHostedOperatorDeploymentDelivery } from "./hosted-operator-deployment-delivery";
import { createReadyReplacementNativeReader } from "./hosted-operator-ready-replacement-native";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import type { ExternallyManagedTrustedSources } from "./hosted-operator-host-protection";
import { publicApprovalDescription } from "../agent/approval-receipt";

const externalPolicy: ExternallyManagedTrustedSources = {
  mode: "externally-managed-trusted-sources",
  teamId: "team-notes",
  appPreview: {
    sourceProjectId: "project-gateway",
    targetProjectId: "project-notes",
    from: "preview",
    to: "preview",
  },
  gatewayPreview: {
    sourceProjectId: "project-notes",
    targetProjectId: "project-gateway",
    from: "preview",
    to: "preview",
  },
  observedAt: "2026-10-19T10:00:00Z",
  provenance: {
    kind: "administrator-provider-readback",
    reference: "administrator-readback:synthetic-notes",
  },
};

const now = Date.parse("2026-10-19T12:00:00.000Z");
const operationRef = "ac5bbf46-a873-4a90-8742-c591dd59dbdb";
const attemptId = "b596a9fe-8316-4eb1-97af-a046c85de610";

const fixture = () => {
  const plan = hostedOperatorPlanSchema.parse({
    version: 1,
    action: "prepare",
    stage: "app",
    selection: {
      sessionId: "session-notes",
      appId: "field-notes",
      projectId: "project-notes",
      branch: "feature/notes",
      environment: "preview",
    },
    appDatabase: {
      database: "notes",
      migratorRole: "notes_owner",
      runtimeRole: "notes_reader",
      resourceId: "resource-notes",
    },
    authDatabase: {
      database: "identity",
      migratorRole: "identity_owner",
      runtimeRole: "identity_reader",
      resourceId: "resource-identity",
    },
    contextId: "notes-context",
    neon: {
      projectId: "neon-notes",
      branchId: "branch-notes",
      connectionRef: "connection-notes",
      endpoint: "ep-notes.us-east-1.aws.neon.tech",
      source: "synthetic-only",
    },
    deploymentBoundary: {
      app: { projectId: "project-notes", branch: "feature/notes", environment: "preview" },
      gateway: { projectId: "project-gateway", branch: "gateway/notes", environment: "preview" },
      operator: {
        projectId: "project-builder",
        deploymentId: "operator-1",
        environment: "production",
      },
      authority: {
        audience: "https://builder.example/mcp",
        issuer: "https://builder.example/api/auth",
        ownerUserId: "owner-notes",
        workspaceId: "workspace-notes",
      },
      teamId: "team-notes",
      verification: {
        publicOrigin: "https://notes.example.test",
        gatewayOrigin: "https://gateway.example.test",
        jwksUrl: "https://gateway.example.test/_platform/jwks.json",
      },
    },
    delivery: {
      projectId: "project-notes",
      branch: "feature/notes",
      repoId: "repo-notes",
      gitSha: "1".repeat(40),
    },
    gatewayDelivery: {
      projectId: "project-gateway",
      branch: "gateway/notes",
      repoId: "repo-gateway",
      gitSha: "2".repeat(40),
    },
    publicGateway: {
      projectId: "project-gateway",
      branch: "gateway/notes",
      origin: "https://notes.example.test",
    },
    gatewayBindings: {
      authBrowserOrigin: "https://identity.example.test",
      builderCallbackOrigin: "https://builder.example",
      operatorOrigin: "https://operator.example.test",
      catalogAppIds: ["field-notes"],
      sourceWorkload: {
        audience: "https://vercel.com/team-notes",
        issuer: "https://oidc.vercel.com/team-notes",
        subject: "gateway-notes-workload",
        ownerId: "team-notes",
        projectId: "project-gateway",
        environment: "preview",
      },
    },
    access: [
      { actorId: "writer-notes", organizationId: "organization-notes", roles: ["contributor"] },
    ],
    installer: { reference: "notes-installer", sha256: "3".repeat(64) },
    release: { artifactRef: "notes-release", id: "notes-release-1", sha256: "4".repeat(64) },
    retention: { expiresAt: "2026-10-20T12:00:00.000Z", policy: "Retain approved Preview" },
    cost: {
      class: "independent-service",
      owner: "owner-notes",
      description: "Approved Preview resources",
    },
    effects: [
      "resources",
      "install",
      "access",
      "bindings",
      "delivery",
      "gateway-bindings",
      "gateway-delivery",
    ].map((kind, index) => ({ kind, id: `notes-effect-${index}`, description: `Notes ${kind}` })),
  });
  const record: HostedRuntimeJournalRecord = {
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "approval-call-notes",
    status: "pending",
    step: "reserved",
    privateState: {
      encryptedToken: "protected-notes",
      keyVersion: "key-1",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    request: {
      ...plan.selection,
      installationId: "installation-notes",
      scopeType: "team",
      scopeId: "team-notes",
    },
    operator: {
      mode: "protected-operator-v1",
      operationRef,
      approvalId: "approval-notes",
      plan,
      planDigest: operatorPlanDigest(plan),
      pendingEffectId: "notes-effect-5",
      pendingEffectAttempt: { id: attemptId },
      receipts: plan.effects.slice(0, 5).map((effect) => ({
        effectId: effect.id,
        observedAt: "2026-10-19T10:00:00.000Z",
        resourceVersion: `version-${effect.id}`,
      })),
      deliveryCandidates: [
        {
          deploymentId: "ready-notes",
          operationRef,
          projectId: "project-notes",
          branch: "feature/notes",
          repoId: "repo-notes",
          readyState: "READY",
          origin: "https://notes-immutable.example.test",
        },
      ],
    },
  };
  const intent: ReadyDeliveryReplacementIntent = {
    version: 1,
    predecessor: {
      operationRef,
      planDigest: record.operator!.planDigest,
      appDeploymentId: "ready-notes",
    },
  };
  return {
    record,
    intent,
    candidate: { ...structuredClone(plan), appDeliveryReplacement: intent },
  };
};

const recoveryFixture = () => {
  const base = fixture();
  const original = base.record.operator!;
  original.plan.retention.expiresAt = "2026-10-17T12:00:00Z";
  original.planDigest = operatorPlanDigest(original.plan);
  original.pendingEffectId = original.plan.effects[6].id;
  original.receipts = original.plan.effects.slice(0, 6).map((effect) => ({
    effectId: effect.id,
    observedAt: "2026-10-17T10:00:00Z",
    resourceVersion: "old-owned-proof",
  }));
  original.gatewayDeliveryCandidates = [
    {
      deploymentId: "ready-gateway",
      operationRef,
      projectId: "project-gateway",
      branch: "gateway/notes",
      repoId: "repo-gateway",
      readyState: "READY",
      origin: "https://gateway-immutable.example.test",
      gatewayAliasAttempted: true,
    },
  ];
  const firstPlan = createRetentionRenewalPlan(base.record, now - 24 * 60 * 60 * 1000)!;
  expect(firstPlan).toBeDefined();
  const first = {
    mode: original.mode,
    operationRef,
    approvalId: "approval-first-renewal",
    plan: firstPlan,
    planDigest: operatorPlanDigest(firstPlan),
    receipts: firstPlan.effects.slice(0, 3).map((effect) => ({
      effectId: effect.id,
      observedAt: "2026-10-18T12:01:00Z",
      resourceVersion: "retained-resource",
    })),
    pendingEffectId: firstPlan.effects[3].id,
    pendingEffectAttempt: { id: "52222222-2222-4222-8222-222222222222" },
  };
  const firstRecord = {
    ...base.record,
    approvedByCallId: "approval-call-first",
    operator: {
      ...first,
      retainedRenewalOperations: [
        { approvedByCallId: base.record.approvedByCallId, operator: original },
      ],
    },
  };
  const secondPlan = createRetentionRenewalPlan(firstRecord, now)!;
  expect(secondPlan).toBeDefined();
  const current: HostedRuntimeJournalRecord = {
    ...base.record,
    approvedByCallId: "approval-call-current",
    operator: {
      mode: original.mode,
      operationRef,
      approvalId: "approval-current",
      plan: secondPlan,
      planDigest: operatorPlanDigest(secondPlan),
      receipts: first.receipts,
      retainedRenewalOperations: [
        { approvedByCallId: base.record.approvedByCallId, operator: structuredClone(original) },
        { approvedByCallId: "approval-call-first", operator: first },
      ],
    },
  };
  return {
    current,
    original: structuredClone(original),
    proposed: createNativePreviewRecoveryPlan(current, externalPolicy, now, "ready-gateway")!,
  };
};

describe("native externally managed policy recovery integration", () => {
  it("shows exact external policy evidence and named READY predecessors in the new approval", () => {
    const f = recoveryFixture();
    const input = {
      ...f.proposed.selection,
      plan: f.proposed,
      planDigest: operatorPlanDigest(f.proposed),
    };
    const description = publicApprovalDescription(input, "prepare-app-hosted-runtime");
    for (const identity of [
      externalPolicy.teamId,
      externalPolicy.appPreview.sourceProjectId,
      externalPolicy.appPreview.targetProjectId,
      externalPolicy.provenance.reference,
      externalPolicy.observedAt,
      "ready-notes",
      "ready-gateway",
      f.original.planDigest,
    ]) {
      expect(description).toContain(identity);
    }
    expect(
      publicApprovalDescription(
        { ...input, planDigest: f.current.operator!.planDigest },
        "prepare-app-hosted-runtime",
      ),
    ).toBeUndefined();
  });
  it.each(["approved-default", "unapproved-first", "unapproved-expired-replacement"] as const)(
    "keeps ordinary %s app planning on the full handler",
    async (planningCase) => {
      const f = fixture();
      f.record.operator!.plan.appTrustedSources = {
        gatewayPreview: { projectId: "project-gateway", from: "preview", to: "preview" },
      };
      f.record.operator!.plan.gatewayBindings!.trustedSources = {
        appPreview: { projectId: "project-notes", from: "preview", to: "preview" },
      };
      f.record.operator!.planDigest = operatorPlanDigest(f.record.operator!.plan);
      f.record.operator!.deliveredDeploymentId = "ready-notes";
      if (planningCase !== "approved-default") {
        f.record.operator!.plan = withExternallyManagedHostProtection(
          f.record.operator!.plan,
          externalPolicy,
        );
        f.record.operator!.planDigest = operatorPlanDigest(f.record.operator!.plan);
        f.record.approvedByCallId = "operator:unapproved-plan";
        f.record.operator!.receipts = [];
        delete f.record.operator!.approvalId;
        delete f.record.operator!.pendingEffectId;
        delete f.record.operator!.pendingEffectAttempt;
        delete f.record.operator!.deliveredDeploymentId;
        delete f.record.operator!.deliveryCandidates;
      }
      if (planningCase === "unapproved-expired-replacement") {
        f.record.operator!.plan.appDeliveryReplacement = f.intent;
        f.record.operator!.plan.retention.expiresAt = new Date(now - 1).toISOString();
        f.record.operator!.planDigest = operatorPlanDigest(f.record.operator!.plan);
      }
      const oldDigest = f.record.operator!.planDigest;
      let row = { record: f.record, revision: 1 };
      const context = {
        authority: f.record.operator!.plan.deploymentBoundary!.authority,
        target: f.record.request,
      };
      const store: HostedRuntimeJournalStore = {
        read: async () => structuredClone(row),
        reserve: async () => structuredClone(row),
        compareAndSet: async (input) => {
          if (input.expectedRevision !== row.revision) return undefined;
          row = {
            record: hostedRuntimeJournalRecordSchema.parse(input.record),
            revision: row.revision + 1,
          };
          return structuredClone(row);
        },
        reserveFenceGeneration: async () => {
          row.record.operator!.fenceGeneration = 1;
          row.revision++;
          return structuredClone(row);
        },
      };
      const ordinary = structuredClone(f.record.operator!.plan);
      if (planningCase === "unapproved-expired-replacement") {
        delete ordinary.appDeliveryReplacement;
        ordinary.retention.expiresAt = new Date(now + 86400000).toISOString();
        ordinary.delivery!.gitSha = "7".repeat(40);
      }
      const plan = vi.fn(async () => structuredClone(ordinary));
      const readGatewayAlias = vi.fn(async () => {
        throw new Error("ordinary first proposal must not read predecessor alias");
      });
      const deps: ProtectedHostedOperatorDependencies = {
        store,
        authorize: async () => context,
        assertAuthorized: async () => {},
        plan,
        ...(planningCase !== "approved-default"
          ? {
              readReadyDeliveryReplacementPlan: async () =>
                await readNativePreviewRecoveryPlan({
                  record: row.record,
                  policy: externalPolicy,
                  now,
                  readGatewayAlias,
                }),
            }
          : {}),
        readApproval: async (input) => ({ ...input, approved: true, approvalId: "approval-notes" }),
        withResourceLease: async (_input, run) => await run(async () => {}),
        reconcile: async () => ({ status: "absent" }),
        executeEffect: async (input) => {
          expect(input.plan.hostProtection).toBeUndefined();
          expect(input.plan.appTrustedSources).toEqual(f.record.operator!.plan.appTrustedSources);
          expect(input.plan.gatewayBindings!.trustedSources).toEqual(
            f.record.operator!.plan.gatewayBindings!.trustedSources,
          );
          if (input.effect.kind === "gateway-delivery")
            await input.checkpointGatewayDelivery!(
              [
                {
                  deploymentId: "default-gateway",
                  operationRef,
                  projectId: "project-gateway",
                  branch: "gateway/notes",
                  repoId: "repo-gateway",
                  readyState: "READY",
                  origin: "https://default-gateway.example.test",
                },
              ],
              "default-gateway",
            );
          return {
            effectId: input.effect.id,
            observedAt: new Date(now).toISOString(),
            resourceVersion: "default-owned-readback",
            ...(input.effect.kind === "access" ? { fenceGeneration: input.fenceGeneration } : {}),
          };
        },
        verify: async () => ({
          actors: 1,
          tenants: 1,
          releaseId: f.record.operator!.plan.release.id,
          artifactHash: f.record.operator!.plan.release.sha256,
          manifestSha256: f.record.operator!.plan.release.sha256,
          authenticatedBehavior: "unassessed",
        }),
        bindings: async () => ({}),
      };
      const handler = createProtectedHostedOperatorHandler(deps);
      const request = (body: Record<string, unknown>) =>
        new Request("https://operator.example.test/v1/runtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, selection: f.record.operator!.plan.selection }),
        });
      vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        expect(
          (await (await handler(request({ action: "plan", operation: "prepare" }))).json())
            .planDigest,
        ).toBe(operatorPlanDigest(ordinary));
        if (planningCase !== "approved-default") {
          expect(row.record.operator!.plan.hostProtection).toEqual(externalPolicy);
          expect(row.record.operator!.plan.appDeliveryReplacement).toBeUndefined();
          expect(row.record.operator!.retainedReadyDeliveryOperations).toBeUndefined();
          expect(plan).toHaveBeenCalledOnce();
          expect(readGatewayAlias).not.toHaveBeenCalled();
          return;
        }
        const result = await (
          await handler(
            request({
              action: "execute",
              callId: "approval-call-notes",
              operationRef,
              planDigest: oldDigest,
            }),
          )
        ).json();
        expect(result.status).toBe("prepared");
        expect(row.record.operator!.planDigest).toBe(oldDigest);
        expect(row.record.operator!.retainedReadyDeliveryOperations).toBeUndefined();
        expect(row.record.operator!.plan.appDeliveryReplacement).toBeUndefined();
        expect(plan).toHaveBeenCalled();
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
  it("freezes exact administrator evidence without mutating either old approval or unknown attempt", () => {
    const f = recoveryFixture();
    const original = structuredClone(f.current);
    expect(f.proposed).toBeDefined();
    expect(f.proposed.hostProtection).toEqual(externalPolicy);
    expect(f.proposed.appDeliveryReplacement?.predecessor).toMatchObject({
      appDeploymentId: "ready-notes",
      gatewayDeploymentId: "ready-gateway",
      planDigest: f.original.planDigest,
    });
    expect(f.proposed.appTrustedSources).toBeUndefined();
    expect(f.proposed.gatewayBindings?.trustedSources).toBeUndefined();
    expect(operatorPlanDigest(f.proposed)).not.toBe(f.current.operator!.planDigest);
    expect(f.current).toEqual(original);
  });
  it.each(["approved-attempt", "unapproved-proposal"] as const)(
    "lets expired saved %s reach ordinary planning without native reads",
    async (state) => {
      const f = recoveryFixture();
      const record = structuredClone(f.current);
      record.operator!.plan = f.proposed;
      record.operator!.planDigest = operatorPlanDigest(f.proposed);
      record.operator!.retainedReadyDeliveryOperations = [
        { approvedByCallId: f.current.approvedByCallId, operator: f.current.operator! },
      ];
      record.operator!.retainedRenewalOperations = [];
      if (state === "unapproved-proposal") {
        record.approvedByCallId = "operator:unapproved-plan";
        delete record.operator!.approvalId;
      }
      const readGatewayAlias = vi.fn(async () => "ready-gateway");
      const result = await readNativePreviewRecoveryPlan({
        record,
        policy: externalPolicy,
        now: Date.parse(f.proposed.retention.expiresAt) + 1,
        readGatewayAlias,
      });
      expect(result).toBeUndefined();
      expect(readGatewayAlias).not.toHaveBeenCalled();
    },
  );
  it.each([
    "reserved",
    "reserved-bindings",
    "reserved-gateway-bindings",
    "reserved-gateway-delivery",
    "missing-attempt",
    "unapproved",
    "no-marker",
    "legacy",
  ] as const)(
    "renews app delivery only with explicit approved replacement reservation (%s)",
    (state) => {
      const f = recoveryFixture();
      const record = structuredClone(f.current);
      const operator = record.operator!;
      operator.plan =
        state === "legacy"
          ? withExternallyManagedHostProtection(f.proposed, undefined)
          : f.proposed;
      if (state === "legacy") {
        const { hostProtection, appDeliveryReplacement, ...legacy } = operator.plan;
        void hostProtection;
        void appDeliveryReplacement;
        operator.plan = hostedOperatorPlanSchema.parse(legacy);
      }
      operator.planDigest = operatorPlanDigest(operator.plan);
      const pendingKind = state.startsWith("reserved-")
        ? state.slice("reserved-".length)
        : "delivery";
      const deliveryIndex = operator.plan.effects.findIndex(
        (effect) => effect.kind === pendingKind,
      );
      operator.pendingEffectId = operator.plan.effects[deliveryIndex].id;
      operator.pendingEffectAttempt = { id: attemptId };
      operator.receipts = operator.plan.effects.slice(0, deliveryIndex).map((effect) => ({
        effectId: effect.id,
        observedAt: new Date(now).toISOString(),
        resourceVersion: "reserved-owned-row",
      }));
      operator.retainedRenewalOperations = [];
      if (state === "missing-attempt") delete operator.pendingEffectAttempt;
      if (state === "unapproved") record.approvedByCallId = "operator:unapproved-plan";
      if (state === "no-marker") {
        delete operator.pendingEffectId;
        delete operator.pendingEffectAttempt;
      }
      const renewed = createRetentionRenewalPlan(
        record,
        Date.parse(operator.plan.retention.expiresAt) + 1,
      );
      expect(renewed !== undefined).toBe(state.startsWith("reserved"));
      if (renewed) {
        expect(renewed.hostProtection).toEqual(operator.plan.hostProtection);
        expect(renewed.appDeliveryReplacement).toEqual(operator.plan.appDeliveryReplacement);
        expect(renewed.effects).toEqual(operator.plan.effects);
        expect(renewed.appTrustedSources).toBeUndefined();
        expect(renewed.gatewayBindings?.trustedSources).toBeUndefined();
      }
    },
  );
  it.each(["team", "app", "gateway", "environment", "policy-write"])(
    "rejects inconsistent external policy %s",
    (change) => {
      const f = recoveryFixture();
      const plan = structuredClone(f.proposed);
      if (change === "team") plan.hostProtection!.teamId = "foreign-team";
      if (change === "app") plan.hostProtection!.appPreview.targetProjectId = "foreign-app";
      if (change === "gateway")
        plan.hostProtection!.gatewayPreview.sourceProjectId = "foreign-source";
      if (change === "environment")
        Object.assign(plan.hostProtection!.appPreview, { from: "production" });
      if (change === "policy-write")
        plan.appTrustedSources = {
          gatewayPreview: { projectId: "project-gateway", from: "preview", to: "preview" },
        };
      expect(hostedOperatorPlanSchema.safeParse(plan).success).toBe(false);
    },
  );
  it.each([
    "applied",
    "already-applied",
    "lost",
    "drift",
    "denied",
    "transient-hook",
    "expired-create-visible",
    "expired-create-missing",
    "expired-create-foreign",
  ] as const)(
    "requires new approval and preserves old alias uncertainty when the new alias is %s",
    async (outcome) => {
      const loseAlias = outcome === "lost";
      const loseCreate =
        outcome === "expired-create-visible" ||
        outcome === "expired-create-missing" ||
        outcome === "expired-create-foreign";
      let testNow = now;
      const f = recoveryFixture();
      let row = { record: hostedRuntimeJournalRecordSchema.parse(f.current), revision: 1 };
      const protectedBefore = structuredClone(row.record.privateState);
      const oldHistories = structuredClone(row.record.operator!.retainedRenewalOperations);
      const context = {
        authority: f.proposed.deploymentBoundary!.authority,
        target: f.current.request,
      };
      const store: HostedRuntimeJournalStore = {
        read: vi.fn(async () => structuredClone(row)),
        reserve: vi.fn(async () => structuredClone(row)),
        compareAndSet: vi.fn(async (input) => {
          if (input.expectedRevision !== row.revision) return undefined;
          row = {
            record: hostedRuntimeJournalRecordSchema.parse(input.record),
            revision: row.revision + 1,
          };
          return structuredClone(row);
        }),
        reserveFenceGeneration: vi.fn(async (input) => {
          if (input.expectedRevision !== row.revision) return undefined;
          row.record.operator!.fenceGeneration = 2;
          row.revision++;
          return structuredClone(row);
        }),
      };
      const raw: Record<string, Record<string, unknown>> = {};
      const metadata = (kind: string, op = f.original) => ({
        autograph_operator_effect: op.plan.effects.find((effect) => effect.kind === kind)!.id,
        autograph_operator_operation: op.operationRef,
        autograph_operator_plan: op.planDigest,
      });
      raw["ready-notes"] = {
        id: "ready-notes",
        projectId: "project-notes",
        ownerId: "team-notes",
        readyState: "READY",
        target: "staging",
        oidcTokenClaims: { environment: "preview" },
        url: "notes-immutable.example.test",
        gitSource: {
          ...f.original.plan.delivery,
          type: "github",
          ref: "feature/notes",
          sha: "1".repeat(40),
        },
        meta: metadata("delivery"),
      };
      raw["ready-gateway"] = {
        id: "ready-gateway",
        projectId: "project-gateway",
        ownerId: "team-notes",
        readyState: "READY",
        target: null,
        url: "gateway-immutable.example.test",
        gitSource: {
          ...f.original.plan.gatewayDelivery,
          type: "github",
          ref: "gateway/notes",
          sha: "2".repeat(40),
        },
        meta: metadata("gateway-delivery"),
      };
      let aliasTarget = "ready-gateway";
      let appBound = false;
      let gatewayBoundOrigin: string | undefined;
      let approved = false;
      let guardReadUnavailable = false;
      let failNextGuardRead = outcome === "transient-hook";
      const calls: { method: string; path: string; body?: Record<string, unknown> }[] = [];
      const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        expect(url.origin).toBe("https://api.vercel.com");
        const method = init?.method ?? "GET";
        const body = init?.body
          ? (JSON.parse(String(init.body)) as Record<string, unknown>)
          : undefined;
        calls.push({ method, path: url.pathname, body });
        if (url.pathname.startsWith("/v4/aliases/")) {
          if (guardReadUnavailable) throw new Error("synthetic transient alias guard GET failure");
          return Response.json({
            alias: "notes.example.test",
            projectId: "project-gateway",
            deploymentId: aliasTarget,
            redirect: null,
          });
        }
        if (url.pathname.startsWith("/v9/projects/")) {
          const projectId = url.pathname.split("/")[3];
          return Response.json({
            id: projectId,
            accountId: "team-notes",
            name: projectId,
            link: {
              type: "github",
              repoId: projectId === "project-notes" ? "repo-notes" : "repo-gateway",
            },
          });
        }
        if (url.pathname.startsWith("/v2/teams/"))
          return Response.json({ id: "team-notes", slug: "notes" });
        if (url.pathname === "/v7/deployments")
          return Response.json({
            deployments: Object.values(raw)
              .filter((value) => value.projectId === url.searchParams.get("projectId"))
              .map((value) => ({ uid: value.id, meta: value.meta })),
            pagination: { next: null },
          });
        if (url.pathname === "/v13/deployments" && method === "POST") {
          expect(approved).toBe(true);
          expect(body).not.toHaveProperty("target");
          const project = String(body!.project);
          const app = project === "project-notes";
          expect(app ? appBound : gatewayBoundOrigin === "https://fresh-notes.example.test").toBe(
            true,
          );
          const id = app ? "fresh-notes" : "fresh-gateway";
          const gitSource = body!.gitSource as Record<string, unknown>;
          raw[id] = {
            id,
            projectId: project,
            ownerId: "team-notes",
            readyState: "READY",
            target: null,
            url: `${id}.example.test`,
            meta: body!.meta,
            gitSource,
          };
          if (app && loseCreate) {
            if (outcome === "expired-create-missing") delete raw[id];
            if (outcome === "expired-create-foreign")
              raw[id].meta = { autograph_operator_plan: "9".repeat(64) };
            throw new Error("synthetic lost app create acknowledgement");
          }
          if (!app && outcome === "drift") aliasTarget = "unrelated-ready-gateway";
          if (!app && outcome === "already-applied") aliasTarget = id;
          return Response.json({ id });
        }
        if (url.pathname.startsWith("/v13/deployments/"))
          return outcome === "denied"
            ? new Response(null, { status: 403 })
            : Response.json(raw[url.pathname.split("/")[3]]);
        if (url.pathname.endsWith("/aliases") && method === "POST") {
          if (loseAlias) throw new Error("synthetic lost alias acknowledgement");
          aliasTarget = url.pathname.split("/")[3];
          return Response.json({});
        }
        return new Response(null, { status: 404 });
      }) as typeof fetch;
      const readCredential = vi.fn(async () => ({
        token: "synthetic-private-credential",
        binding: {
          active: true,
          installationId: context.target.installationId,
          scopeId: "team-notes",
          scopeType: "team" as const,
          slug: "notes",
          displayName: "Notes",
          plan: "hobby",
          updatedAt: new Date(now),
        },
      }));
      const native = createReadyReplacementNativeReader({
        context,
        assertCurrent: async () => {},
        readCredential,
        fetch: fetcher,
      });
      const app = createHostedOperatorDeploymentDelivery({
        readCredential,
        fetch: fetcher,
        assertAuthorized: async () => {},
        assertEnvironment: async () => {
          expect(appBound).toBe(true);
        },
        beforeCreate: async (input) => {
          expect(input.readyReplacement).toBeDefined();
          await native.verify(input.plan, input.readyReplacement!);
        },
      });
      const gateway = createHostedOperatorDeploymentDelivery({
        readCredential,
        fetch: fetcher,
        target: "gateway",
        assertAuthorized: async () => {},
        assertEnvironment: async () => {
          expect(gatewayBoundOrigin).toBe("https://fresh-notes.example.test");
        },
        beforeCreate: async (input) => await native.verify(input.plan, input.readyReplacement!),
        beforeAliasWrite: async (input, selected) => {
          guardReadUnavailable = failNextGuardRead;
          failNextGuardRead = false;
          try {
            return await native.aliasWriteAuthority(input.plan, selected.deploymentId);
          } finally {
            guardReadUnavailable = false;
          }
        },
      });
      const executed: string[] = [];
      let ordinaryPlan: typeof f.proposed | undefined;
      const ordinaryPlanning = vi.fn(async () => {
        if (!ordinaryPlan)
          throw new Error("fresh generic planning must not replace this pending proposal");
        return ordinaryPlan;
      });
      const deps: ProtectedHostedOperatorDependencies = {
        store,
        authorize: async () => context,
        assertAuthorized: async () => {},
        assertCanonicalOwner: async () => {},
        plan: ordinaryPlanning,
        now: () => testNow,
        readReadyDeliveryReplacementPlan: async () =>
          await readNativePreviewRecoveryPlan({
            record: row.record,
            policy: externalPolicy,
            now: testNow,
            readGatewayAlias: async (plan) => await native.readGatewayAlias(plan),
          }),
        verifyReadyDeliveryReplacement: async (_context, plan, predecessor) =>
          await native.verify(plan, predecessor),
        readApproval: async (input) => ({
          ...input,
          approved: input.callId !== "new-human-call" || approved,
          approvalId:
            input.callId === "approval-call-notes"
              ? "approval-notes"
              : input.callId === "approval-call-first"
                ? "approval-first-renewal"
                : input.callId === "approval-call-current"
                  ? "approval-current"
                  : "new-human-approval",
        }),
        withResourceLease: async (_input, run) => await run(async () => {}),
        reconcile: async () => ({ status: "absent" }),
        executeEffect: async (input) => {
          executed.push(input.effect.kind);
          if (input.effect.kind === "bindings") appBound = true;
          if (input.effect.kind === "gateway-bindings")
            gatewayBoundOrigin = input.deliveryCandidates?.find(
              (candidate) =>
                candidate.operationRef === input.operationRef && candidate.readyState === "READY",
            )?.origin;
          if (input.effect.kind === "delivery" || input.effect.kind === "gateway-delivery") {
            const delivery = input.effect.kind === "delivery" ? app : gateway;
            const result = await delivery.deliver({
              ...input,
              deliveryCandidates:
                input.effect.kind === "delivery"
                  ? input.deliveryCandidates
                  : input.gatewayDeliveryCandidates,
              checkpointDelivery: (input.effect.kind === "delivery"
                ? input.checkpointDelivery
                : input.checkpointGatewayDelivery)!,
            });
            if (result.status !== "applied") throw new Error("reconciliation required");
          }
          return {
            effectId: input.effect.id,
            observedAt: new Date(now).toISOString(),
            resourceVersion: "fresh-owned-observation",
            ...(input.effect.kind === "access" ? { fenceGeneration: input.fenceGeneration } : {}),
          };
        },
        verify: async () => ({
          actors: 1,
          tenants: 1,
          releaseId: f.proposed.release.id,
          artifactHash: f.proposed.release.sha256,
          manifestSha256: f.proposed.release.sha256,
          authenticatedBehavior: "unassessed",
        }),
        bindings: async () => ({}),
      };
      const handler = createProtectedHostedOperatorHandler(deps);
      const request = (body: Record<string, unknown>) =>
        new Request("https://operator.example.test/v1/runtime", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...body, selection: f.proposed.selection }),
        });
      vi.spyOn(Date, "now").mockImplementation(() => testNow);
      try {
        const planned = await handler(request({ action: "plan", operation: "prepare" }));
        const proposed = await planned.json();
        if (outcome === "denied") {
          expect(proposed.status).toBe("blocked");
          expect(calls.some((call) => call.method !== "GET")).toBe(false);
          expect(row.record.operator!.retainedReadyDeliveryOperations).toBeUndefined();
          expect(row.record.operator!.retainedRenewalOperations).toEqual(oldHistories);
          return;
        }
        expect(proposed.status).toBe("planned");
        expect(row.record.operator!.receipts).toEqual([]);
        expect(row.record.operator!.deliveryCandidates).toEqual([]);
        expect(row.record.operator!.gatewayDeliveryCandidates).toEqual([]);
        const archived = row.record.operator!.retainedReadyDeliveryOperations![0].operator;
        expect(archived.retainedRenewalOperations).toEqual(oldHistories);
        const readsAfterProposal = calls.filter((call) =>
          call.path.startsWith("/v4/aliases/"),
        ).length;
        const savedProposal = await (
          await handler(request({ action: "plan", operation: "prepare" }))
        ).json();
        expect(savedProposal.status).toBe("planned");
        expect(savedProposal.planDigest).toBe(proposed.planDigest);
        expect(savedProposal.operationRef).toBe(proposed.operationRef);
        expect(calls.filter((call) => call.path.startsWith("/v4/aliases/"))).toHaveLength(
          readsAfterProposal,
        );
        const execute = {
          action: "execute",
          callId: "new-human-call",
          operationRef: proposed.operationRef,
          planDigest: proposed.planDigest,
        };
        expect((await (await handler(request(execute))).json()).status).toBe("blocked");
        expect(calls.filter((call) => call.method === "POST")).toHaveLength(0);
        approved = true;
        const result = await (await handler(request(execute))).json();
        expect(result.status).toBe(
          outcome === "applied" || outcome === "already-applied" ? "prepared" : "blocked",
        );
        if (loseCreate) {
          const uncertain = structuredClone(row.record.operator!);
          expect(uncertain.pendingEffectId).toBe(
            uncertain.plan.effects.find((effect) => effect.kind === "delivery")!.id,
          );
          expect(uncertain.pendingEffectAttempt).toBeDefined();
          expect(uncertain.deliveryCandidates).toEqual([]);
          const callsBeforeRenewal = calls.length;
          testNow = Date.parse(uncertain.plan.retention.expiresAt) + 1000;
          expect(createRetentionRenewalPlan(row.record, testNow)).toBeDefined();
          const renewed = await (
            await handler(request({ action: "plan", operation: "prepare" }))
          ).json();
          expect(renewed.status).toBe("planned");
          expect(calls).toHaveLength(callsBeforeRenewal);
          expect(renewed.plan.hostProtection).toEqual(uncertain.plan.hostProtection);
          expect(renewed.plan.appDeliveryReplacement).toEqual(
            uncertain.plan.appDeliveryReplacement,
          );
          expect(renewed.plan.appTrustedSources).toBeUndefined();
          expect(renewed.plan.gatewayBindings.trustedSources).toBeUndefined();
          expect(renewed.plan.effects).toEqual(uncertain.plan.effects);
          expect(renewed.planDigest).not.toBe(uncertain.planDigest);
          expect(
            row.record.operator!.retainedReadyDeliveryOperations![0].operator
              .retainedRenewalOperations,
          ).toEqual(oldHistories);
          const provenance = retentionRenewalDeliveryProvenance(row.record);
          expect(provenance).toContainEqual(
            expect.objectContaining({
              planDigest: uncertain.planDigest,
              pendingEffectAttempt: uncertain.pendingEffectAttempt,
            }),
          );
          const resumed = await (
            await handler(request({ ...execute, planDigest: renewed.planDigest }))
          ).json();
          expect(resumed.status).toBe(
            outcome === "expired-create-visible" ? "prepared" : "blocked",
          );
          expect(
            calls.filter(
              (call) =>
                call.path === "/v13/deployments" &&
                call.method === "POST" &&
                call.body?.project === "project-notes",
            ),
          ).toHaveLength(1);
          if (outcome === "expired-create-visible") {
            expect(row.record.operator!.deliveredDeploymentId).toBe("fresh-notes");
            expect(row.record.operator!.deliveredGatewayDeploymentId).toBe("fresh-gateway");
          } else {
            expect(row.record.operator!.deliveredDeploymentId).toBeUndefined();
            expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
            const retried = await (
              await handler(request({ ...execute, planDigest: renewed.planDigest }))
            ).json();
            expect(retried.status).toBe("blocked");
            expect(calls.filter((call) => call.method === "POST")).toHaveLength(1);
          }
          expect(ordinaryPlanning).not.toHaveBeenCalled();
          expect(row.record.privateState).toEqual(protectedBefore);
          return;
        }
        expect(
          row.record.operator!.deliveryCandidates?.map((candidate) => candidate.deploymentId),
        ).toEqual(["fresh-notes"]);
        expect(
          row.record.operator!.gatewayDeliveryCandidates?.map(
            (candidate) => candidate.deploymentId,
          ),
        ).toEqual(["fresh-gateway"]);
        expect(
          calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
        ).toHaveLength(2);
        if (loseAlias) {
          expect(row.record.operator!.gatewayDeliveryCandidates![0].gatewayAliasAttempted).toBe(
            true,
          );
          await handler(request(execute));
          expect(
            calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
          ).toHaveLength(1);
        }
        if (outcome === "drift") {
          expect(
            row.record.operator!.gatewayDeliveryCandidates![0].gatewayAliasAttempted,
          ).toBeUndefined();
          expect(aliasTarget).toBe("unrelated-ready-gateway");
          expect(
            calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
          ).toHaveLength(0);
        }
        if (outcome === "transient-hook") {
          expect(
            row.record.operator!.gatewayDeliveryCandidates![0].gatewayAliasAttempted,
          ).toBeUndefined();
          expect(
            calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
          ).toHaveLength(0);
          const resumed = await (await handler(request(execute))).json();
          expect(resumed.status).toBe("prepared");
          expect(aliasTarget).toBe("fresh-gateway");
          expect(
            calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
          ).toHaveLength(1);
          expect(
            calls.filter((call) => call.path === "/v13/deployments" && call.method === "POST"),
          ).toHaveLength(2);
        }
        if (outcome === "already-applied")
          expect(
            calls.filter((call) => call.path.endsWith("/aliases") && call.method === "POST"),
          ).toHaveLength(0);
        expect(
          row.record.operator!.retainedReadyDeliveryOperations![0].operator
            .retainedRenewalOperations,
        ).toEqual(oldHistories);
        expect(row.record.privateState).toEqual(protectedBefore);
        expect(executed.indexOf("bindings")).toBeLessThan(executed.indexOf("delivery"));
        expect(executed.indexOf("gateway-bindings")).toBeGreaterThan(executed.indexOf("delivery"));
        expect(
          calls.some((call) => call.method === "PATCH" || call.path.includes("protection-bypass")),
        ).toBe(false);
        if (outcome === "applied") {
          const completedDigest = row.record.operator!.planDigest;
          const { appDeliveryReplacement, ...nextBase } = row.record.operator!.plan;
          void appDeliveryReplacement;
          ordinaryPlan = hostedOperatorPlanSchema.parse({
            ...nextBase,
            delivery: { ...nextBase.delivery, gitSha: "5".repeat(40) },
            release: { ...nextBase.release, id: "notes-revised-release", sha256: "6".repeat(64) },
          });
          const readsBeforeRevision = calls.filter((call) =>
            call.path.startsWith("/v4/aliases/"),
          ).length;
          const revised = await (
            await handler(request({ action: "plan", operation: "prepare" }))
          ).json();
          expect(calls.filter((call) => call.path.startsWith("/v4/aliases/"))).toHaveLength(
            readsBeforeRevision,
          );
          expect(revised.status).toBe("planned");
          expect(revised.plan.delivery.gitSha).toBe("5".repeat(40));
          expect(revised.plan.release.id).toBe("notes-revised-release");
          expect(revised.plan.appDeliveryReplacement).toBeUndefined();
          expect(revised.planDigest).not.toBe(completedDigest);
          expect(ordinaryPlanning).toHaveBeenCalledOnce();
        }
      } finally {
        vi.restoreAllMocks();
      }
    },
  );
});

describe("explicit READY delivery replacement", () => {
  it("names only observed predecessor identity in the intent", () => {
    const { intent } = fixture();
    expect(readyDeliveryReplacementIntentSchema.safeParse(intent).success).toBe(true);
    expect(
      readyDeliveryReplacementIntentSchema.safeParse({ ...intent, generation: "nonce" }).success,
    ).toBe(false);
    expect(
      readyDeliveryReplacementIntentSchema.safeParse({
        ...intent,
        predecessor: { ...intent.predecessor, appDeploymentId: "" },
      }).success,
    ).toBe(false);
  });

  it("accepts a same-source explicit replacement with arbitrary app and effect names", () => {
    const { record, intent, candidate } = fixture();
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(true);
    const resolved = resolveReadyDeliveryReplacementPredecessor(record, intent);
    expect(resolved?.approvedByCallId).toBe("approval-call-notes");
    expect(resolved?.originatingOperator.approvalId).toBe("approval-notes");
    expect(resolved?.appCandidate.deploymentId).toBe("ready-notes");
  });

  it("accepts changed source, branch, release, product roles and descriptions within the same ownership", () => {
    const { record, candidate } = fixture();
    candidate.delivery!.gitSha = "5".repeat(40);
    candidate.delivery!.branch = "feature/revised-notes";
    candidate.deploymentBoundary!.app.branch = candidate.delivery!.branch;
    candidate.selection.branch = candidate.delivery!.branch;
    candidate.gatewayDelivery!.gitSha = "6".repeat(40);
    candidate.gatewayDelivery!.branch = "gateway/revised-notes";
    candidate.deploymentBoundary!.gateway.branch = candidate.gatewayDelivery!.branch;
    candidate.publicGateway!.branch = candidate.gatewayDelivery!.branch;
    candidate.release = { artifactRef: "new-artifact", id: "release-2", sha256: "7".repeat(64) };
    candidate.access[0].roles = ["editor", "reviewer"];
    candidate.effects = candidate.effects.map((effect) => ({
      ...effect,
      id: `renamed-${effect.id}`,
      description: "Changed product intent",
    }));
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(true);
  });

  it("returns independent clones without changing READY state, pending attempts, receipts or history", () => {
    const { record, intent } = fixture();
    const before = structuredClone(record);
    const resolved = resolveReadyDeliveryReplacementPredecessor(record, intent)!;
    expect(resolved.snapshot).toEqual(before);
    expect(resolved.originatingOperator.pendingEffectAttempt).toEqual({ id: attemptId });
    resolved.snapshot.privateState!.encryptedToken = "changed-clone";
    resolved.originatingOperator.receipts.length = 0;
    resolved.appCandidate.readyState = "ERROR";
    expect(record).toEqual(before);
  });

  it("resolves the resumed renewal shape with absent current selected IDs and pending marker", () => {
    const { record, intent } = fixture();
    const original = record.operator!;
    original.plan.retention.expiresAt = "2026-10-18T12:00:00.000Z";
    original.planDigest = operatorPlanDigest(original.plan);
    intent.predecessor.planDigest = original.planDigest;
    const renewal = createRetentionRenewalPlan(record, now)!;
    expect(renewal).toBeDefined();
    record.operator = {
      mode: original.mode,
      operationRef,
      approvalId: "approval-renewed",
      plan: renewal,
      planDigest: operatorPlanDigest(renewal),
      receipts: [],
      retainedRenewalOperations: [
        { approvedByCallId: record.approvedByCallId, operator: structuredClone(original) },
      ],
    };
    record.approvedByCallId = "approval-call-renewed";
    const before = structuredClone(record);
    const resolved = resolveReadyDeliveryReplacementPredecessor(record, intent)!;
    expect(resolved?.originatingOperator.pendingEffectAttempt).toEqual({ id: attemptId });
    expect(resolved?.snapshot.operator?.pendingEffectId).toBeUndefined();
    expect(resolved?.snapshot.operator?.deliveredDeploymentId).toBeUndefined();
    expect(resolved?.snapshot.operator?.retainedRenewalOperations?.[0].operator).toEqual(original);
    expect(
      isReadyDeliveryReplacementSuccessor(
        record,
        { ...renewal, appDeliveryReplacement: intent },
        now,
      ),
    ).toBe(true);
    expect(record).toEqual(before);
  });

  it.each([
    "absent",
    "foreign-operation",
    "foreign-project",
    "foreign-branch",
    "foreign-repo",
    "not-ready",
  ])("rejects a named app candidate that is %s", (change) => {
    const { record, intent, candidate } = fixture();
    const app = record.operator!.deliveryCandidates![0];
    if (change === "absent") record.operator!.deliveryCandidates = [];
    if (change === "foreign-operation") app.operationRef = "c1d096d4-d743-46d7-a4db-c20e67ca65a4";
    if (change === "foreign-project") app.projectId = "foreign-project";
    if (change === "foreign-branch") app.branch = "foreign-branch";
    if (change === "foreign-repo") app.repoId = "foreign-repo";
    if (change === "not-ready") app.readyState = "BUILDING";
    expect(resolveReadyDeliveryReplacementPredecessor(record, intent)).toBeUndefined();
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
  });

  it.each([
    "missing-approval",
    "unapproved-call",
    "empty-call",
    "digest-mismatch",
    "named-digest-mismatch",
  ])("rejects invalid approval provenance: %s", (change) => {
    const { record, intent, candidate } = fixture();
    if (change === "missing-approval") delete record.operator!.approvalId;
    if (change === "unapproved-call") record.approvedByCallId = "operator:unapproved-plan";
    if (change === "empty-call") record.approvedByCallId = "";
    if (change === "digest-mismatch") record.operator!.planDigest = "f".repeat(64);
    if (change === "named-digest-mismatch") intent.predecessor.planDigest = "e".repeat(64);
    expect(resolveReadyDeliveryReplacementPredecessor(record, intent)).toBeUndefined();
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
  });

  it("rejects a live lease and allows the expired lease", () => {
    const { record, candidate } = fixture();
    record.leaseId = attemptId;
    record.leaseExpiresAt = "2026-10-19T12:01:00.000Z";
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
    record.leaseExpiresAt = "2026-10-19T11:59:00.000Z";
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(true);
    candidate.retention.expiresAt = "2026-10-19T11:59:00.000Z";
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
  });

  it.each([
    "action",
    "environment",
    "app",
    "session",
    "project",
    "database",
    "auth",
    "neon",
    "context",
    "authority",
    "team",
    "gateway",
  ])("rejects non-Preview or foreign ownership: %s", (change) => {
    const { record, candidate } = fixture();
    if (change === "action") candidate.action = "cleanup";
    if (change === "environment")
      (candidate.selection as { environment: string }).environment = "production";
    if (change === "app") candidate.selection.appId = "foreign-app";
    if (change === "session") candidate.selection.sessionId = "foreign-session";
    if (change === "project") candidate.selection.projectId = "foreign-project";
    if (change === "database") candidate.appDatabase.resourceId = "foreign-resource";
    if (change === "auth") candidate.authDatabase.resourceId = "foreign-auth";
    if (change === "neon") candidate.neon.branchId = "foreign-neon";
    if (change === "context") candidate.contextId = "foreign-context";
    if (change === "authority")
      candidate.deploymentBoundary!.authority.ownerUserId = "foreign-owner";
    if (change === "team") candidate.deploymentBoundary!.teamId = "foreign-team";
    if (change === "gateway") candidate.publicGateway!.origin = "https://foreign.example.test";
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
  });

  it("requires the optional Gateway in the same exact current or valid renewal origin", () => {
    const { record, intent } = fixture();
    intent.predecessor.gatewayDeploymentId = "ready-gateway";
    expect(resolveReadyDeliveryReplacementPredecessor(record, intent)).toBeUndefined();
    record.operator!.gatewayDeliveryCandidates = [
      {
        deploymentId: "ready-gateway",
        operationRef,
        projectId: "project-gateway",
        branch: "gateway/notes",
        repoId: "repo-gateway",
        readyState: "READY",
        origin: "https://gateway-immutable.example.test",
      },
    ];
    expect(
      resolveReadyDeliveryReplacementPredecessor(record, intent)?.gatewayCandidate?.deploymentId,
    ).toBe("ready-gateway");
    record.operator!.gatewayDeliveryCandidates[0].repoId = "foreign-repo";
    expect(resolveReadyDeliveryReplacementPredecessor(record, intent)).toBeUndefined();
  });

  it("does not adopt unrelated archived operators", () => {
    const { record, intent } = fixture();
    const archived = structuredClone(record.operator!);
    record.operator!.deliveryCandidates = [];
    record.operator!.retainedGatewayDeliveries = [
      { approvedByCallId: record.approvedByCallId, operator: archived },
    ];
    record.operator!.retainedRenewalOperations = [
      { approvedByCallId: record.approvedByCallId, operator: archived },
    ];
    record.operator!.plan.release.id = "different-approved-release";
    record.operator!.planDigest = operatorPlanDigest(record.operator!.plan);
    expect(resolveReadyDeliveryReplacementPredecessor(record, intent)).toBeUndefined();
  });

  it.each(["delivery", "gateway-delivery"] as const)(
    "blocks current unknown %s creation",
    (kind) => {
      const { record, candidate } = fixture();
      record.operator!.pendingEffectId = record.operator!.plan.effects.find(
        (effect) => effect.kind === kind,
      )!.id;
      record.operator!.receipts = record.operator!.receipts.filter(
        (receipt) => receipt.effectId !== record.operator!.pendingEffectId,
      );
      expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
    },
  );

  it("distinguishes uncertain alias assignment from a confirmed applied Gateway", () => {
    const { record, candidate } = fixture();
    record.operator!.gatewayDeliveryCandidates = [
      {
        deploymentId: "ready-gateway",
        operationRef,
        projectId: "project-gateway",
        branch: "gateway/notes",
        repoId: "repo-gateway",
        readyState: "READY",
        origin: "https://gateway-immutable.example.test",
        gatewayAliasAttempted: true,
      },
    ];
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(false);
    record.operator!.deliveredGatewayDeploymentId = "ready-gateway";
    record.operator!.receipts.push({
      effectId: "notes-effect-6",
      observedAt: "2026-10-19T11:00:00.000Z",
      resourceVersion: "gateway-confirmed",
    });
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(true);
  });

  it("does not treat a historical operation's alias attempt as current uncertainty", () => {
    const { record, candidate } = fixture();
    record.operator!.gatewayDeliveryCandidates = [
      {
        deploymentId: "historical-gateway",
        operationRef: "c1d096d4-d743-46d7-a4db-c20e67ca65a4",
        projectId: "project-gateway",
        branch: "gateway/notes",
        repoId: "repo-gateway",
        readyState: "READY",
        origin: "https://historical-gateway.example.test",
        gatewayAliasAttempted: true,
      },
    ];
    expect(isReadyDeliveryReplacementSuccessor(record, candidate, now)).toBe(true);
  });
});
