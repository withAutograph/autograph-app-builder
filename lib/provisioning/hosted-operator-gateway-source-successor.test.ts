import {
  createSharedHostProtectionSuccessorPlan,
  hasRetainedSharedHostProtectionIdentity,
  sharedHostProtectionDeliveryProvenance,
  isSharedHostProtectionDeliveryProvenance,
} from "./hosted-operator-shared-host-protection-successor";
/* oxlint-disable eslint/require-await -- Typed in-memory journal and provider callbacks intentionally resolve without external I/O. */
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { createHostedOperatorClient } from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const selection: OperatorSelection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview",
  projectId: "prj_fixture",
  sessionId: "session_fixture",
};
const ownerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session",
  authority,
  kind: "direct" as const,
  principal: { ...authority, scopes: ["autograph:send"] },
  sessionId: selection.sessionId,
};
const target = {
  ...selection,
  installationId: "icfg_fixture",
  scopeId: "team_fixture",
  scopeType: "team" as const,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "synthetic-reviewer", organizationId: "synthetic-org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "shared_auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "shared_auth_runtime",
  },
  contextId: "synthetic-context",
  cost: {
    class: "shared-recovery-group",
    description: "Approved disposable compute",
    owner: "Fixture owner",
  },
  deploymentBoundary: {
    app: {
      branch: selection.branch,
      deploymentId: "dpl_app",
      environment: "preview",
      projectId: selection.projectId,
    },
    authority,
    gateway: {
      branch: selection.branch,
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
      gatewayOrigin: "https://gateway-preview.example.test",
      jwksUrl: "https://gateway-preview.example.test/_platform/jwks.json",
      publicOrigin: "https://apps-preview.example.test",
    },
  },
  effects: [
    {
      description: "Verify selected resources and their roles",
      id: "resources",
      kind: "resources",
    },

    { description: "Install the selected checked release", id: "install", kind: "install" },
    { description: "Grant approved Auth app access after install", id: "access", kind: "access" },
    {
      description: "Bind restricted app and shared Auth credentials",
      id: "bind",
      kind: "bindings",
    },
  ],
  installer: { reference: "trusted-toolchain", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "explicit-owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "synthetic-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: "prj_gateway",
  },
  release: { artifactRef: "verified-artifact", id: "release_fixture", sha256: "b".repeat(64) },
  retention: {
    expiresAt: "2027-01-01T00:00:00.000Z",
    policy: "Retain while context consumers exist",
  },
  selection,
  version: 1,
});
const proof = {
  actors: 2,
  artifactHash: "c".repeat(64),
  authenticatedBehavior: "unassessed" as const,
  manifestSha256: plan.release.sha256,
  releaseId: plan.release.id,
  tenants: 2,
};
const appBoundary = {
  appId: selection.appId,
  mode: "protected-gateway-v1",
  runtime: {
    database: plan.appDatabase.database,
    environment: "hosted",
    hostname: plan.neon.endpoint,
    port: 5432,
    runtimeRole: plan.appDatabase.runtimeRole,
  },
  verification: {
    jwksUrl: plan.deploymentBoundary?.verification.jwksUrl,
    publicOrigin: plan.deploymentBoundary?.verification.publicOrigin,
  },
  version: 1,
};
const environment = {
  PLATFORM_APP_BOUNDARY: JSON.stringify(appBoundary),
  PLATFORM_JWKS_URL: "https://gateway-preview.example.test/_platform/jwks.json",
  PLATFORM_ORIGIN: "https://gateway-preview.example.test",
  PLATFORM_PUBLIC_ORIGIN: "https://apps-preview.example.test",
  SPEND_REVIEW_DATABASE_URL: `postgres://spend_runtime:synthetic-app@${plan.neon.endpoint}/spend?sslmode=verify-full`,
};

const fixture = () => {
  let row: HostedRuntimeJournalRow | undefined;
  let member = true;
  let approved = false;
  let uncertain = false;
  let fence = true;
  let nextFenceGeneration = 0;
  const applied = new Map<
    string,
    { effectId: string; fenceGeneration: number; observedAt: string; resourceVersion: string }
  >();
  const store: HostedRuntimeJournalStore = {
    async compareAndSet(input) {
      if (row?.revision !== input.expectedRevision) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- CAS failure is the explicit optional-row return contract.
        return undefined;
      }
      row = {
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
        revision: input.expectedRevision + 1,
      };
      return structuredClone(row);
    },
    async read() {
      return row ? structuredClone(row) : undefined;
    },
    async reserve(input) {
      row ??= {
        record: hostedRuntimeJournalRecordSchema.parse({
          approvedByCallId: input.approvedByCallId,
          kind: "app-runtime",
          operator: input.operator,
          request: input.target,
          status: "pending",
          step: "reserved",
          version: 1,
        }),
        revision: 1,
      };
      return structuredClone(row);
    },
    async reserveFenceGeneration(input) {
      if (row === undefined) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- The journal CAS reports no allocated row.
        return undefined;
      }
      if (
        row.revision !== input.expectedRevision ||
        row.record.leaseId !== input.leaseId ||
        row.record.operator?.operationRef !== input.operationRef ||
        row.record.operator.fenceGeneration !== undefined
      ) {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- A stale CAS must not allocate a generation.
        return undefined;
      }
      nextFenceGeneration += 1;
      const generation = nextFenceGeneration;
      row = {
        record: hostedRuntimeJournalRecordSchema.parse({
          ...row.record,
          operator: { ...row.record.operator, fenceGeneration: generation },
        }),
        revision: row.revision + 1,
      };
      return structuredClone(row);
    },
  };
  const deps: ProtectedHostedOperatorDependencies = {
    async assertAuthorized() {
      if (!member) {
        throw new HostedOperatorError("authorization_required");
      }
    },
    async authorize(request, selected) {
      if (
        request.headers.get("authorization") !== "Bearer fixture-service-identity" ||
        request.headers.get("x-vercel-trusted-oidc-idp-token") !== "fixture-service-identity" ||
        selected.sessionId !== selection.sessionId
      ) {
        throw new HostedOperatorError("authorization_required");
      }
      return { authority, target };
    },
    async bindings() {
      return environment;
    },
    executeEffect: vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(async (input) => {
      await input.assertCurrent();
      await input.checkpoint({
        encryptedToken: "ciphertext",
        keyVersion: "key-v1",
        tokenIv: "iv",
        tokenTag: "tag",
      });
      const receipt = {
        effectId: input.effect.id,
        fenceGeneration: input.fenceGeneration,
        observedAt: new Date().toISOString(),
        resourceVersion: "provider-observed-v1",
      };
      applied.set(input.effect.id, receipt);
      return receipt;
    }),
    plan: vi.fn(async () => plan),
    async readApproval(input) {
      return approved
        ? {
            action: input.action,
            approvalId: "durable-human-decision",
            approved: true,
            callId: input.callId,
            planDigest: input.planDigest,
          }
        : null;
    },
    async reconcile(input) {
      if (uncertain) {
        return { status: "unknown" };
      }
      const receipt = applied.get(input.effect.id);
      return receipt ? { receipt, status: "applied" } : { status: "absent" };
    },
    store,
    async verify() {
      return proof;
    },
    async withResourceLease(_input, run) {
      return await run(async () => {
        if (!fence) {
          throw new HostedOperatorError("operation_in_progress");
        }
      });
    },
  };
  const handler = createProtectedHostedOperatorHandler(deps);
  const client = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async (url, init) =>
      await handler(new Request(url instanceof Request ? url.url : url, init)),
    ownerContext,
    token: async () => "fixture-service-identity",
  });
  return {
    applied,
    approve() {
      approved = true;
    },
    client,
    deps,
    handler,
    known() {
      uncertain = false;
    },
    loseFence() {
      fence = false;
    },
    revoke() {
      member = false;
    },
    get row() {
      return row;
    },
    set row(value) {
      row = value;
    },
    unknown() {
      uncertain = true;
    },
  };
};
const prepared = async (f: ReturnType<typeof fixture>) => {
  const planned = await f.client.request({ action: "plan", operation: "prepare", selection });
  expect(planned.status).toBe("planned");
  return {
    action: "execute" as const,
    callId: "actual-eve-call",
    operationRef: z.uuid().parse(planned.operationRef),
    planDigest: z.string().parse(planned.planDigest),
    selection,
  };
};

const adoptedGatewayPlan = () => {
  const sourceOperation = "b209b89b-0bad-4a60-820f-4e29d5e5a4cc";
  const keys = [
    "AUTH_DATABASE_RESOURCE",
    "PLATFORM_AUTH_DATABASE_URL",
    "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
    "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
    "PLATFORM_GATEWAY_PROJECT_BINDINGS",
  ] as const;
  const gatewayEnvironment = keys.map((key) => ({
    branch: selection.branch,
    comment: `App Builder protected operator ${sourceOperation}`,
    id: `env_${key}`,
    key,
    operationRef: sourceOperation,
    projectId: "prj_gateway",
    target: ["preview"],
    type: "encrypted",
    valueSha256: "d".repeat(64),
  }));
  return hostedOperatorPlanSchema.parse({
    ...plan,
    authAdoption: {
      gatewayEnvironment,
      kind: "owned-journal-auth-v1",
      resource: {
        authDatabase: plan.authDatabase,
        branchId: plan.neon.branchId,
        endpoint: plan.neon.endpoint,
        endpointId: "ep-fixture",
        projectId: plan.neon.projectId,
      },
      source: {
        checkpointSha256: "d".repeat(64),
        journalDigest: "e".repeat(64),
        operationRef: sourceOperation,
        planDigest: "f".repeat(64),
        selection: { ...selection, appId: "source-app" },
      },
    },
    authSchema: {
      artifactRef: "auth-plan",
      installer: plan.installer,
      planDigest: "a".repeat(64),
      targetDigest: "b".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    effects: [
      {
        description: "Observe adopted Auth",
        id: "auth-resources",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "Prepare independent app",
        id: "app-resources",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
      ...plan.effects.filter((effect) => effect.kind !== "resources"),
      { description: "Bind shared Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://auth-preview.example.test",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [selection.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload: {
        audience: "https://vercel.com",
        environment: "preview",
        issuer: "https://oidc.vercel.com/team_fixture",
        ownerId: "team_fixture",
        projectId: "prj_gateway",
        subject: "fixture-gateway",
      },
    },
    resourcesInstaller: plan.installer,
  });
};

describe("Gateway source repair", () => {
  const failedGateway = async () => {
    const f = fixture();
    const { authAdoption, ...base } = adoptedGatewayPlan();
    void authAdoption;
    const bootstrapPlan = hostedOperatorPlanSchema.parse({
      ...base,
      access: [],
      stage: "auth-bootstrap",
      resourcesInstaller: { reference: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) },
      effects: [
        {
          description: "Prepare Auth",
          id: "auth-resources",
          kind: "resources",
          resourceId: plan.authDatabase.resourceId,
        },
        {
          description: "Prepare app",
          id: "app-resources",
          kind: "resources",
          resourceId: plan.appDatabase.resourceId,
        },
        { description: "Install Auth", id: "auth-schema", kind: "install" },
        { description: "Bind Gateway", id: "gateway-bindings", kind: "gateway-bindings" },
        { description: "Deliver Gateway", id: "gateway-delivery", kind: "gateway-delivery" },
      ],
      gatewayDelivery: {
        branch: selection.branch,
        gitSha: "1".repeat(40),
        projectId: "prj_gateway",
        repoId: "gateway-repo",
      },
    });
    f.deps.plan = async () => bootstrapPlan;
    const original = await prepared(f);
    const execute = f.deps.executeEffect;
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.effect.kind === "gateway-bindings") {
          await input.checkpointGatewayEnvironment?.(
            [
              "AUTH_DATABASE_RESOURCE",
              "PLATFORM_AUTH_DATABASE_URL",
              "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
              "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
              "PLATFORM_GATEWAY_PROJECT_BINDINGS",
            ].map((key) => ({
              branch: selection.branch,
              comment: `App Builder protected operator ${input.operationRef}`,
              gitBranch: null,
              id: `owned_${key}`,
              key,
              operationRef: input.operationRef,
              projectId: "prj_gateway",
              valueSha256: "9".repeat(64),
            })),
          );
        }
        if (input.effect.kind === "gateway-delivery") {
          await input.checkpointGatewayDelivery?.([
            {
              branch: selection.branch,
              deploymentId: "failed-native-gateway",
              operationRef: input.operationRef,
              origin: "https://failed-gateway.example.test",
              projectId: "prj_gateway",
              readyState: "ERROR",
              repoId: "gateway-repo",
            },
          ]);
          throw new HostedOperatorError("operator_unavailable");
        }
        return await execute(input);
      },
    );
    f.approve();
    expect(await f.client.request(original)).toMatchObject({ status: "blocked" });
    expect(f.row?.record.operator?.pendingEffectId).toBe("gateway-delivery");
    const previous = f.row;
    if (previous?.record.operator === undefined) {
      throw new Error("Missing failed Gateway journal");
    }
    const repaired = hostedOperatorPlanSchema.parse({
      ...bootstrapPlan,
      gatewayDelivery: { ...bootstrapPlan.gatewayDelivery, gitSha: "2".repeat(40) },
    });
    f.deps.plan = async () => repaired;
    return { f, original, previous, repaired, execute };
  };

  it("retains completed setup and original authority, then executes only delivery after normal approval", async () => {
    const { f, original, previous, repaired, execute } = await failedGateway();
    const { readApproval } = f.deps;
    f.deps.readApproval = async (input) =>
      input.planDigest === original.planDigest ? await readApproval(input) : null;
    const successor = { ...(await prepared(f)), callId: "successor-eve-call" };
    expect(successor.operationRef).not.toBe(original.operationRef);
    expect(successor.planDigest).toBe(operatorPlanDigest(repaired));
    expect(f.row?.record).toMatchObject({
      approvedByCallId: "operator:unapproved-plan",
      privateState: previous.record.privateState,
      operator: {
        receipts: previous.record.operator?.receipts,
        gatewayEnvironment: previous.record.operator?.gatewayEnvironment,
        gatewayDeliveryCandidates: [
          { deploymentId: "failed-native-gateway", operationRef: original.operationRef },
        ],
        retainedGatewayDeliveries: [
          {
            approvedByCallId: original.callId,
            operator: {
              operationRef: original.operationRef,
              plan: previous.record.operator?.plan,
              planDigest: original.planDigest,
              approvalId: "durable-human-decision",
              pendingEffectId: "gateway-delivery",
            },
          },
        ],
      },
    });
    expect(f.row?.record.operator?.pendingEffectAttempt).toBeUndefined();
    expect(f.row?.record.operator?.deliveredGatewayDeploymentId).toBeUndefined();
    const priorCalls = vi.mocked(f.deps.executeEffect).mock.calls.length;
    expect(await f.client.request(successor)).toMatchObject({ code: "authorization_required" });
    expect(vi.mocked(f.deps.executeEffect).mock.calls).toHaveLength(priorCalls);
    expect(await f.client.request(original)).toMatchObject({ code: "resource_mismatch" });
    f.deps.readApproval = readApproval;
    const deliveredEffects: string[] = [];
    f.deps.executeEffect = async (input) => {
      deliveredEffects.push(input.effect.kind);
      await input.checkpointGatewayDelivery?.(
        [
          {
            branch: selection.branch,
            deploymentId: "repaired-native-gateway",
            operationRef: input.operationRef,
            origin: "https://repaired-gateway.example.test",
            projectId: "prj_gateway",
            readyState: "READY",
            repoId: "gateway-repo",
          },
        ],
        "repaired-native-gateway",
      );
      return await execute(input);
    };
    f.deps.verifyAuthReadiness = async () => ({
      assetSha256: "1".repeat(64),
      catalogFingerprint: "2".repeat(64),
      database: plan.authDatabase.database,
      observedAt: new Date().toISOString(),
      runtimeRole: plan.authDatabase.runtimeRole,
      targetDigest: repaired.authSchema?.targetDigest ?? "",
    });
    expect(await f.client.request(successor)).toMatchObject({ status: "auth-schema-prepared" });
    expect(deliveredEffects).toEqual(["gateway-delivery"]);
    expect(f.row?.record.operator?.gatewayDeliveryCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ operationRef: original.operationRef, readyState: "ERROR" }),
        expect.objectContaining({ operationRef: successor.operationRef, readyState: "READY" }),
      ]),
    );
  });

  it.each(["BUILDING", "QUEUED", "UNKNOWN"])(
    "does not turn stale create-only %s metadata into a recovery barrier",
    async (readyState) => {
      const { f } = await failedGateway();
      const { row } = f;
      if (row?.record.operator?.gatewayDeliveryCandidates?.[0] === undefined) {
        throw new Error("Missing saved Gateway candidate");
      }
      row.record.operator.gatewayDeliveryCandidates[0].readyState = readyState;
      row.record.leaseId = "9377fa61-3008-41d1-9c36-b34ba9bb2d45";
      row.record.leaseExpiresAt = "2020-01-01T00:00:00.000Z";
      f.row = row;
      const successor = await prepared(f);
      expect(f.row?.record.operator?.operationRef).toBe(successor.operationRef);
      expect(f.row?.record.leaseId).toBeUndefined();
      expect(f.row?.record.leaseExpiresAt).toBeUndefined();
    },
  );

  it.each(["unknown-create", "prior-pin"])(
    "retains %s provenance without treating it as successor readiness",
    async (state) => {
      const { f, original } = await failedGateway();
      const { row } = f;
      if (row?.record.operator?.gatewayDeliveryCandidates?.[0] === undefined) {
        throw new Error("Missing saved Gateway candidate");
      }
      if (state === "unknown-create") {
        delete row.record.operator.gatewayDeliveryCandidates;
      } else {
        row.record.operator.gatewayDeliveryCandidates[0].readyState = "READY";
        row.record.operator.deliveredGatewayDeploymentId = "failed-native-gateway";
      }
      f.row = row;
      const successor = await prepared(f);
      expect(successor.operationRef).not.toBe(original.operationRef);
      expect(f.row?.record.operator?.deliveredGatewayDeploymentId).toBeUndefined();
      expect(f.row?.record.operator?.retainedGatewayDeliveries?.[0].operator.operationRef).toBe(
        original.operationRef,
      );
    },
  );

  it.each(["alias", "lease", "other-effect", "incomplete-setup", "changed-target"])(
    "preserves the original operation when %s prevents a source-only successor",
    async (reason) => {
      const { f, original, repaired } = await failedGateway();
      const { row } = f;
      if (row?.record.operator?.gatewayDeliveryCandidates?.[0] === undefined) {
        throw new Error("Missing saved Gateway candidate");
      }
      if (reason === "alias") {
        row.record.operator.gatewayDeliveryCandidates[0].gatewayAliasAttempted = true;
      } else if (reason === "lease") {
        row.record.leaseId = "9377fa61-3008-41d1-9c36-b34ba9bb2d45";
        row.record.leaseExpiresAt = "2099-01-01T00:00:00.000Z";
      } else if (reason === "other-effect") {
        row.record.operator.pendingEffectId = "auth-schema";
      } else if (reason === "incomplete-setup") {
        row.record.operator.receipts = row.record.operator.receipts.filter(
          (receipt) => receipt.effectId !== "gateway-bindings",
        );
      } else {
        f.deps.plan = async () =>
          hostedOperatorPlanSchema.parse({
            ...repaired,
            appDatabase: { ...repaired.appDatabase, database: "another_app" },
          });
      }
      f.row = row;
      expect(
        await f.client.request({ action: "plan", operation: "prepare", selection }),
      ).toMatchObject({ status: "blocked", code: "operation_in_progress" });
      expect(f.row?.record.operator?.operationRef).toBe(original.operationRef);
      expect(f.row?.record.operator?.planDigest).toBe(original.planDigest);
    },
  );
});

describe("shared host protection plan successor", () => {
  const pendingProtection = async () => {
    const f = fixture();
    const { authAdoption, ...base } = adoptedGatewayPlan();
    void authAdoption;
    const originalPlan = hostedOperatorPlanSchema.parse({
      ...base,
      access: [],
      stage: "auth-bootstrap",
      effects: [
        {
          id: "auth-resources",
          kind: "resources",
          description: "Prepare Auth",
          resourceId: plan.authDatabase.resourceId,
        },
        {
          id: "app-resources",
          kind: "resources",
          description: "Prepare app",
          resourceId: plan.appDatabase.resourceId,
        },
        { id: "auth-schema", kind: "install", description: "Install Auth" },
        {
          id: "gateway-bindings",
          kind: "gateway-bindings",
          description: "Bind Gateway and approved protection",
        },
        { id: "gateway-delivery", kind: "gateway-delivery", description: "Deliver Gateway" },
      ],
      gatewayBindings: {
        ...base.gatewayBindings,
        trustedSources: {
          builderProduction: { projectId: "builder", from: "production", to: "preview" },
          operatorPreview: { projectId: "operator", from: "preview", to: "preview" },
        },
      },
      gatewayDelivery: {
        branch: selection.branch,
        projectId: "prj_gateway",
        repoId: "gateway-repo",
        gitSha: "1".repeat(40),
      },
    });
    f.deps.plan = async () => originalPlan;
    const original = await prepared(f);
    const execute = f.deps.executeEffect;
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.effect.kind === "gateway-bindings") {
          throw new HostedOperatorError("operator_unavailable");
        }
        return await execute(input);
      },
    );
    f.approve();
    expect(await f.client.request(original)).toMatchObject({ status: "blocked" });
    expect(f.row?.record.operator?.pendingEffectId).toBe("gateway-bindings");
    const previous = f.row;
    if (previous?.record.operator === undefined) {
      throw new Error("Missing pending protection");
    }
    const successorPlan = hostedOperatorPlanSchema.parse({
      ...originalPlan,
      gatewayBindings: { ...originalPlan.gatewayBindings, trustedSources: undefined },
      effects: originalPlan.effects.map((effect) =>
        effect.kind === "gateway-bindings"
          ? { ...effect, description: "Bind shared Gateway environment" }
          : effect,
      ),
    });
    f.deps.plan = async () => successorPlan;
    return { f, original, originalPlan, previous, successorPlan, execute };
  };

  it("derives only the frozen bootstrap narrowing before fresh app planning", async () => {
    const { previous, originalPlan } = await pendingProtection();
    const now = Date.now();
    const candidate = createSharedHostProtectionSuccessorPlan(previous.record, now);
    expect(candidate).toEqual({
      ...originalPlan,
      gatewayBindings: { ...originalPlan.gatewayBindings, trustedSources: undefined },
      retention: {
        ...originalPlan.retention,
        expiresAt: new Date(now + 24 * 60 * 60 * 1000).toISOString(),
      },
    });
    expect(previous.record.operator?.plan.gatewayBindings?.trustedSources).toBeDefined();
    expect(candidate?.stage).toBe("auth-bootstrap");
    expect(
      createSharedHostProtectionSuccessorPlan(
        {
          ...previous.record,
          leaseId: "active",
          leaseExpiresAt: new Date(now + 1000).toISOString(),
        },
        now,
      ),
    ).toBeUndefined();
  });

  it("recognizes consumed identity only through the exact approved narrowing ancestry", async () => {
    const { f, previous } = await pendingProtection();
    const original = previous.record.operator;
    const candidate = createSharedHostProtectionSuccessorPlan(previous.record, Date.now());
    if (original === undefined || candidate === undefined) {
      throw new Error("Missing frozen bootstrap prerequisite");
    }
    const { gatewayBindings, deploymentBoundary } = original.plan;
    if (gatewayBindings === undefined || deploymentBoundary === undefined) {
      throw new Error("Missing frozen identity origins");
    }
    const link = {
      audience: "https://operator.example",
      authResourceId: original.plan.authDatabase.resourceId,
      bootstrapPlanDigest: original.planDigest,
      browserOrigin: gatewayBindings.authBrowserOrigin,
      consumedAt: new Date().toISOString(),
      endpointOrigin: deploymentBoundary.verification.gatewayOrigin,
      expiresAt: new Date().toISOString(),
      issuer: deploymentBoundary.verification.publicOrigin,
      nonceSha256: "a".repeat(64),
      organizationId: null,
      ownerSessionId: selection.sessionId,
      proofRef: "retained-proof",
      proofSha256: "b".repeat(64),
    };
    const record = {
      ...previous.record,
      operator: {
        ...original,
        approvalId: "approved-narrowing",
        authPreparation: {
          assetSha256: "1".repeat(64),
          catalogFingerprint: "2".repeat(64),
          database: original.plan.authDatabase.database,
          runtimeRole: original.plan.authDatabase.runtimeRole,
          targetDigest: "b".repeat(64),
          observedAt: new Date().toISOString(),
        },
        identityLink: link,
        plan: candidate,
        planDigest: operatorPlanDigest(candidate),
        retainedGatewayDeliveries: [
          {
            approvedByCallId: previous.record.approvedByCallId,
            operator: { ...original, identityLink: link },
          },
        ],
      },
    };
    expect(hasRetainedSharedHostProtectionIdentity(record)).toBe(true);
    f.row = { ...previous, record: hostedRuntimeJournalRecordSchema.parse(record) };
    const statusRequest = {
      action: "status" as const,
      selection,
      operationRef: original.operationRef,
    };
    expect(await f.client.request(statusRequest)).toMatchObject({ status: "auth-schema-prepared" });
    f.row = {
      ...previous,
      record: {
        ...record,
        leaseId: original.operationRef,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        operator: {
          ...record.operator,
          pendingEffectId: undefined,
          pendingEffectAttempt: undefined,
          receipts: candidate.effects.map((effect) => ({
            effectId: effect.id,
            observedAt: new Date().toISOString(),
            resourceVersion: "observed",
          })),
        },
      },
    };
    expect(await f.client.request(statusRequest)).toMatchObject({ status: "prepared" });
    expect(record.operator.identityLink.bootstrapPlanDigest).toBe(original.planDigest);
    expect(
      hasRetainedSharedHostProtectionIdentity({
        ...record,
        operator: { ...record.operator, retainedGatewayDeliveries: [] },
      }),
    ).toBe(false);
    expect(
      hasRetainedSharedHostProtectionIdentity({
        ...record,
        operator: { ...record.operator, operationRef: "different-operation" },
      }),
    ).toBe(false);
    const changed = { ...candidate, contextId: "changed-app-context" };
    expect(
      hasRetainedSharedHostProtectionIdentity({
        ...record,
        operator: { ...record.operator, plan: changed, planDigest: operatorPlanDigest(changed) },
      }),
    ).toBe(false);
  });

  it("requires a new approval and preserves pending work until normal fenced reconciliation applies", async () => {
    const { f, original, previous, successorPlan, execute } = await pendingProtection();
    const { readApproval } = f.deps;
    f.deps.readApproval = async (input) =>
      input.planDigest === original.planDigest ? await readApproval(input) : null;
    const successor = { ...(await prepared(f)), callId: "successor-approval" };
    expect(successor.operationRef).toBe(original.operationRef);
    expect(successor.planDigest).toBe(operatorPlanDigest(successorPlan));
    expect(successor.planDigest).not.toBe(original.planDigest);
    expect(f.row?.record).toMatchObject({
      approvedByCallId: "operator:unapproved-plan",
      privateState: previous.record.privateState,
      operator: {
        receipts: previous.record.operator?.receipts,
        pendingEffectId: "gateway-bindings",
        pendingEffectAttempt: previous.record.operator?.pendingEffectAttempt,
        retainedGatewayDeliveries: [
          { approvedByCallId: original.callId, operator: previous.record.operator },
        ],
      },
    });
    expect(f.row?.record.operator?.approvalId).toBeUndefined();
    await expect(f.client.request(successor)).resolves.toMatchObject({
      code: "authorization_required",
    });
    f.deps.readApproval = readApproval;
    const { reconcile: originalReconcile } = f.deps;
    const reconcile = vi.spyOn(f.deps, "reconcile");
    f.unknown();
    expect(await f.client.request(successor)).toMatchObject({ code: "reconciliation_required" });
    expect(f.row?.record.operator?.pendingEffectAttempt).toEqual(
      previous.record.operator?.pendingEffectAttempt,
    );
    expect(f.row?.record.operator?.pendingEffectId).toBe("gateway-bindings");
    expect(reconcile).toHaveBeenCalledWith(
      expect.objectContaining({ plan: successorPlan, operationRef: original.operationRef }),
    );
    f.known();
    reconcile.mockImplementation(async (input) =>
      input.effect.kind === "gateway-bindings"
        ? {
            status: "applied",
            receipt: {
              effectId: input.effect.id,
              observedAt: new Date().toISOString(),
              resourceVersion: "fresh-owned-environment",
            },
          }
        : await originalReconcile(input),
    );
    const executed: string[] = [];
    f.deps.executeEffect = async (input) => {
      executed.push(input.effect.kind);
      if (input.effect.kind === "gateway-delivery") {
        expect(input.gatewayDeliveryProvenance).toEqual([
          {
            operationRef: original.operationRef,
            plan: previous.record.operator?.plan,
            planDigest: original.planDigest,
            approvalId: previous.record.operator?.approvalId,
            approvedByCallId: previous.record.approvedByCallId,
          },
        ]);
      }
      return await execute(input);
    };
    f.deps.verifyAuthReadiness = async () => ({
      assetSha256: "1".repeat(64),
      catalogFingerprint: "2".repeat(64),
      database: plan.authDatabase.database,
      runtimeRole: plan.authDatabase.runtimeRole,
      targetDigest: z.string().parse(successorPlan.authSchema?.targetDigest),
      observedAt: new Date().toISOString(),
    });
    expect(await f.client.request(successor)).toMatchObject({ status: "auth-schema-prepared" });
    expect(executed).toEqual(["gateway-delivery"]);
    expect(f.row?.record.operator?.pendingEffectId).toBeUndefined();
    expect(f.row?.record.operator?.pendingEffectAttempt).toBeUndefined();
  });

  it("narrows only unchanged delivery authority while preserving unresolved alias history", async () => {
    const { f, original, previous, successorPlan } = await pendingProtection();
    const prior = previous.record.operator;
    if (prior === undefined) {
      throw new Error("Missing pending protection");
    }
    const uncertain = {
      branch: selection.branch,
      deploymentId: "uncertain",
      operationRef: original.operationRef,
      origin: "https://uncertain-gateway.example",
      projectId: "prj_gateway",
      repoId: "gateway-repo",
      readyState: "READY",
      gatewayAliasAttempted: true,
    };
    prior.gatewayDeliveryCandidates = [uncertain];
    f.row = previous;
    const narrowed = await prepared(f);
    expect(narrowed.operationRef).toBe(original.operationRef);
    expect(narrowed.planDigest).toBe(operatorPlanDigest(successorPlan));
    expect(f.row?.record.operator?.gatewayDeliveryCandidates).toEqual([uncertain]);
    expect(f.row?.record.operator?.receipts).toEqual(prior.receipts);
    expect(f.row?.record.operator?.pendingEffectAttempt).toEqual(prior.pendingEffectAttempt);
    expect(f.row?.record.operator?.pendingEffectId).toBe(prior.pendingEffectId);
    const current = f.row;
    if (current?.record.operator === undefined) {
      throw new Error("Missing narrowed protection");
    }
    expect(sharedHostProtectionDeliveryProvenance(current.record)).toEqual([]);
    const approvedRecord = {
      ...current.record,
      approvedByCallId: "narrowed-approval",
      operator: { ...current.record.operator, approvalId: "narrowed-human-decision" },
    };
    const provenance = sharedHostProtectionDeliveryProvenance(approvedRecord);
    expect(provenance).toEqual([
      {
        operationRef: prior.operationRef,
        plan: prior.plan,
        planDigest: prior.planDigest,
        approvalId: prior.approvalId,
        approvedByCallId: previous.record.approvedByCallId,
      },
    ]);
    const [originalProvenance] = provenance;
    if (originalProvenance === undefined) {
      throw new Error("Missing approved lineage");
    }
    expect(
      isSharedHostProtectionDeliveryProvenance(
        originalProvenance,
        successorPlan,
        original.operationRef,
      ),
    ).toBe(true);
    expect(
      isSharedHostProtectionDeliveryProvenance(
        { ...originalProvenance, planDigest: "0".repeat(64) },
        successorPlan,
        original.operationRef,
      ),
    ).toBe(false);
    expect(
      isSharedHostProtectionDeliveryProvenance(
        originalProvenance,
        successorPlan,
        "different-operation",
      ),
    ).toBe(false);
    const changedDelivery = hostedOperatorPlanSchema.parse({
      ...successorPlan,
      gatewayDelivery: { ...successorPlan.gatewayDelivery, gitSha: "2".repeat(40) },
    });
    expect(
      isSharedHostProtectionDeliveryProvenance(
        originalProvenance,
        changedDelivery,
        original.operationRef,
      ),
    ).toBe(false);
    expect(
      isSharedHostProtectionDeliveryProvenance(
        { ...originalProvenance, approvedByCallId: "operator:unapproved-plan" },
        successorPlan,
        original.operationRef,
      ),
    ).toBe(false);
  });

  it.each(["resource", "release", "other-effect", "live-lease", "approval"])(
    "does not broaden partial replacement for %s",
    async (change) => {
      const { f, original, successorPlan } = await pendingProtection();
      const before = f.row;
      if (before?.record.operator === undefined) {
        throw new Error("Missing pending protection");
      }
      if (change === "resource") {
        f.deps.plan = async () => ({ ...successorPlan, contextId: "other-resource" });
      }
      if (change === "release") {
        f.deps.plan = async () => ({
          ...successorPlan,
          release: { ...successorPlan.release, sha256: "c".repeat(64) },
        });
      }
      if (change === "other-effect") {
        before.record.operator.pendingEffectId = "auth-schema";
      }
      if (change === "live-lease") {
        before.record.leaseId = "active-lease";
        before.record.leaseExpiresAt = "2099-01-01T00:00:00Z";
      }
      if (change === "approval") {
        f.deps.readApproval = async () => null;
      }
      f.row = before;
      expect(
        await f.client.request({ action: "plan", operation: "prepare", selection }),
      ).toMatchObject({
        status: "blocked",
        code: change === "approval" ? "authorization_required" : "operation_in_progress",
      });
      expect(f.row?.record.operator?.planDigest).toBe(original.planDigest);
    },
  );
});

describe("pending app installer repair", () => {
  const interruptedInstall = async () => {
    const f = fixture();
    const appInstall = plan.effects.find((effect) => effect.kind === "install");
    if (appInstall === undefined) {
      throw new Error("Expected the fixture plan to contain an install effect");
    }
    const appInstallId = appInstall.id;
    const originalPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      stage: "app",
      installer: { reference: "generated-app-protected-installer-v1", sha256: "1".repeat(64) },
      effects: plan.effects.flatMap((effect) =>
        effect.id === appInstallId
          ? [
              { id: "auth-schema", kind: "install", description: "Prepare shared Auth schema" },
              effect,
            ]
          : [effect],
      ),
    });
    f.deps.plan = async () => originalPlan;
    const original = await prepared(f);
    const execute = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      if (input.effect.id !== appInstallId) {
        return await execute(input);
      }
      const [firstAccess] = originalPlan.access;
      if (firstAccess === undefined) {
        throw new Error("Expected the fixture plan to contain access");
      }
      const checkpoint = await input.bindWorkerContext({ contextDigest: "6".repeat(64) });
      await checkpoint({
        contextDigest: "6".repeat(64),
        effectId: "generated_app.prepare_schema_revision",
        fenceGeneration: input.fenceGeneration,
        operationId: input.operationRef,
        receipt: { state: "unknown" },
        resourceId: originalPlan.appDatabase.resourceId,
        sequence: 1,
        tenantId: firstAccess.organizationId,
      });
      throw new HostedOperatorError("reconciliation_required");
    };
    f.approve();
    expect(await f.client.request(original)).toMatchObject({ code: "reconciliation_required" });
    const { row } = f;
    if (row === undefined) {
      throw new Error("Expected the interrupted fixture journal row");
    }
    const previous = structuredClone(row);
    const repaired = hostedOperatorPlanSchema.parse({
      ...originalPlan,
      installer: { ...originalPlan.installer, sha256: "2".repeat(64) },
    });
    f.deps.plan = async () => repaired;
    return { f, original, previous, repaired, execute };
  };

  it("retains uncertain history and resources but requires the repaired plan's own approval", async () => {
    const { f, original, previous, repaired, execute } = await interruptedInstall();
    const { readApproval } = f.deps;
    f.deps.readApproval = async (input) =>
      input.planDigest === original.planDigest ? await readApproval(input) : null;
    const successor = { ...(await prepared(f)), callId: "repaired-installer-call" };
    expect(successor.operationRef).toBe(original.operationRef);
    expect(successor.planDigest).toBe(operatorPlanDigest(repaired));
    const retained = f.row?.record;
    if (retained?.operator === undefined) {
      throw new Error("Expected the recovered fixture operator record");
    }
    const { operator } = retained;
    expect(retained.privateState).toEqual(previous.record.privateState);
    expect(retained.approvedByCallId).toBe("operator:unapproved-plan");
    expect(operator.fenceGeneration).toBe(previous.record.operator?.fenceGeneration);
    expect(operator.pendingEffectAttempt).toBeUndefined();
    expect(operator.workerCheckpoints).toEqual(previous.record.operator?.workerCheckpoints);
    const retainedInstallerOperation = operator.retainedInstallerOperations?.find(
      (operation) => operation.approvedByCallId === original.callId,
    );
    expect(retainedInstallerOperation?.approvedByCallId).toBe(original.callId);
    expect(retainedInstallerOperation?.operator.planDigest).toBe(original.planDigest);
    expect(retainedInstallerOperation?.operator.pendingEffectAttempt).toEqual(
      previous.record.operator?.pendingEffectAttempt,
    );
    expect(await f.client.request(successor)).toMatchObject({ code: "authorization_required" });
    expect(await f.client.request(original)).toMatchObject({ code: "resource_mismatch" });
    f.deps.readApproval = readApproval;
    f.deps.executeEffect = execute;
    expect(await f.client.request(successor)).toMatchObject({ status: "prepared" });
    expect(f.row?.record.operator?.workerCheckpoints).toEqual(
      expect.arrayContaining([expect.objectContaining({ receipt: { state: "unknown" } })]),
    );
  });

  it("leaves the pending operation unchanged when old approval or current ownership is unavailable", async () => {
    const { f, previous } = await interruptedInstall();
    f.deps.readApproval = async () => null;
    expect(
      await f.client.request({ action: "plan", operation: "prepare", selection }),
    ).toMatchObject({
      code: "authorization_required",
    });
    expect(f.row).toEqual(previous);
    f.revoke();
    expect(
      await f.client.request({ action: "plan", operation: "prepare", selection }),
    ).toMatchObject({
      code: "authorization_required",
    });
    expect(f.row).toEqual(previous);
  });
});
