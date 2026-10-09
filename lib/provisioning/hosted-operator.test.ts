import { composeHostedOperatorAuthorizationDependencies } from "./hosted-operator-composition";
/* oxlint-disable eslint/require-await, eslint/no-await-in-loop, sonarjs/no-hardcoded-passwords, unicorn/no-await-expression-member -- Synthetic service adapters and credentials only; plan replacements run sequentially against one journal. */
import { once } from "node:events";
import { text } from "node:stream/consumers";
import { z } from "zod";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  createHostedOperatorClient,
  hostedOperatorClientForSession,
} from "./hosted-operator-client";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import type { ProtectedHostedOperatorDependencies } from "./hosted-operator-service";
import {
  HostedOperatorError,
  hostedOperatorRecordSchema,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  restrictedOperatorEnvironment,
} from "./hosted-operator-contract";
import type { OperatorSelection } from "./hosted-operator-contract";
import { hostedRuntimeIdentity, hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow, HostedRuntimeJournalStore } from "./hosted-runtime-journal";
import { publicApprovalDescription } from "../agent/approval-receipt";

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

describe("protected hosted operator boundary", () => {
  it("serves consent-only setup before full resource configuration and refuses planning/effects", async () => {
    const f = fixture();
    const deps = composeHostedOperatorAuthorizationDependencies(
      {
        builderCallbackOrigin: "https://builder.example",
        builderWorkload: {
          audience: "https://vercel.com/team",
          environment: "production",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "builder",
          subject: "builder-subject",
        },
        operatorWorkload: {
          audience: "https://vercel.com/team",
          environment: "preview",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "operator",
        },
      },
      {
        assertCurrent: async () => {
          await Promise.resolve();
        },
        authorize: async () => await Promise.resolve({ authority, ownerContext }),
      },
    );
    expect(deps.neonAuthorization).toBeDefined();
    await expect(deps.plan({ action: "prepare", authority, target })).rejects.toMatchObject({
      code: "protected_operator_required",
    });
    await expect(
      deps.withResourceLease(
        { authority, operationRef: "00000000-0000-4000-8000-000000000001", plan, target },
        async () => {
          await Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: "protected_operator_required" });
    expect(f.row).toBeUndefined();
  });
  it("uses the existing owner-authorized client/service path for consent before any plan or journal", async () => {
    const f = fixture();
    let activeOwner = true;
    const authorizeConsent = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["authorizeNeonConsent"]>
    >(async () => {
      if (!activeOwner) {
        throw new HostedOperatorError("authorization_required");
      }
      return await Promise.resolve({ authority, ownerContext });
    });
    f.deps.authorizeNeonConsent = authorizeConsent;
    const neonAuthorization = vi.fn<
      NonNullable<ProtectedHostedOperatorDependencies["neonAuthorization"]>
    >(async () => ({
      challenge: {
        displayName: "Connect Neon",
        url: "https://vercel.com/connect/authorize?opaque",
      },
      status: "authorization-started",
    }));
    f.deps.neonAuthorization = neonAuthorization;
    const result = await f.client.neonAuthorization({
      action: "neon-authorization",
      callbackUrl: "https://builder.example/callback",
      phase: "start",
      sessionId: selection.sessionId,
    });
    expect(result.status).toBe("authorization-started");
    expect(neonAuthorization).toHaveBeenCalledWith(
      expect.objectContaining({ authority, ownerContext }),
      { callbackUrl: "https://builder.example/callback", phase: "start" },
    );
    expect(f.row).toBeUndefined();
    expect(f.deps.plan).not.toHaveBeenCalled();
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    activeOwner = false;
    await expect(
      f.client.neonAuthorization({
        action: "neon-authorization",
        phase: "complete",
        sessionId: selection.sessionId,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(neonAuthorization).toHaveBeenCalledTimes(1);
  });
  it("prepares actual Auth metadata without app readiness and resumes a freshly approved full plan", async () => {
    const f = fixture();
    const bootstrap = {
      endpointId: "ep_fixture",
      maintenanceDatabase: "neondb",
      role: "neondb_owner",
    };
    const resourcesInstaller = { reference: "neon-resource-bootstrap-v1", sha256: "c".repeat(64) };
    const authSchema = {
      artifactRef: "auth-plan",
      installer: { reference: "auth-protected-installer-v1", sha256: "f".repeat(64) },
      planDigest: "d".repeat(64),
      targetDigest: "e".repeat(64),
    };
    const resources = [
      {
        description: "Prepare owned Auth resource",
        id: "resources:auth",
        kind: "resources",
        resourceId: plan.authDatabase.resourceId,
      },
      {
        description: "Prepare owned app resource",
        id: "resources:app",
        kind: "resources",
        resourceId: plan.appDatabase.resourceId,
      },
    ];
    const authEffect = {
      description: "Prepare exact Auth schema",
      id: "install:auth",
      kind: "install",
    };
    const bootstrapPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      access: [],
      authSchema,
      bootstrap,
      effects: [...resources, authEffect],
      resourcesInstaller,
      stage: "auth-bootstrap",
    });
    f.deps.plan = async () => bootstrapPlan;
    f.deps.verifyAuthReadiness = vi.fn(
      async () =>
        await Promise.resolve({
          assetSha256: "1".repeat(64),
          catalogFingerprint: "2".repeat(64),
          database: plan.authDatabase.database,
          observedAt: new Date().toISOString(),
          runtimeRole: plan.authDatabase.runtimeRole,
          targetDigest: authSchema.targetDigest,
        }),
    );
    f.deps.verify = vi.fn(f.deps.verify);
    f.deps.bindings = vi.fn(f.deps.bindings);
    const first = await prepared(f);
    f.approve();
    expect((await f.client.request(first)).status).toBe("auth-schema-prepared");
    expect(f.deps.verify).not.toHaveBeenCalled();
    expect(f.deps.bindings).not.toHaveBeenCalled();
    const receipts = f.row?.record.operator?.receipts;
    expect(receipts).toHaveLength(3);
    expect(f.row?.record.environmentBound).toBe(false);
    const fullPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      authSchema,
      bootstrap,
      effects: [...resources, authEffect, ...plan.effects.slice(1)],
      resourcesInstaller,
      stage: "app",
    });
    f.deps.plan = async () => fullPlan;
    const currentApproval = f.deps.readApproval;
    f.deps.readApproval = async (input) =>
      input.planDigest === first.planDigest ? await currentApproval(input) : null;
    const renewed = await prepared(f);
    expect(await f.client.request(renewed)).toMatchObject({
      code: "authorization_required",
      status: "blocked",
    });
    f.deps.readApproval = currentApproval;
    expect(renewed.planDigest).not.toBe(first.planDigest);
    expect(f.row?.record.operator?.receipts).toEqual(receipts);
    expect((await f.client.request(renewed)).status).toBe("prepared");
    expect(f.deps.verify).toHaveBeenCalledTimes(1);
  });

  it("CAS-checkpoints managed environment ownership and preserves it for cleanup", async () => {
    const f = fixture();
    const original = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      if (input.effect.kind === "bindings") {
        if (input.checkpointManagedEnvironment === undefined) {
          throw new Error("Missing real CAS checkpoint");
        }
        const row = {
          branch: input.target.branch,
          comment: `App Builder protected operator ${input.operationRef}`,
          id: "env_owned",
          key: "PLATFORM_ORIGIN",
          operationRef: input.operationRef,
          projectId: input.target.projectId,
        };
        await input.checkpointManagedEnvironment([row]);
        expect(f.row?.record.operator?.managedEnvironment).toEqual([row]);
        await expect(
          input.checkpointManagedEnvironment([
            {
              ...row,
              comment: "App Builder protected operator 00000000-0000-4000-8000-000000000000",
              operationRef: "00000000-0000-4000-8000-000000000000",
            },
          ]),
        ).rejects.toMatchObject({ code: "resource_mismatch" });
      }
      return await original(input);
    };
    const preparedInput = await prepared(f);
    f.approve();
    const outcome = await f.client.request(preparedInput);
    expect(outcome).toMatchObject({ status: "prepared" });
    const rows = f.row?.record.operator?.managedEnvironment;
    expect(rows).toHaveLength(1);
    const cleanupPlan = hostedOperatorPlanSchema.parse({
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Revoke current authority", id: "revoke", kind: "revoke" },
        {
          description: "Remove exact owned bindings",
          id: "remove-bindings",
          kind: "remove-bindings",
        },
        { description: "Retire owned resources", id: "retire", kind: "retire" },
      ],
    });
    f.deps.plan = async () => cleanupPlan;
    expect(
      (await f.client.request({ action: "plan", operation: "cleanup", selection })).status,
    ).toBe("planned");
    expect(f.row?.record.operator?.managedEnvironment).toEqual(rows);
    expect(f.row?.record.operator?.operationRef).not.toBe(preparedInput.operationRef);
  });

  it("rejects missing or reordered authorization phases", () => {
    for (const effects of [plan.effects.slice(1), plan.effects.toReversed(), [plan.effects[3]]]) {
      expect(hostedOperatorPlanSchema.safeParse({ ...plan, effects }).success).toBe(false);
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        action: "cleanup",
        effects: [
          { description: "Retire before revocation", id: "retire", kind: "retire" },
          { description: "Late revoke", id: "revoke", kind: "revoke" },
        ],
      }).success,
    ).toBe(false);
  });
  it("rejects expired preparation authority while preserving read-only status", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.deps.now = () => Date.parse("2028-01-01T00:00:00.000Z");
    const expiredHandler = createProtectedHostedOperatorHandler(f.deps);
    const client = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (url, init) =>
        await expiredHandler(new Request(url instanceof Request ? url.url : url, init)),
      token: async () => "fixture-service-identity",
    });
    expect((await client.request(request)).code).toBe("authorization_required");
    expect(
      (await client.request({ action: "status", operationRef: request.operationRef, selection }))
        .status,
    ).toBe("pending");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("is unavailable without a configured endpoint or all trusted service adapters", async () => {
    await expect(hostedOperatorClientForSession({}, "", {})).rejects.toThrow(
      "protected_operator_required",
    );
    expect(() =>
      createProtectedHostedOperatorHandler({
        ...fixture().deps,
        // @ts-expect-error Exercise invalid adapter startup supplied by an untyped module.
        authorize: null,
      }),
    ).toThrow("protected_operator_required");
  });
  it("plans without effects, exposes concrete approval scope and rejects caller-asserted approval", async () => {
    const f = fixture();
    const request = await prepared(f);
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    const description = publicApprovalDescription(
      { ...selection, plan, planDigest: operatorPlanDigest(plan) },
      "prepare-app-hosted-runtime",
    );
    for (const value of [
      "shared_auth_runtime",
      "synthetic-reviewer",
      "reviewer",
      "Fixture owner",
      "Retain while",
      "br_synthetic",
    ]) {
      expect(description).toContain(value);
    }
  });
  it("requires a verified Gateway origin on newly planned operations", async () => {
    const f = fixture();
    f.deps.plan = async () => {
      const legacyPlan = { ...plan };
      delete legacyPlan.publicGateway;
      delete legacyPlan.deploymentBoundary;
      return legacyPlan;
    };
    const result = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(result.status).toBe("blocked");
    expect(result.code).toBe("resource_mismatch");
    expect(f.row).toBeUndefined();
  });
  it.each([undefined, "d".repeat(64)])(
    "rejects missing or mismatched manifest proof %s despite a valid schema identity",
    async (manifestSha256) => {
      const f = fixture();
      const request = await prepared(f);
      f.approve();
      f.deps.verify = async () => ({ ...proof, manifestSha256 });
      const result = await f.client.request(request);
      expect(result.status).toBe("blocked");
      expect(result.code).toBe("resource_mismatch");
      await expect(
        f.client.bindings({ action: "bindings", operationRef: request.operationRef, selection }),
      ).rejects.toThrow();
    },
  );
  it("executes only after durable approval and projects shared-context runtime roles without installer state", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const result = await f.client.request(request);
    expect(result.status).toBe("prepared");
    expect(JSON.stringify(result)).not.toContain("ciphertext");
    const binding = await f.client.bindings({
      action: "bindings",
      operationRef: request.operationRef,
      selection,
    });
    expect(binding.environment).toEqual(environment);
    expect(binding.environment.PLATFORM_JWKS_URL).toBe(environment.PLATFORM_JWKS_URL);
    expect(Object.keys(binding).toSorted()).toEqual([
      "environment",
      "operationRef",
      "plan",
      "proof",
    ]);
    expect(JSON.stringify(binding)).not.toContain("state.json");
    await f.client.request(request);
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(4);
  });
  it("binds nested worker checkpoints to the active parent effect and acknowledges only after CAS", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const digest = "c".repeat(64);
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        await input.assertCurrent();
        if (input.effect.id === "resources") {
          const recordCheckpoint = await input.bindWorkerContext({ contextDigest: digest });
          const frame = {
            contextDigest: digest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationId: input.operationRef,
            receipt: { readbackSha256: "d".repeat(64), state: "applied" as const },
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
            tenantId: "synthetic-org",
          };
          await recordCheckpoint(frame);
          const stored = f.row?.record.operator?.workerCheckpoints?.[0];
          expect(stored).toMatchObject({
            attemptId: input.workerAttemptId,
            contextDigest: digest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationRef: input.operationRef,
            parentEffectId: input.effect.id,
            receipt: frame.receipt,
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
            tenantId: "synthetic-org",
          });
          await recordCheckpoint(frame);
          expect(f.row?.record.operator?.workerCheckpoints).toHaveLength(1);
          await expect(
            recordCheckpoint({ ...frame, resourceId: "unplanned-resource" }),
          ).rejects.toThrow("resource_mismatch");
          await expect(
            recordCheckpoint({ ...frame, tenantId: "unplanned-tenant" }),
          ).rejects.toThrow("resource_mismatch");
          await expect(recordCheckpoint({ ...frame, sequence: 3 })).rejects.toThrow(
            "reconciliation_required",
          );
          await expect(
            recordCheckpoint({
              ...frame,
              receipt: { readbackSha256: "e".repeat(64), state: "applied" },
            }),
          ).rejects.toThrow("reconciliation_required");
          await expect(
            recordCheckpoint({ ...frame, contextDigest: "f".repeat(64) }),
          ).rejects.toThrow("resource_mismatch");
          await expect(input.bindWorkerContext({ contextDigest: "f".repeat(64) })).rejects.toThrow(
            "reconciliation_required",
          );
        }
        return {
          effectId: input.effect.id,
          fenceGeneration: input.fenceGeneration,
          observedAt: new Date().toISOString(),
          resourceVersion: "worker-checkpoint-fixture",
        };
      },
    );

    const result = await f.client.request(request);
    expect(result.status).toBe("prepared");
    expect(result).not.toHaveProperty("workerCheckpoints");
    expect(f.row?.record.operator?.pendingEffectId).toBeUndefined();
    expect(f.row?.record.operator?.pendingEffectAttempt).toBeUndefined();
    expect(f.row?.record.operator?.workerCheckpoints).toHaveLength(1);
  });
  it("persists unknown worker readback and requires parent reconciliation before a fresh attempt", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const digest = "a".repeat(64);
    let unknownObserved = false;
    let firstAttemptId = "";
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        firstAttemptId = input.workerAttemptId;
        const recordCheckpoint = await input.bindWorkerContext({ contextDigest: digest });
        await recordCheckpoint({
          contextDigest: digest,
          effectId: "schema-install",
          fenceGeneration: input.fenceGeneration,
          operationId: input.operationRef,
          receipt: { state: "unknown" },
          resourceId: plan.appDatabase.resourceId,
          sequence: 1,
        });
        const persistedUnknown = hostedOperatorRecordSchema.parse(f.row?.record.operator)
          .workerCheckpoints?.[0];
        expect(persistedUnknown?.receipt.state).toBe("unknown");
        throw new HostedOperatorError("reconciliation_required");
      },
    );
    const blockedAfterUnknown = await f.client.request(request);
    expect(blockedAfterUnknown.code).toBe("reconciliation_required");
    expect(f.row?.record.operator?.pendingEffectAttempt?.id).toBe(firstAttemptId);

    f.deps.reconcile = vi.fn<ProtectedHostedOperatorDependencies["reconcile"]>(async (input) => {
      if (input.workerCheckpoints.some((checkpoint) => checkpoint.receipt.state === "unknown")) {
        unknownObserved = true;
        return { status: "unknown" as const };
      }
      return { status: "absent" as const };
    });
    const blockedByReconciliation = await f.client.request(request);
    expect(blockedByReconciliation.code).toBe("reconciliation_required");
    expect(unknownObserved).toBe(true);
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(1);

    let retryAttemptId = "";
    f.deps.reconcile = vi.fn(async () => ({ status: "absent" as const }));
    f.deps.executeEffect = vi.fn<ProtectedHostedOperatorDependencies["executeEffect"]>(
      async (input) => {
        if (input.effect.id === "resources") {
          retryAttemptId = input.workerAttemptId;
          const retryDigest = "b".repeat(64);
          const recordCheckpoint = await input.bindWorkerContext({ contextDigest: retryDigest });
          await recordCheckpoint({
            contextDigest: retryDigest,
            effectId: "schema-install",
            fenceGeneration: input.fenceGeneration,
            operationId: input.operationRef,
            receipt: { readbackSha256: "d".repeat(64), state: "applied" },
            resourceId: plan.appDatabase.resourceId,
            sequence: 1,
          });
        }
        return {
          effectId: input.effect.id,
          fenceGeneration: input.fenceGeneration,
          observedAt: new Date().toISOString(),
          resourceVersion: "reconciled-worker-fixture",
        };
      },
    );
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(retryAttemptId).not.toBe(firstAttemptId);
    expect(
      f.row?.record.operator?.workerCheckpoints?.map((checkpoint) => [
        checkpoint.attemptId,
        checkpoint.receipt.state,
      ]),
    ).toEqual([
      [firstAttemptId, "unknown"],
      [retryAttemptId, "applied"],
    ]);
  });
  it("serializes concurrent continuations of the same approved operation", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const started = Promise.withResolvers<null>();
    const hold = Promise.withResolvers<null>();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      started.resolve(null);
      await hold.promise;
      return await real(input);
    };
    const first = f.client.request(request);
    await started.promise;
    expect((await f.client.request(request)).code).toBe("operation_in_progress");
    hold.resolve(null);
    expect((await first).status).toBe("prepared");
    expect(real).toHaveBeenCalledTimes(4);
  });
  it("requires cleanup before replacing allocated resource identities", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const previous = structuredClone(f.row);
    for (const replacement of [
      { ...plan, contextId: "other-context" },
      { ...plan, neon: { ...plan.neon, branchId: "br_other" } },
      { ...plan, appDatabase: { ...plan.appDatabase, runtimeRole: "other_runtime" } },
      { ...plan, authDatabase: { ...plan.authDatabase, resourceId: "other-auth" } },
    ]) {
      f.deps.plan = async () => replacement;
      const next = await f.client.request({ action: "plan", operation: "prepare", selection });
      expect(next.code).toBe("resource_mismatch");
      expect(f.row).toEqual(previous);
    }
    expect(f.deps.executeEffect).toHaveBeenCalledTimes(4);
  });
  it("retains credentials for a same-resource release edit and invalidates previous proof", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const credentials = structuredClone(f.row?.record.privateState);
    f.deps.plan = async () => ({
      ...plan,
      release: { ...plan.release, id: "release_next", sha256: "c".repeat(64) },
    });
    const next = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(next.status).toBe("planned");
    expect(next.operationRef).not.toBe(request.operationRef);
    expect(f.row?.record.privateState).toEqual(credentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.environmentBound).toBe(false);
    expect(f.row?.record.operator?.receipts).toEqual([]);
    expect(f.row?.record.operator?.approvalId).toBeUndefined();
    expect(f.row?.record.approvedByCallId).toBe("operator:unapproved-plan");
    await expect(
      f.client.bindings({
        action: "bindings",
        operationRef: z.uuid().parse(next.operationRef),
        selection,
      }),
    ).rejects.toThrow("operation_in_progress");
  });
  it("requires cleanup approval and retains private shared Auth credentials for the next Preview", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    await f.client.request(request);
    const retainedCredentials = structuredClone(f.row?.record.privateState);
    const prepareGeneration = f.row?.record.operator?.fenceGeneration;
    expect(prepareGeneration).toBeGreaterThan(0);
    const cleanupPlanInput = {
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Revoke this app access", id: "revoke", kind: "revoke" },
        {
          description: "Remove owned app bindings",
          id: "remove-bindings",
          kind: "remove-bindings",
        },
        { description: "Retain shared Auth while consumers exist", id: "retire", kind: "retire" },
      ],
    };
    delete cleanupPlanInput.publicGateway;
    delete cleanupPlanInput.deploymentBoundary;
    const cleanupPlan = hostedOperatorPlanSchema.parse(cleanupPlanInput);
    f.deps.plan = async () => cleanupPlan;
    const next = await f.client.request({ action: "plan", operation: "cleanup", selection });
    const cleanup = {
      ...request,
      callId: "cleanup-call",
      operationRef: z.uuid().parse(next.operationRef),
      planDigest: z.string().parse(next.planDigest),
    };
    const approval = f.deps.readApproval;
    f.deps.readApproval = async () => null;
    expect((await f.client.request(cleanup)).code).toBe("authorization_required");
    f.deps.readApproval = approval;
    expect((await f.client.request(cleanup)).status).toBe("cleaned");
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.operator?.fenceGeneration).toBeGreaterThan(prepareGeneration ?? 0);
    await expect(
      f.client.bindings({
        action: "bindings",
        operationRef: z.uuid().parse(next.operationRef),
        selection,
      }),
    ).rejects.toThrow("operation_in_progress");
    f.deps.plan = async () => ({ ...plan, contextId: "replacement-after-cleanup" });
    const replacement = await f.client.request({ action: "plan", operation: "prepare", selection });
    expect(replacement.status).toBe("planned");
    expect(f.row?.record.privateState).toEqual(retainedCredentials);
    expect(f.row?.record.proof).toBeUndefined();
    expect(f.row?.record.environmentBound).toBe(false);
  });
  it("reconciles an effect applied before a timeout without allocating a second identity", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = vi.mocked(f.deps.executeEffect);
    let crashed = false;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      if (!crashed) {
        crashed = true;
        throw new Error("synthetic-admin-secret");
      }
      return receipt;
    };
    const first = await f.client.request(request);
    expect(first.status).toBe("blocked");
    expect(JSON.stringify(first)).not.toContain("synthetic-admin-secret");
    expect(f.row?.record.operator?.pendingEffectId).toBe("resources");
    const firstGeneration = f.row?.record.operator?.fenceGeneration;
    expect((await f.client.request(request)).status).toBe("prepared");
    expect(real).toHaveBeenCalledTimes(4);
    expect(f.row?.record.operator?.fenceGeneration).toBe(firstGeneration);
    expect(real.mock.calls.map(([input]) => input.fenceGeneration)).toEqual([
      firstGeneration,
      firstGeneration,
      firstGeneration,
      firstGeneration,
    ]);
  });
  it("does not retry when effect readback is unknown", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.unknown();
    expect((await f.client.request(request)).code).toBe("reconciliation_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("blocks access checkpoints that do not match the journaled fence generation", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      return { ...receipt, fenceGeneration: input.fenceGeneration + 1 };
    };

    expect((await f.client.request(request)).code).toBe("reconciliation_required");
    expect(f.row?.record.operator?.receipts.map((receipt) => receipt.effectId)).toEqual([
      "resources",
      "install",
    ]);
    expect(f.row?.record.operator?.pendingEffectId).toBe("access");
    expect(f.row?.record.operator?.fenceGeneration).toBeGreaterThan(0);
  });
  it("rechecks revocation before the next effect", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    const real = f.deps.executeEffect;
    f.deps.executeEffect = async (input) => {
      const receipt = await real(input);
      f.revoke();
      return receipt;
    };
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(real).toHaveBeenCalledTimes(1);
    expect(f.row?.record.status).not.toBe("prepared");
    await expect(
      f.client.bindings({ action: "bindings", operationRef: request.operationRef, selection }),
    ).rejects.toThrow("authorization_required");
  });
  it("stops a fenced worker before effects and preserves the same operation reference", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    f.loseFence();
    expect((await f.client.request(request)).code).toBe("operation_in_progress");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
    expect(f.row?.record.operator?.operationRef).toBe(request.operationRef);
  });
  it("rejects target, session, operation, artifact approval and owner drift", async () => {
    const f = fixture();
    const request = await prepared(f);
    f.approve();
    expect(
      (await f.client.request({ ...request, selection: { ...selection, projectId: "prj_other" } }))
        .code,
    ).toBe("authorization_required");
    expect(
      (await f.client.request({ ...request, selection: { ...selection, sessionId: "other" } }))
        .code,
    ).toBe("authorization_required");
    expect(
      (await f.client.request({ ...request, operationRef: "11111111-1111-4111-8111-111111111111" }))
        .code,
    ).toBe("resource_mismatch");
    expect((await f.client.request({ ...request, planDigest: "c".repeat(64) })).code).toBe(
      "resource_mismatch",
    );
    f.deps.readApproval = async () => ({
      action: "prepare",
      approvalId: "wrong",
      approved: true,
      callId: "different-call",
      planDigest: request.planDigest,
    });
    expect((await f.client.request(request)).code).toBe("authorization_required");
    expect(f.deps.executeEffect).not.toHaveBeenCalled();
  });
  it("preserves old journal shape/identity and refuses silent conversion", async () => {
    const f = fixture();
    const identity = hostedRuntimeIdentity(authority, target);
    f.row = {
      record: {
        approvedByCallId: "legacy",
        kind: "app-runtime",
        privateState: {
          encryptedToken: "old-ciphertext",
          keyVersion: "old-key",
          tokenIv: "iv",
          tokenTag: "tag",
        },
        request: target,
        status: "prepared",
        step: "bound",
        version: 1,
      },
      revision: 1,
    };
    const previous = JSON.stringify(f.row.record);
    expect((await f.client.request({ action: "plan", operation: "prepare", selection })).code).toBe(
      "legacy_runtime_requires_migration",
    );
    expect(JSON.stringify(f.row.record)).toBe(previous);
    expect(hostedRuntimeIdentity(authority, target)).toEqual(identity);
    expect(hostedRuntimeJournalRecordSchema.parse(f.row.record)).not.toHaveProperty("operator");
  });
  it("denies operational client bindings without a resolved owner context", async () => {
    const f = fixture();
    const execution = await prepared(f);
    f.approve();
    await f.client.request(execution);
    const legacyClient = createHostedOperatorClient({
      endpoint: "https://operator.example",
      fetch: async (url, init) =>
        await f.handler(new Request(url instanceof Request ? url.url : url, init)),
      token: async () => "fixture-service-identity",
    });
    await expect(
      legacyClient.bindings({
        action: "bindings",
        operationRef: execution.operationRef,
        selection,
      }),
    ).rejects.toThrow("legacy_runtime_requires_migration");
  });
  it.each([
    { ...environment, NEON_API_KEY: "forbidden" },
    { ...environment, PLATFORM_AUTH_DATABASE_URL: "forbidden-realm-connection" },
    { ...environment, BETTER_AUTH_SECRET: "forbidden-signing-secret" },
    { ...environment, DATABASE_URL: "forbidden-shared-connection" },
    { ...environment, VENDOR_DATABASE_URL: "forbidden-other-app" },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
        "spend_runtime",
        "spend_owner",
      ),
    },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: `${environment.SPEND_REVIEW_DATABASE_URL}&host=other`,
    },
    {
      ...environment,
      SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
        plan.neon.endpoint,
        plan.neon.endpoint.replace(".", "-pooler."),
      ),
    },
    { ...environment, PLATFORM_PUBLIC_ORIGIN: "https://other-preview.example.test" },
    { ...environment, PLATFORM_JWKS_URL: "https://other-preview.example.test/_platform/jwks.json" },
  ])("rejects overprivileged or unrelated runtime projection", (env) => {
    expect(() => restrictedOperatorEnvironment(plan, env, authority)).toThrow("resource_mismatch");
  });
  it("adds public expected identities from the approved plan when the private binding reader returns URLs and public origins", () => {
    const withoutBoundary = Object.fromEntries(
      Object.entries(environment).filter(([key]) => key !== "PLATFORM_APP_BOUNDARY"),
    );
    const projected = restrictedOperatorEnvironment(plan, withoutBoundary, authority);
    expect(JSON.parse(projected.PLATFORM_APP_BOUNDARY)).toEqual(appBoundary);
    expect(projected).toEqual(environment);
    expect(projected.PLATFORM_APP_BOUNDARY).not.toContain("synthetic-app");
    expect(projected.PLATFORM_APP_BOUNDARY).not.toContain("migrator");
  });
  it.each([
    { ...appBoundary, appId: "other-app" },
    { ...appBoundary, runtime: { ...appBoundary.runtime, database: "other_database" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, runtimeRole: "spend_owner" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, hostname: "other.neon.tech" } },
    { ...appBoundary, runtime: { ...appBoundary.runtime, environment: "local" } },
    {
      ...appBoundary,
      verification: {
        ...appBoundary.verification,
        jwksUrl: "https://other.example/_platform/jwks.json",
      },
    },
    { ...appBoundary, privateKey: "forbidden" },
    { ...appBoundary, version: 2 },
  ])("rejects supplied public boundary facts that do not match the owned plan", (boundary) => {
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        { ...environment, PLATFORM_APP_BOUNDARY: JSON.stringify(boundary) },
        authority,
      ),
    ).toThrow("resource_mismatch");
  });
  it("does not derive expected runtime identity from a changed credential URL", () => {
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        {
          ...environment,
          SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
            plan.neon.endpoint,
            "other.neon.tech",
          ),
        },
        authority,
      ),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        {
          ...environment,
          SPEND_REVIEW_DATABASE_URL: environment.SPEND_REVIEW_DATABASE_URL.replace(
            "spend_runtime",
            "other_runtime",
          ),
        },
        authority,
      ),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(
        plan,
        { ...environment, PLATFORM_APP_BOUNDARY: "not-json" },
        authority,
      ),
    ).toThrow("resource_mismatch");
  });
  it("projects only app runtime SQL and public verification configuration", () => {
    expect(restrictedOperatorEnvironment(plan, environment, authority)).toEqual(environment);
    expect(() => restrictedOperatorEnvironment(plan, environment)).toThrow(
      "legacy_runtime_requires_migration",
    );
    expect(() =>
      restrictedOperatorEnvironment(plan, environment, {
        ...authority,
        ownerUserId: "other-owner",
      }),
    ).toThrow("resource_mismatch");
    expect(() =>
      restrictedOperatorEnvironment(plan, environment, {
        ...authority,
        workspaceId: "other-workspace",
      }),
    ).toThrow("resource_mismatch");
  });
  it("parses legacy records for inspection and denies legacy operational projections", () => {
    const legacyPlan = { ...plan };
    delete legacyPlan.deploymentBoundary;
    legacyPlan.publicGateway = {
      branch: selection.branch,
      origin: "https://apps-preview.example.test",
      projectId: selection.projectId,
    };
    expect(hostedOperatorPlanSchema.safeParse(legacyPlan).success).toBe(true);
    expect(() => restrictedOperatorEnvironment(legacyPlan, environment, authority)).toThrow(
      "legacy_runtime_requires_migration",
    );
  });
  it.each(["app", "gateway"] as const)("rejects swapped %s physical project identities", (key) => {
    const boundary = plan.deploymentBoundary;
    if (boundary === undefined) {
      throw new Error("Fixture deployment boundary is absent.");
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          [key]: { ...boundary[key], projectId: "wrong-project" },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects shared application, Gateway and operator projects", () => {
    const boundary = plan.deploymentBoundary;
    if (boundary === undefined) {
      throw new Error("Fixture deployment boundary is absent.");
    }
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          operator: { ...boundary.operator, projectId: boundary.app.projectId },
        },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        deploymentBoundary: {
          ...boundary,
          gateway: { ...boundary.gateway, projectId: boundary.app.projectId },
        },
      }).success,
    ).toBe(false);
  });
  it("rejects sandbox origins and origins swapped across selected Preview targets", () => {
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, origin: "https://sandbox.vercel.run" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, branch: "another-preview" },
      }).success,
    ).toBe(false);
    expect(
      hostedOperatorPlanSchema.safeParse({
        ...plan,
        publicGateway: { ...plan.publicGateway, projectId: "another-project" },
      }).success,
    ).toBe(false);
  });
  it("uses the same client and handler across a real local HTTP transport boundary", async () => {
    const f = fixture();
    const server = createServer((incoming, outgoing) => {
      void (async () => {
        try {
          const response = await f.handler(
            new Request("http://127.0.0.1/v1/runtime", {
              body: await text(incoming),
              headers: {
                authorization: incoming.headers.authorization ?? "",
                "x-vercel-trusted-oidc-idp-token": String(
                  incoming.headers["x-vercel-trusted-oidc-idp-token"] ?? "",
                ),
              },
              method: "POST",
            }),
          );
          outgoing.writeHead(response.status, Object.fromEntries(response.headers));
          outgoing.end(await response.text());
        } catch {
          outgoing.writeHead(500);
          outgoing.end();
        }
      })();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const address = server.address();
      // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Node returns a path for Unix sockets; this fixture listens on a TCP port.
      if (address === null || typeof address === "string") {
        throw new Error("Local server unavailable");
      }
      const client = createHostedOperatorClient({
        allowLoopback: true,
        endpoint: `http://127.0.0.1:${address.port}`,
        ownerContext,
        token: async () => "fixture-service-identity",
      });
      const planned = await client.request({ action: "plan", operation: "prepare", selection });
      f.approve();
      expect(
        (
          await client.request({
            action: "execute",
            callId: "actual-eve-call",
            operationRef: z.uuid().parse(planned.operationRef),
            planDigest: z.string().parse(planned.planDigest),
            selection,
          })
        ).status,
      ).toBe("prepared");
    } finally {
      const closed = once(server, "close");
      server.close();
      await closed;
    }
  });
});
