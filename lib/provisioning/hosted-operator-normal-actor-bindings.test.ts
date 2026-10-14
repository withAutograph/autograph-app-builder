/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Synthetic typed private ports run sequentially against one actual in-memory journal. */
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";
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

const normalProgram = {
  version: 1 as const,
  appId: selection.appId,
  origin: "https://apps-preview.example.test",
  actors: [
    {
      actorKey: "owner",
      email: "owner@example.test",
      name: "Owner",
      account: "capture-existing" as const,
    },
  ],
  organizations: [],
  memberships: [],
  appAccess: [],
};
const actorProjection = {
  origin: normalProgram.origin,
  identities: {
    version: 1 as const,
    actors: [
      {
        actorKey: "owner",
        actorId: "actual-actor",
        organizationId: null,
        roles: [],
        storageState: "owner-22222222-2222-4222-8222-222222222222.storage.json",
      },
    ],
  },
  files: {
    "owner-22222222-2222-4222-8222-222222222222.storage.json":
      '{"cookies":[{"name":"actual-session","value":"actual%2Fencoded%3Dcookie","domain":"apps-preview.example.test","path":"/","expires":-1,"httpOnly":true,"secure":true,"sameSite":"Lax"}],"origins":[]}',
  },
};
const boundFixture = async (normal = true) => {
  const f = fixture();
  const request = await prepared(f);
  f.approve();
  await f.client.request(request);
  const selectedPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    access: [],
    stage: "app",
    ...(normal
      ? {
          normalActorProgram: normalProgram,
          normalActorPreparation: {
            accountOperationRef: "11111111-1111-4111-8111-111111111111",
            programDigest: normalActorProgramDigest(normalProgram),
            accountPlanDigest: "d".repeat(64),
            accountApprovalId: "account-approval",
            accountApprovedByCallId: "account-call",
          },
        }
      : {}),
    delivery: { branch: selection.branch, projectId: selection.projectId, repoId: "repo-app" },
    gatewayDelivery: { branch: selection.branch, projectId: "prj_gateway", repoId: "repo-gateway" },
    effects: [
      ...plan.effects,
      { description: "App delivery", id: "delivery", kind: "delivery" },
      { description: "Gateway delivery", id: "gateway-delivery", kind: "gateway-delivery" },
    ],
  });
  if (f.row?.record.operator === undefined) {
    throw new Error("Missing prepared journal");
  }
  f.row.record.operator.plan = selectedPlan;
  f.row.record.operator.planDigest = operatorPlanDigest(selectedPlan);
  const common = {
    branch: selection.branch,
    operationRef: request.operationRef,
    readyState: "READY",
  };
  const app = {
    ...common,
    deploymentId: "dpl_app",
    origin: "https://immutable-app.example.test",
    projectId: selection.projectId,
    repoId: "repo-app",
  };
  const gateway = {
    ...common,
    deploymentId: "dpl_gateway",
    origin: "https://immutable-gateway.example.test",
    projectId: "prj_gateway",
    repoId: "repo-gateway",
  };
  f.row.record.operator.deliveryCandidates = [app];
  f.row.record.operator.gatewayDeliveryCandidates = [gateway];
  f.row.record.operator.deliveredDeploymentId = app.deploymentId;
  f.row.record.operator.deliveredGatewayDeploymentId = gateway.deploymentId;
  const producer = vi.fn<
    NonNullable<ProtectedHostedOperatorDependencies["normalActorRuntimeBindings"]>
  >(async () => actorProjection);
  f.deps.normalActorRuntimeBindings = producer;
  return {
    ...f,
    base: f,
    producer,
    request: { action: "bindings" as const, operationRef: request.operationRef, selection },
  };
};
describe("private normal actor bindings producer", () => {
  it("returns actual projection bytes through private client after native Preview proof", async () => {
    const f = await boundFixture();
    const result = await f.client.bindings(f.request);
    expect(result.normalActors).toEqual(actorProjection);
    expect(result.nativePreview?.publicOrigin).toBe(actorProjection.origin);
    const [call] = f.producer.mock.calls;
    expect(call?.[0].authority).toEqual(authority);
    expect(call?.[0].target).toEqual(target);
    expect(call?.[0].operationRef).toBe(f.request.operationRef);
    expect(call?.[0].plan.normalActorProgram).toEqual(normalProgram);
    expect(JSON.stringify(result.environment)).not.toContain("actual%2Fencoded%3Dcookie");
    expect(JSON.stringify(result.plan)).not.toContain("actual%2Fencoded%3Dcookie");
  });
  it("preserves legacy bindings without calling actor producer", async () => {
    const f = await boundFixture(false);
    const result = await f.client.bindings(f.request);
    expect(result.normalActors).toBeUndefined();
    expect(f.producer).not.toHaveBeenCalled();
  });
  it.each(["missing port", "missing result", "missing native preview"])(
    "requires actual normal identity for %s",
    async (failure) => {
      const f = await boundFixture();
      if (failure === "missing port") {
        delete f.deps.normalActorRuntimeBindings;
      }
      if (failure === "missing result") {
        // oxlint-disable-next-line unicorn/no-useless-undefined -- This optional private port returns unavailable when no actual normal sessions exist.
        f.deps.normalActorRuntimeBindings = async () => undefined;
      }
      if (failure === "missing native preview" && f.base.row?.record.operator !== undefined) {
        delete f.base.row.record.operator.deliveryCandidates;
        delete f.base.row.record.operator.deliveredDeploymentId;
      }
      await expect(f.client.bindings(f.request)).rejects.toThrow("auth_identity_required");
      expect(f.producer).not.toHaveBeenCalled();
    },
  );
  it("does not call producer for unprepared state", async () => {
    const f = await boundFixture();
    if (f.base.row !== undefined) {
      f.base.row.record.status = "pending";
    }
    await expect(f.client.bindings(f.request)).rejects.toThrow("operation_in_progress");
    expect(f.producer).not.toHaveBeenCalled();
  });
  it("does not call producer when actual release verification fails", async () => {
    const f = await boundFixture();
    f.deps.verify = async () => {
      throw new HostedOperatorError("resource_mismatch");
    };
    await expect(f.client.bindings(f.request)).rejects.toThrow("resource_mismatch");
    expect(f.producer).not.toHaveBeenCalled();
  });
  it("does not call producer for a foreign frozen participant origin", async () => {
    const f = await boundFixture();
    if (f.base.row?.record.operator?.plan.normalActorProgram !== undefined) {
      f.base.row.record.operator.plan.normalActorProgram.origin = "https://foreign.example.test";
    }
    await expect(f.client.bindings(f.request)).rejects.toThrow();
    expect(f.producer).not.toHaveBeenCalled();
  });
  it("rejects foreign projection origin", async () => {
    const f = await boundFixture();
    f.deps.normalActorRuntimeBindings = async () => ({
      ...actorProjection,
      origin: "https://foreign.example.test",
    });
    await expect(f.client.bindings(f.request)).rejects.toThrow("resource_mismatch");
  });
  it("rechecks actual journal revision after projection read", async () => {
    const f = await boundFixture();
    f.deps.normalActorRuntimeBindings = async () => {
      if (f.base.row !== undefined) {
        f.base.row.revision += 1;
      }
      return actorProjection;
    };
    await expect(f.client.bindings(f.request)).rejects.toThrow("operation_in_progress");
  });
});
