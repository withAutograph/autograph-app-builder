/* oxlint-disable eslint/require-await, eslint/no-await-in-loop -- Async fixture ports exercise sequential interruption and ownership races. */
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan, OperatorOwnerContext } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import type {
  HostedRuntimeJournalRecord,
  HostedRuntimeJournalRow,
  HostedRuntimeTarget,
} from "./hosted-runtime-journal";
import type { HostedOperatorContext, HostedOperatorEffectContext } from "./hosted-operator-service";
import { decryptHostedRuntimeFiles } from "./hosted-runtime-service";
import {
  describeHostedOperatorSharedAuth,
  prepareHostedOperatorResourceCredentials,
  readHostedOperatorResourceBindings,
  sealHostedOperatorSharedAuth,
} from "./hosted-operator-resource-credentials";
import { createHostedOperatorSharedAuthAdoption } from "./hosted-operator-shared-auth-adoption";
import { createHostedOperatorAuthReadiness } from "./hosted-operator-auth-readiness";
import { composeHostedOperatorDependencies } from "./hosted-operator-composition";
// oxlint-disable-next-line sonarjs/no-wildcard-import -- Spy on the actual composition factory while retaining its other methods.
import * as gatewayBindings from "./hosted-operator-gateway-bindings";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";
import type { HostedOperatorSourceConfiguration } from "./hosted-operator-source-configuration";

const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
afterEach(() => vi.restoreAllMocks());
const config = { tokenKey: Buffer.alloc(32, 9), tokenKeyVersion: "fixture" };
const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const target = (appId: string): HostedRuntimeTarget => ({
  appId,
  branch: "preview",
  environment: "preview",
  installationId: "installation",
  projectId: `prj_${appId}`,
  scopeId: "team",
  scopeType: "team",
  sessionId: `session_${appId}`,
});
const owner = (request: HostedRuntimeTarget): OperatorOwnerContext => ({
  adapterGeneration: 1,
  adapterSessionId: `adapter_${request.appId}`,
  authority,
  kind: "direct",
  principal: { ...authority, scopes: ["autograph:get"] },
  sessionId: request.sessionId,
});
const context = (request: HostedRuntimeTarget) => ({
  authority,
  ownerContext: owner(request),
  target: request,
});
const sourcePlan = () => {
  const {
    installationId: _installation,
    scopeId: _scope,
    scopeType: _scopeType,
    ...selection
  } = target("first");
  void _installation;
  void _scope;
  void _scopeType;
  return hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("first"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "source-auth-artifact",
      installer: { reference: "auth-worker", sha256: "a".repeat(64) },
      planDigest: "b".repeat(64),
      targetDigest: "c".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "fixture",
    cost: { class: "shared-recovery-group", description: "synthetic fixture", owner: "owner" },
    effects: [
      { description: "Auth", id: "auth-resources", kind: "resources", resourceId: "auth-resource" },
      { description: "App", id: "app-resources", kind: "resources", resourceId: "first-resource" },
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "d".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "owner-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "synthetic-project",
      source: "synthetic-only",
    },
    release: { artifactRef: "source-release", id: "release", sha256: "f".repeat(64) },
    resourcesInstaller: { reference: "resource-worker", sha256: "e".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    selection,
    stage: "auth-bootstrap",
    version: 1,
  });
};
const row = (
  request: HostedRuntimeTarget,
  plan: HostedOperatorPlan,
  ready = false,
): HostedRuntimeJournalRow => ({
  record: hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "call",
    kind: "app-runtime",
    operator: {
      approvalId: "approval",
      authPreparation: ready
        ? {
            assetSha256: "a".repeat(64),
            catalogFingerprint: "b".repeat(64),
            database: "auth",
            observedAt: "2026-10-09T00:00:00Z",
            runtimeRole: "auth_runtime",
            targetDigest: "c".repeat(64),
          }
        : undefined,
      fenceGeneration: 1,
      mode: "protected-operator-v1",
      operationRef: randomUUID(),
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: ready
        ? plan.effects.map((effect) => ({
            effectId: effect.id,
            observedAt: "2026-10-09T00:00:00Z",
            resourceVersion: "observed",
          }))
        : [],
    },
    request,
    status: "pending",
    step: "reserved",
    version: 1,
  }),
  revision: 1,
});
const requireOperator = (record: HostedRuntimeJournalRecord) => {
  if (record.operator === undefined) {
    throw new Error("Fixture operator missing");
  }
  return record.operator;
};
const requirePreparation = (record: HostedRuntimeJournalRecord) => {
  const preparation = requireOperator(record).authPreparation;
  if (preparation === undefined) {
    throw new Error("Fixture readiness missing");
  }
  return preparation;
};
const requireAuthSchema = (plan: HostedOperatorPlan) => {
  if (plan.authSchema === undefined) {
    throw new Error("Fixture schema missing");
  }
  return plan.authSchema;
};
const withoutCredentials = (record: HostedRuntimeJournalRecord) => {
  const copy = structuredClone(record);
  delete copy.privateState;
  return copy;
};
const fixture = () => {
  const sourceContext = context(target("first"));
  const source = row(sourceContext.target, sourcePlan(), true);
  const sourceInput = () => ({
    ...sourceContext,
    config,
    plan: requireOperator(source.record).plan,
    record: source.record,
  });
  source.record.privateState = prepareHostedOperatorResourceCredentials({
    ...sourceInput(),
    database: "authDatabase",
  }).privateState;
  const adoption = describeHostedOperatorSharedAuth(sourceInput());
  const targetContext = context(target("second"));
  const plan = hostedOperatorPlanSchema.parse({
    ...sourcePlan(),
    appDatabase: resource("second"),
    authAdoption: adoption,
    authSchema: { ...sourcePlan().authSchema, artifactRef: "target-auth-artifact" },
    effects: sourcePlan().effects.map((effect) =>
      effect.id === "app-resources" ? { ...effect, resourceId: "second-resource" } : effect,
    ),
    selection: {
      ...sourcePlan().selection,
      appId: "second",
      projectId: targetContext.target.projectId,
      sessionId: targetContext.target.sessionId,
    },
  });
  const destination = row(targetContext.target, plan);
  const targetInput = () => ({ ...targetContext, config, plan, record: destination.record });
  const sourceHint = { ownerContext: sourceContext.ownerContext, target: sourceContext.target };
  const assertPlanningAuthorized = vi.fn(async (_context: HostedOperatorContext) => {});
  const assertAuthorized = vi.fn(
    async (_input: HostedOperatorContext & { plan: HostedOperatorPlan }) => {},
  );
  const readApproval = vi.fn(async (input: HostedOperatorContext) => ({
    action: "prepare" as const,
    approvalId: "approval",
    approved: true,
    callId: "call",
    planDigest: requireOperator(input.target.appId === "first" ? source.record : destination.record)
      .planDigest,
  }));
  const assertCurrent = vi.fn(async () => {});
  const readCurrentTarget = vi.fn(async (input: HostedOperatorEffectContext) => {
    await input.assertCurrent();
    await assertAuthorized(input);
    if (
      input.operationRef !== destination.record.operator?.operationRef ||
      operatorPlanDigest(input.plan) !== destination.record.operator.planDigest
    ) {
      throw new Error("stale target");
    }
    return structuredClone(destination.record);
  });
  const checkpointTarget = vi.fn(
    async (input: {
      expected: typeof destination.record.privateState;
      privateState: NonNullable<typeof destination.record.privateState>;
    }) => {
      if (!isDeepStrictEqual(destination.record.privateState, input.expected)) {
        throw new HostedOperatorError("operation_in_progress");
      }
      destination.record.privateState = input.privateState;
      destination.revision += 1;
    },
  );
  const store = { read: vi.fn(async (_input: HostedOperatorContext) => structuredClone(source)) };
  const api = createHostedOperatorSharedAuthAdoption({
    assertAuthorized,
    assertPlanningAuthorized,
    checkpointTarget,
    config,
    readApproval,
    readCurrentTarget,
    store,
  });
  const effect: HostedOperatorEffectContext = {
    ...targetContext,
    assertCurrent,
    checkpoint: vi.fn(async () => {}),
    effect: plan.effects[0],
    fenceGeneration: 1,
    operationRef: requireOperator(destination.record).operationRef,
    plan,
    workerCheckpoints: [],
  };
  return {
    api,
    assertAuthorized,
    assertCurrent,
    assertPlanningAuthorized,
    checkpointTarget,
    destination,
    effect,
    plan,
    readApproval,
    readCurrentTarget,
    source,
    sourceContext,
    sourceHint,
    sourceInput,
    store,
    targetContext,
    targetInput,
  };
};
const credentialView = z.object({
  appDatabase: z.object({ migratorPassword: z.string(), runtimePassword: z.string() }),
  authDatabase: z.object({ migratorPassword: z.string(), runtimePassword: z.string() }),
  identity: z.object({
    authDatabase: z.object({
      database: z.string(),
      migratorRole: z.string(),
      resourceId: z.string(),
      runtimeRole: z.string(),
    }),
  }),
  state: z.string().optional(),
  version: z.number(),
});
const files = (input: ReturnType<ReturnType<typeof fixture>["sourceInput"]>) => {
  const decrypted = decryptHostedRuntimeFiles(input);
  if (decrypted === undefined) {
    throw new Error("Fixture checkpoint missing");
  }
  return credentialView.parse(JSON.parse(decrypted["protected-resource-credentials.json"]));
};

describe("shared Auth encrypted adoption prerequisite", () => {
  it("imports only Auth, preserves both ciphertexts on retry, and releases no worker credentials", async () => {
    const f = fixture();
    const sourceBefore = structuredClone(f.source);
    const first = await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    const checkpoint = structuredClone(f.destination.record.privateState);
    const original = files(f.sourceInput());
    const adopted = files(f.targetInput());
    expect(adopted.version).toBe(2);
    expect(adopted.state).toBe("pending-shared-auth-verification");
    expect(adopted.authDatabase).toEqual(original.authDatabase);
    expect(adopted.appDatabase.migratorPassword).not.toBe(original.appDatabase.migratorPassword);
    expect(adopted.appDatabase.runtimePassword).not.toBe(original.appDatabase.runtimePassword);
    expect(first).toEqual({ status: "checkpointed-awaiting-verification" });
    expect(JSON.stringify(first)).not.toContain(original.authDatabase.runtimePassword);
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    expect(f.destination.record.privateState).toEqual(checkpoint);
    expect(f.source).toEqual(sourceBefore);
    for (const database of ["appDatabase", "authDatabase"] as const) {
      expect(() =>
        prepareHostedOperatorResourceCredentials({ ...f.targetInput(), database }),
      ).toThrow("reconciliation_required");
    }
    expect(() => readHostedOperatorResourceBindings(f.targetInput())).toThrow(
      "reconciliation_required",
    );
    const { authAdoption: _adoption, ...withoutAdoption } = f.plan;
    void _adoption;
    expect(() =>
      readHostedOperatorResourceBindings({ ...f.targetInput(), plan: withoutAdoption }),
    ).toThrow();
    expect(() =>
      prepareHostedOperatorResourceCredentials({
        ...f.targetInput(),
        database: "appDatabase",
        plan: { ...f.plan, action: "cleanup" },
      }),
    ).toThrow();
  });

  it("never decrypts by foreign owner or workspace and rejects a foreign ciphertext", async () => {
    for (const key of ["ownerUserId", "workspaceId"] as const) {
      const f = fixture();
      f.sourceHint.ownerContext.authority = { ...authority, [key]: "foreign" };
      f.sourceHint.ownerContext.principal = {
        ...f.sourceHint.ownerContext.principal,
        [key]: "foreign",
      };
      await expect(
        f.api.inspect({ context: f.targetContext, source: f.sourceHint }),
      ).rejects.toThrow();
      expect(f.store.read).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.source.record.privateState = prepareHostedOperatorResourceCredentials({
      ...f.sourceInput(),
      authority: { ...authority, ownerUserId: "foreign" },
      database: "authDatabase",
      record: withoutCredentials(f.source.record),
    }).privateState;
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow();
    expect(f.checkpointTarget).not.toHaveBeenCalled();
  });

  it.each(["missing", "cleaned", "busy", "unknown", "incomplete", "unready", "unapproved"])(
    "blocks %s source state",
    async (state) => {
      const f = fixture();
      if (state === "missing") {
        delete f.source.record.privateState;
      }
      if (state === "cleaned") {
        f.source.record.status = "cleaned";
      }
      if (state === "busy") {
        f.source.record.leaseId = randomUUID();
      }
      if (state === "unknown") {
        requireOperator(f.source.record).pendingEffectId = "auth-schema";
      }
      if (state === "incomplete") {
        requireOperator(f.source.record).receipts.pop();
      }
      if (state === "unready") {
        delete requireOperator(f.source.record).authPreparation;
      }
      if (state === "unapproved") {
        f.readApproval.mockResolvedValue({
          action: "prepare",
          approvalId: "approval",
          approved: false,
          callId: "call",
          planDigest: requireOperator(f.source.record).planDigest,
        });
      }
      await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow();
      expect(f.checkpointTarget).not.toHaveBeenCalled();
    },
  );

  it.each(["endpoint", "branchId", "projectId"] as const)(
    "rejects changed physical %s",
    (field) => {
      const f = fixture();
      f.plan.neon[field] = field === "endpoint" ? "ep-other.neon.tech" : "other";
      expect(() =>
        sealHostedOperatorSharedAuth({ source: f.sourceInput(), target: f.targetInput() }),
      ).toThrow();
      expect(hostedOperatorPlanSchema.safeParse(f.plan).success).toBe(false);
    },
  );

  it("rejects app collisions, changed Auth roles, and pre-existing v1 target credentials", () => {
    const f = fixture();
    const changed = structuredClone(f.plan);
    changed.appDatabase = f.sourceInput().plan.appDatabase;
    expect(() =>
      sealHostedOperatorSharedAuth({
        source: f.sourceInput(),
        target: { ...f.targetInput(), plan: changed },
      }),
    ).toThrow();
    changed.appDatabase = f.plan.appDatabase;
    changed.authDatabase.runtimeRole = "different_runtime";
    expect(() =>
      sealHostedOperatorSharedAuth({
        source: f.sourceInput(),
        target: { ...f.targetInput(), plan: changed },
      }),
    ).toThrow();
    const { authAdoption: _adoption, ...fresh } = f.plan;
    void _adoption;
    f.destination.record.privateState = prepareHostedOperatorResourceCredentials({
      ...f.targetInput(),
      database: "authDatabase",
      plan: fresh,
    }).privateState;
    const existing = structuredClone(f.destination.record.privateState);
    expect(() =>
      sealHostedOperatorSharedAuth({ source: f.sourceInput(), target: f.targetInput() }),
    ).toThrow();
    expect(f.destination.record.privateState).toEqual(existing);
  });

  it("does not regenerate a missing checkpoint after an uncertain target effect", async () => {
    const f = fixture();
    requireOperator(f.destination.record).pendingEffectId = "auth-resources";
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow();
    expect(f.checkpointTarget).not.toHaveBeenCalled();
  });

  it("denies revoked current authority and stale source approval/checkpoint", async () => {
    const f = fixture();
    f.assertPlanningAuthorized.mockImplementation(async (input) => {
      if (input.target.appId === "first") {
        throw new Error("revoked");
      }
    });
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "revoked",
    );
    expect(f.checkpointTarget).not.toHaveBeenCalled();
    f.assertPlanningAuthorized.mockResolvedValue();
    f.source.record.privateState = prepareHostedOperatorResourceCredentials({
      ...f.sourceInput(),
      database: "authDatabase",
      record: withoutCredentials(f.source.record),
    }).privateState;
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "resource_mismatch",
    );
    expect(f.checkpointTarget).not.toHaveBeenCalled();
  });

  it("checks source stability across awaited reads and after target acknowledgement", async () => {
    const f = fixture();
    f.store.read.mockImplementationOnce(async () => {
      const before = structuredClone(f.source);
      f.source.revision += 1;
      return before;
    });
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "reconciliation_required",
    );
    expect(f.checkpointTarget).not.toHaveBeenCalled();
    f.checkpointTarget.mockImplementationOnce(async ({ privateState }) => {
      f.destination.record.privateState = privateState;
      f.source.revision += 1;
    });
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "reconciliation_required",
    );
    expect(() => readHostedOperatorResourceBindings(f.targetInput())).toThrow();
  });

  it("survives interruption after persistence without replacing either password pair", async () => {
    const f = fixture();
    f.checkpointTarget.mockImplementationOnce(async ({ privateState }) => {
      f.destination.record.privateState = privateState;
      throw new Error("interrupted");
    });
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "interrupted",
    );
    const stored = structuredClone(f.destination.record.privateState);
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    expect(f.destination.record.privateState).toEqual(stored);
  });

  it("fails a lost target fence or unacknowledged checkpoint without releasing credentials", async () => {
    const f = fixture();
    f.assertCurrent.mockRejectedValueOnce(new Error("lost lease"));
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "lost lease",
    );
    expect(f.checkpointTarget).not.toHaveBeenCalled();
    f.checkpointTarget.mockResolvedValueOnce();
    await expect(f.api.checkpoint({ effect: f.effect, source: f.sourceHint })).rejects.toThrow(
      "operation_in_progress",
    );
  });

  it("freezes caller-owned source and target inputs before the first await", async () => {
    const f = fixture();
    f.assertCurrent.mockImplementationOnce(async () => {
      f.effect.plan = { ...f.plan, authDatabase: resource("foreign") };
      f.sourceHint.target = target("foreign");
    });
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    expect(files(f.targetInput()).identity.authDatabase).toEqual(resource("auth"));
    expect(f.store.read.mock.calls.every(([input]) => input.target.appId === "first")).toBe(true);
  });

  it("allows only one concurrent creation and retries from its acknowledged ciphertext", async () => {
    const f = fixture();
    const outcomes = await Promise.allSettled([
      f.api.checkpoint({ effect: f.effect, source: f.sourceHint }),
      f.api.checkpoint({ effect: f.effect, source: f.sourceHint }),
    ]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    const saved = structuredClone(f.destination.record.privateState);
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    expect(f.destination.record.privateState).toEqual(saved);
  });
});

describe("pending shared Auth independent readiness continuation", () => {
  const ready = async () => {
    const f = fixture();
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    const verifyReadiness = vi.fn(
      async (_input: Parameters<Parameters<typeof f.api.verify>[0]["verifyReadiness"]>[0]) => ({
        ...requirePreparation(f.source.record),
        observedAt: "2026-10-09T01:00:00Z",
      }),
    );
    const verify = async () =>
      await f.api.verify({ effect: f.effect, source: f.sourceHint, verifyReadiness });
    return { ...f, verify, verifyReadiness };
  };

  it("seals canonical Gateway ownership with Auth and rejects source snapshot replacement", async () => {
    const f = fixture();
    const sourceOperator = requireOperator(f.source.record);
    const publicGateway = {
      branch: "preview",
      origin: "https://apps.example",
      projectId: "gateway",
    };
    sourceOperator.plan.publicGateway = publicGateway;
    sourceOperator.planDigest = operatorPlanDigest(sourceOperator.plan);
    sourceOperator.gatewayEnvironment = [
      "AUTH_DATABASE_RESOURCE",
      "PLATFORM_AUTH_DATABASE_URL",
      "PLATFORM_GATEWAY_PROTECTED_APPLICATIONS",
      "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
      "PLATFORM_GATEWAY_PROJECT_BINDINGS",
    ].map((key, index) => ({
      branch: "preview",
      comment: `App Builder protected operator ${sourceOperator.operationRef}`,
      id: `row-${index}`,
      key,
      operationRef: sourceOperator.operationRef,
      projectId: "gateway",
      valueSha256: "a".repeat(64),
    }));
    f.plan.publicGateway = publicGateway;
    f.plan.authAdoption = describeHostedOperatorSharedAuth(f.sourceInput());
    requireOperator(f.destination.record).plan = f.plan;
    requireOperator(f.destination.record).planDigest = operatorPlanDigest(f.plan);
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    const saved = structuredClone(f.destination.record.privateState);
    await f.api.checkpoint({ effect: f.effect, source: f.sourceHint });
    expect(f.destination.record.privateState).toEqual(saved);
    const verifyReadiness = vi.fn(async () => structuredClone(requirePreparation(f.source.record)));
    await f.api.verify({ effect: f.effect, source: f.sourceHint, verifyReadiness });
    sourceOperator.gatewayEnvironment[0].valueSha256 = "f".repeat(64);
    await expect(
      f.api.verify({ effect: f.effect, source: f.sourceHint, verifyReadiness }),
    ).rejects.toMatchObject({
      code: "resource_mismatch",
    });
    expect(verifyReadiness).toHaveBeenCalledOnce();
  });

  it("reads only the checkpointed Auth runtime identity and returns a non-secret schema proof", async () => {
    const f = await ready();
    const before = structuredClone(f.destination);
    const sourceBefore = structuredClone(f.source);
    const proof = await f.verify();
    const [[supplied]] = f.verifyReadiness.mock.calls;
    const url = new URL(supplied.runtimeUrl);
    expect(url.hostname).toBe(f.plan.neon.endpoint);
    expect(url.pathname).toBe("/auth");
    expect(url.username).toBe("auth_runtime");
    expect(decodeURIComponent(url.password)).toBe(
      files(f.sourceInput()).authDatabase.runtimePassword,
    );
    expect(supplied.plan.authSchema?.artifactRef).toBe("target-auth-artifact");
    expect(proof).toEqual({
      ...requireOperator(f.source.record).authPreparation,
      observedAt: "2026-10-09T01:00:00Z",
    });
    expect(JSON.stringify(proof)).not.toContain(url.password);
    expect(f.destination).toEqual(before);
    expect(f.source).toEqual(sourceBefore);
    expect(() => readHostedOperatorResourceBindings(f.targetInput())).toThrow(
      "reconciliation_required",
    );
    expect(() =>
      prepareHostedOperatorResourceCredentials({ ...f.targetInput(), database: "authDatabase" }),
    ).toThrow("reconciliation_required");
  });

  it("uses the existing SQL verifier with the target-scoped approved artifact", async () => {
    const f = await ready();
    const sql = "fixture catalog publication";
    const { createHash } = await import("node:crypto");
    const hash = createHash("sha256").update(sql).digest("hex");
    requirePreparation(f.source.record).assetSha256 = hash;
    // Saved readiness is not part of the source description, but its exact source row is captured anew.
    const readAuthPlan = vi.fn(async () =>
      Buffer.from(
        JSON.stringify({
          schemaPlan: {
            effects: [{ owner: "readiness", sha256: hash, sql }],
            planDigest: requireAuthSchema(f.plan).planDigest,
            targetDigest: requireAuthSchema(f.plan).targetDigest,
          },
        }),
      ),
    );
    const readSnapshot = vi.fn(async () => ({
      database: "auth",
      login: "auth_runtime",
      readiness: {
        algorithm: "pg-jsonb-catalog-sha256-v1",
        assetSha256: hash,
        database: "auth",
        observedFingerprint: "b".repeat(64),
        publishedFingerprint: "b".repeat(64),
        status: "verified",
        targetDigest: "c".repeat(64),
        version: 1,
      },
      role: "auth_runtime",
    }));
    const proof = await f.api.verify({
      effect: f.effect,
      source: f.sourceHint,
      verifyReadiness: async (input) =>
        await createHostedOperatorAuthReadiness({
          assertAuthorized: f.assertAuthorized,
          readAuthPlan,
          readRuntimeUrl: async () => input.runtimeUrl,
          readSnapshot,
        }).verify(input),
    });
    expect(proof.assetSha256).toBe(hash);
    expect(readAuthPlan.mock.calls).toHaveLength(1);
    expect(readSnapshot).toHaveBeenCalledOnce();
  });

  it.each([
    "targetDigest",
    "assetSha256",
    "catalogFingerprint",
    "database",
    "runtimeRole",
  ] as const)("rejects a fresh proof with mismatched saved %s", async (field) => {
    const f = await ready();
    const proof = {
      ...requirePreparation(f.source.record),
      [field]: field === "database" || field === "runtimeRole" ? "foreign" : "f".repeat(64),
    };
    f.verifyReadiness.mockResolvedValue(proof);
    await expect(f.verify()).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(() => readHostedOperatorResourceBindings(f.targetInput())).toThrow();
  });

  it.each([
    "source",
    "target",
    "target-plan",
    "source-approval",
    "target-approval",
    "authority",
    "lease",
  ])("rejects %s changes during SQL read", async (change) => {
    const f = await ready();
    const before = structuredClone(f.destination.record.privateState);
    f.verifyReadiness.mockImplementationOnce(async () => {
      const proof = structuredClone(requirePreparation(f.source.record));
      if (change === "source") {
        f.source.revision += 1;
      }
      if (change === "target") {
        requireOperator(f.destination.record).pendingEffectId = "app-resources";
      }
      if (change === "target-plan") {
        requireOperator(f.destination.record).planDigest = "f".repeat(64);
      }
      if (change === "source-approval" || change === "target-approval") {
        f.readApproval.mockImplementation(async (input) => ({
          action: "prepare",
          approvalId: "approval",
          approved: input.target.appId !== (change === "source-approval" ? "first" : "second"),
          callId: "call",
          planDigest: requireOperator(
            input.target.appId === "first" ? f.source.record : f.destination.record,
          ).planDigest,
        }));
      }
      if (change === "authority") {
        f.assertPlanningAuthorized.mockRejectedValue(new Error("revoked"));
      }
      if (change === "lease") {
        f.assertCurrent.mockRejectedValue(new Error("lost lease"));
      }
      return proof;
    });
    await expect(f.verify()).rejects.toThrow();
    expect(f.destination.record.privateState).toEqual(before);
  });

  it("blocks missing pending checkpoints and foreign owners before the runtime verifier", async () => {
    const f = await ready();
    delete f.destination.record.privateState;
    await expect(f.verify()).rejects.toThrow();
    expect(f.verifyReadiness).not.toHaveBeenCalled();
    f.sourceHint.ownerContext.authority.ownerUserId = "foreign";
    await expect(f.verify()).rejects.toThrow();
    expect(f.verifyReadiness).not.toHaveBeenCalled();
  });

  it("preserves pending ciphertext on verifier failure and retries without regeneration", async () => {
    const f = await ready();
    const before = structuredClone(f.destination);
    const password = files(f.sourceInput()).authDatabase.runtimePassword;
    f.verifyReadiness.mockRejectedValueOnce(new Error(`postgres://${password}@private`));
    await expect(f.verify()).rejects.toThrow("operator_unavailable");
    await f.verify();
    expect(f.destination).toEqual(before);
    expect(f.checkpointTarget).toHaveBeenCalledOnce();
  });

  it("permits renewal of the same lease but rejects replacement during readback", async () => {
    const f = await ready();
    f.destination.record.leaseId = randomUUID();
    let expiry = Date.parse("2027-01-01T00:00:00Z");
    f.assertCurrent.mockImplementation(async () => {
      expiry += 1000;
      f.destination.record.leaseExpiresAt = new Date(expiry).toISOString();
    });
    await expect(f.verify()).resolves.toMatchObject({ database: "auth" });
    f.verifyReadiness.mockImplementationOnce(async () => {
      f.destination.record.leaseId = randomUUID();
      return structuredClone(requirePreparation(f.source.record));
    });
    await expect(f.verify()).rejects.toMatchObject({ code: "reconciliation_required" });
  });

  it("snapshots caller inputs and rejects concurrent checkpoint replacement", async () => {
    const f = await ready();
    f.verifyReadiness.mockImplementationOnce(async (input) => {
      f.effect.plan = { ...f.plan, authDatabase: resource("foreign") };
      f.sourceHint.target = target("foreign");
      await input.assertCurrent();
      return structuredClone(requirePreparation(f.source.record));
    });
    await f.verify();
    const other = await ready();
    const outcomes = await Promise.allSettled([other.verify(), other.verify()]);
    expect(outcomes.every((outcome) => outcome.status === "fulfilled")).toBe(true);
    other.verifyReadiness.mockImplementationOnce(async () => {
      other.destination.record.privateState = prepareHostedOperatorResourceCredentials({
        ...other.sourceInput(),
        database: "authDatabase",
        record: withoutCredentials(other.source.record),
      }).privateState;
      return structuredClone(requirePreparation(other.source.record));
    });
    await expect(other.verify()).rejects.toThrow();
  });
});

describe("native composition adoption boundary", () => {
  it("runs protected read-only preflight then blocks all worker and schema fallback paths", async () => {
    const f = fixture();
    const unavailable = vi.fn(() => {
      throw new Error("Unexpected provider or worker path");
    });
    const workload = {
      audience: "https://vercel.com/team",
      environment: "preview" as const,
      issuer: "https://oidc.vercel.com/team",
      ownerId: "team",
      projectId: "builder",
      subject: "builder-workload",
    };
    const worker = {
      executablePath: "/fixed-worker",
      id: "worker",
      operationScope: "auth-protected-schema-v1" as const,
      sha256: "a".repeat(64),
      subcommand: "auth-protected-schema" as const,
    };
    const configuration: HostedOperatorSourceConfiguration = {
      applications: {
        second: {
          accessRoles: ["member"],
          appDatabase: resource("second"),
          authAdoptionSource: f.sourceHint,
          branch: "preview",
          gitSha: "a".repeat(40),
          projectId: "prj_second",
          repoId: "repo",
        },
      },
      authDatabase: resource("auth"),
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: ["first", "second"],
      gateway: {
        authBrowserOrigin: "https://auth.example",
        branch: "preview",
        environment: "preview",
        gatewayOrigin: "https://gateway.example",
        gitSha: "a".repeat(40),
        projectId: "gateway",
        protectedApplicationIds: ["first", "second"],
        publicOrigin: "https://apps.example",
        repoId: "repo",
        workload: { ...workload, projectId: "gateway" },
      },
      nativeNeon: {
        configuration: {
          connector: "fixture",
          nativeStore: {
            configurationId: "installation",
            resourceId: "store",
            sourceProjectId: "operator",
          },
          operator: {
            audience: workload.audience,
            environment: workload.environment,
            issuer: workload.issuer,
            ownerId: workload.ownerId,
            projectId: "operator",
          },
        },
        scope: {
          branchId: "br-fixture",
          endpointId: "ep-fixture",
          hostname: "ep-fixture.neon.tech",
          maintenanceDatabase: "neondb",
          maintenanceRole: "neondb_owner",
          projectId: "synthetic-project",
        },
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        origin: "https://operator.example",
        projectId: "operator",
      },
      sandbox: {
        accessWorker: worker,
        authProposal: { executablePath: "/proposal", id: "proposal", sha256: "a".repeat(64) },
        authWorker: worker,
        image: "fixture",
        projectId: "operator",
        resourcesWorker: worker,
        teamId: "team",
        workers: { second: worker },
      },
      teamId: "team",
      workloadPolicy: workload,
    };
    const checkpointSharedAuthAdoption = vi.fn(
      async (input: Parameters<typeof f.api.checkpoint>[0]) => await f.api.checkpoint(input),
    );
    const verifyCanonicalOwnership = vi.fn(async () => ({ rows: [] }));
    const originalGateway = gatewayBindings.createHostedOperatorGatewayBindings;
    vi.spyOn(gatewayBindings, "createHostedOperatorGatewayBindings").mockImplementation((deps) => ({
      ...originalGateway(deps),
      verifyCanonicalOwnership,
    }));
    f.plan.gatewayBindings = {
      authBrowserOrigin: configuration.gateway.authBrowserOrigin,
      builderCallbackOrigin: configuration.builderCallbackOrigin,
      catalogAppIds: configuration.gateway.protectedApplicationIds,
      operatorOrigin: configuration.operator.origin,
      sourceWorkload: { ...configuration.gateway.workload, environment: "preview" },
    };
    f.plan.publicGateway = {
      branch: "preview",
      origin: configuration.gateway.publicOrigin,
      projectId: "gateway",
    };
    f.plan.gatewayDelivery = {
      branch: "preview",
      gitSha: "a".repeat(40),
      projectId: "gateway",
      repoId: "repo",
    };
    f.plan.deploymentBoundary = {
      app: { branch: "preview", environment: "preview", projectId: "prj_second" },
      authority,
      gateway: { branch: "preview", environment: "preview", projectId: "gateway" },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator",
      },
      teamId: "team",
      verification: {
        gatewayOrigin: configuration.gateway.gatewayOrigin,
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: configuration.gateway.publicOrigin,
      },
    };
    f.plan.effects.push(
      { description: "Gateway bindings", id: "gateway-bindings", kind: "gateway-bindings" },
      { description: "Gateway delivery", id: "gateway-delivery", kind: "gateway-delivery" },
    );
    requireOperator(f.destination.record).plan = f.plan;
    requireOperator(f.destination.record).planDigest = operatorPlanDigest(f.plan);
    f.effect.checkpointGatewayEnvironment = unavailable;
    const verifySharedAuthAdoption = vi.fn(
      async (
        input: Parameters<
          Awaited<ReturnType<typeof createHostedOperatorControlPlane>>["verifySharedAuthAdoption"]
        >[0],
      ) =>
        await f.api.verify({
          ...input,
          verifyReadiness: async (verification) => {
            await verification.assertCurrent();
            await input.verifyCanonicalOwnership();
            return structuredClone(requirePreparation(f.source.record));
          },
        }),
    );
    const controlPlane: Awaited<ReturnType<typeof createHostedOperatorControlPlane>> = {
      assertAuthorized: f.assertAuthorized,
      assertMembershipCapture: unavailable,
      assertPlanningAuthorized: unavailable,
      authorize: unavailable,
      checkpointSharedAuthAdoption,
      close: unavailable,
      consumeOwnerRealmIdentityCallback: unavailable,
      prepareRealmIdentityLink: unavailable,
      prepareResourceCredentials: unavailable,
      publishAuthPlan: unavailable,
      readApproval: unavailable,
      readAuthPlan: unavailable,
      readCapturedRealmIdentity: unavailable,
      readCapturedRealmIdentityProof: unavailable,
      readCredential: unavailable,
      readCurrentPlanningOwner: unavailable,
      readGeneratedRelease: unavailable,
      readGeneratedSelection: unavailable,
      readPendingRealmIdentityLinkForStaging: unavailable,
      readRealmIdentityLink: unavailable,
      readResourceBindings: unavailable,
      readRetirementResourceCredentials: unavailable,
      readSharedAuthAdoption: unavailable,
      readSharedGatewayRows: unavailable,
      reserveRealmIdentityLink: unavailable,
      resolveRealmIdentityCallbackContext: unavailable,
      store: {
        compareAndSet: unavailable,
        read: unavailable,
        reserve: unavailable,
        reserveFenceGeneration: unavailable,
      },
      verifySharedAuthAdoption,
      withResourceLease: unavailable,
    };
    const native = composeHostedOperatorDependencies(configuration, controlPlane);
    checkpointSharedAuthAdoption.mockImplementationOnce(async (input) => {
      const result = await f.api.checkpoint(input);
      f.effect.plan = { ...f.plan, authDatabase: resource("unapproved") };
      return result;
    });
    await expect(native.reconcile(f.effect)).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    f.effect.plan = f.plan;
    expect(checkpointSharedAuthAdoption).toHaveBeenCalledOnce();
    expect(f.destination.record.privateState).toBeDefined();
    expect(verifySharedAuthAdoption).toHaveBeenCalledOnce();
    expect(verifyCanonicalOwnership).toHaveBeenCalledOnce();
    expect(verifySharedAuthAdoption.mock.calls[0]?.[0].effect.plan.authDatabase.database).toBe(
      "auth",
    );
    expect(unavailable).not.toHaveBeenCalled();
    await expect(
      native.executeEffect({
        ...f.effect,
        bindWorkerContext: unavailable,
        workerAttemptId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(unavailable).not.toHaveBeenCalled();
    expect(checkpointSharedAuthAdoption).toHaveBeenCalledOnce();
    const schemaEffect = f.plan.effects.find((effect) => effect.id === "auth-schema");
    if (schemaEffect === undefined) {
      throw new Error("Missing Auth schema fixture");
    }
    await expect(native.reconcile({ ...f.effect, effect: schemaEffect })).rejects.toMatchObject({
      code: "reconciliation_required",
    });
    await expect(
      native.executeEffect({
        ...f.effect,
        bindWorkerContext: unavailable,
        effect: schemaEffect,
        workerAttemptId: randomUUID(),
      }),
    ).rejects.toMatchObject({ code: "reconciliation_required" });
    expect(unavailable).not.toHaveBeenCalled();
  });
});
