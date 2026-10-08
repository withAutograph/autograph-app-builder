import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import {
  createNativePreviewNeonExecutionAuthority,
  createNativePreviewNeonPlanningAuthority,
  createNativePreviewNeonReconciliationAuthority,
} from "./hosted-operator-native-preview-authority";
import type { HostedOperatorWorkerEffectContext } from "./hosted-operator-service";
import type { createHostedOperatorControlPlane } from "./hosted-operator-deployment";

const authority = {
  audience: "https://builder.example.test/mcp",
  issuer: "https://builder.example.test/api/auth",
  ownerUserId: "fixture-owner",
  workspaceId: "fixture-workspace",
};
const target = {
  appId: "reports",
  branch: "qualification",
  environment: "preview" as const,
  installationId: "icfg-owner",
  projectId: "prj-app",
  scopeId: "team-owner",
  scopeType: "team" as const,
  sessionId: "fixture-session",
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "fixture-actor", organizationId: "fixture-org", roles: ["member"] }],
  action: "prepare",
  appDatabase: {
    database: "app_db",
    migratorRole: "app_owner",
    resourceId: "app-resource",
    runtimeRole: "app_runtime",
  },
  authDatabase: {
    database: "auth_db",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "bootstrap_owner" },
  contextId: "fixture-context",
  cost: {
    class: "shared-recovery-group",
    description: "Owned source fixture",
    owner: "Fixture owner",
  },
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
    { description: "Install checked release", id: "install", kind: "install" },
    { description: "Grant reviewed access", id: "access", kind: "access" },
    { description: "Bind restricted runtime", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "fixture-worker", sha256: "a".repeat(64) },
  neon: {
    branchId: "br-fixture",
    connectionRef: "fixture-native-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: target.branch,
    origin: "https://gateway.example.test",
    projectId: "prj-gateway",
  },
  release: { artifactRef: "fixture-release", id: "fixture-release", sha256: "c".repeat(64) },
  resourcesInstaller: { reference: "fixture-resources-worker", sha256: "b".repeat(64) },
  retention: { expiresAt: "2030-01-01T00:00:00.000Z", policy: "Owned fixture" },
  selection: {
    appId: target.appId,
    branch: target.branch,
    environment: target.environment,
    projectId: target.projectId,
    sessionId: target.sessionId,
  },
  version: 1,
});
const nativeStore = {
  configurationId: "icfg-native",
  resourceId: "store-native",
  sourceProjectId: "prj-source",
};
const scope = {
  branchId: plan.neon.branchId,
  endpointId: "ep-fixture",
  hostname: plan.neon.endpoint,
  maintenanceDatabase: "neondb",
  maintenanceRole: "bootstrap_owner",
  projectId: plan.neon.projectId,
};
const forbidden = async (): Promise<never> =>
  await Promise.reject(new Error("Read-only fixture cannot write"));
const fixture = () => {
  const operationRef = randomUUID();
  const attemptId = randomUUID();
  const now = Date.now();
  let member = true;
  let approved = true;
  let credentialActive = true;
  const [resourceEffect] = plan.effects;
  if (resourceEffect === undefined) {
    throw new Error("Missing fixture effect");
  }
  const effect: HostedOperatorWorkerEffectContext = {
    assertCurrent: vi.fn(async () => {
      await Promise.resolve();
    }),
    authority,
    bindWorkerContext: async () =>
      await Promise.resolve(async () => {
        await Promise.resolve();
      }),
    checkpoint: vi.fn(async () => {
      await Promise.resolve();
    }),
    effect: plan.effects[0],
    fenceGeneration: 4,
    operationRef,
    plan,
    target,
    workerAttemptId: attemptId,
    workerCheckpoints: [],
  };
  const record = hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "fixture-call",
    kind: "app-runtime",
    leaseExpiresAt: new Date(now + 60_000).toISOString(),
    leaseId: randomUUID(),
    operator: {
      approvalId: "fixture-approval",
      fenceGeneration: 4,
      mode: "protected-operator-v1",
      operationRef,
      pendingEffectAttempt: { id: attemptId },
      pendingEffectId: effect.effect.id,
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: [],
    },
    request: target,
    status: "pending",
    step: "planned",
    version: 1,
  });
  const { operator } = record;
  if (operator === undefined || operator.pendingEffectAttempt === undefined) {
    throw new Error("Missing fixture operator");
  }
  const pendingAttempt = operator.pendingEffectAttempt;
  const credential = {
    binding: {
      active: true,
      displayName: "Fixture team",
      installationId: target.installationId,
      plan: "pro",
      scopeId: target.scopeId,
      scopeType: target.scopeType,
      slug: "fixture-team",
      updatedAt: new Date("2026-10-08T00:00:00Z"),
    },
    token: "synthetic-owner-oauth",
  };
  type Plane = Pick<
    Awaited<ReturnType<typeof createHostedOperatorControlPlane>>,
    "store" | "assertAuthorized" | "readApproval" | "readCredential"
  >;
  const controlPlane: Plane = {
    assertAuthorized: vi.fn(async () => {
      if (!member) {
        throw new Error("Owner revoked");
      }
      await Promise.resolve();
    }),
    readApproval: vi.fn(async () => {
      if (!approved) {
        throw new Error("Approval revoked");
      }
      return await Promise.resolve({
        action: "prepare" as const,
        approvalId: "fixture-approval",
        approved: true,
        callId: record.approvedByCallId,
        planDigest: operatorPlanDigest(plan),
      });
    }),
    readCredential: vi.fn(
      async () => await Promise.resolve(credentialActive ? credential : undefined),
    ),
    store: {
      compareAndSet: forbidden,
      read: vi.fn(async () => await Promise.resolve({ record, revision: 1 })),
      reserve: forbidden,
      reserveFenceGeneration: forbidden,
    },
  };
  let duringGet: (() => void) | undefined;
  const store = {
    connectionString: "must-never-return-private-material",
    externalResourceId: plan.neon.projectId,
    id: nativeStore.resourceId,
    ownerId: target.scopeId,
    product: { integrationConfigurationId: nativeStore.configurationId, slug: "neon" },
    projectsMetadata: [{ projectId: nativeStore.sourceProjectId }],
    status: "available",
    type: "integration",
  };
  const fetcher = vi.fn<typeof fetch>(async (input, init) => {
    await Promise.resolve();
    expect(init?.method).toBe("GET");
    expect(init?.redirect).toBe("error");
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.origin).toBe("https://api.vercel.com");
    expect(url.searchParams.get("teamId")).toBe(target.scopeId);
    duringGet?.();
    if (url.pathname === `/v9/projects/${nativeStore.sourceProjectId}`) {
      return Response.json({
        accountId: target.scopeId,
        id: nativeStore.sourceProjectId,
        name: "Fixture source project",
      });
    }
    if (url.pathname === "/v1/storage/stores") {
      return Response.json({ stores: [store] });
    }
    if (url.pathname === `/v1/storage/stores/${nativeStore.resourceId}`) {
      return Response.json({ store });
    }
    throw new Error("Unexpected provider path");
  });
  return {
    callbacks: () =>
      createNativePreviewNeonExecutionAuthority({
        controlPlane,
        effect,
        fetch: fetcher,
        nativeStore,
        now: () => now,
      }),
    controlPlane,
    duringGet: (run: () => void) => {
      duringGet = run;
    },
    effect,
    fetcher,
    now,
    operator,
    pendingAttempt,
    record,
    setApproved: (value: boolean) => {
      approved = value;
    },
    setCredential: (value: boolean) => {
      credentialActive = value;
    },
    setMember: (value: boolean) => {
      member = value;
    },
    store,
  };
};
describe("concrete native Preview owner and approval callbacks", () => {
  it("reads owner-authorized planning scope and actual native store without inventing an approved plan", async () => {
    const f = fixture();
    const assertPlanningAuthorized = vi.fn(async () => {
      await Promise.resolve();
    });
    const reader = createNativePreviewNeonPlanningAuthority({
      context: f.effect,
      controlPlane: { assertPlanningAuthorized, readCredential: f.controlPlane.readCredential },
      fetch: f.fetcher,
      nativeStore,
      scope,
    });
    await reader.assertPlanningScope(f.effect, scope);
    expect(await reader.readCurrentOwnerNativeStore(f.effect, nativeStore)).toMatchObject({
      neonProjectId: scope.projectId,
      ownerId: target.scopeId,
    });
    expect(f.controlPlane.readApproval).not.toHaveBeenCalled();
    expect(assertPlanningAuthorized).toHaveBeenCalled();
    await expect(
      reader.assertPlanningScope(f.effect, { ...scope, branchId: "foreign" }),
    ).rejects.toThrow();
    assertPlanningAuthorized.mockRejectedValue(new Error("revoked"));
    await expect(reader.readCurrentOwnerNativeStore(f.effect, nativeStore)).rejects.toThrow();
  });

  it("authorizes exact app retirement only under its actual cleanup approval and recorded attempt", async () => {
    const f = fixture();
    const cleanup = hostedOperatorPlanSchema.parse({
      ...plan,
      action: "cleanup",
      effects: [
        { description: "Close app and Auth assignments", id: "revoke", kind: "revoke" },
        { description: "Remove owned app environment", id: "remove", kind: "remove-bindings" },
        {
          description: "Retire owned app database",
          id: "retire",
          kind: "retire",
          resourceId: plan.appDatabase.resourceId,
        },
      ],
    });
    const effect = cleanup.effects.at(-1);
    if (effect === undefined) {
      throw new Error("Missing owned retirement fixture");
    }
    f.effect.plan = cleanup;
    f.effect.effect = effect;
    f.operator.plan = cleanup;
    f.operator.planDigest = operatorPlanDigest(cleanup);
    f.operator.pendingEffectId = effect.id;
    f.controlPlane.readApproval = async () =>
      await Promise.resolve({
        action: "cleanup",
        approvalId: "fixture-approval",
        approved: true,
        callId: f.record.approvedByCallId,
        planDigest: operatorPlanDigest(cleanup),
      });
    await f.callbacks().assertApprovedScope(f.effect, scope);
    f.controlPlane.readApproval = async () =>
      await Promise.resolve({
        action: "prepare",
        approvalId: "fixture-approval",
        approved: true,
        callId: f.record.approvedByCallId,
        planDigest: operatorPlanDigest(cleanup),
      });
    await expect(f.callbacks().assertApprovedScope(f.effect, scope)).rejects.toThrow();
  });

  it("maps exact approved scope and reads the actual owner project and native store with allowlisted identity only", async () => {
    const f = fixture();
    const callbacks = f.callbacks();
    await callbacks.assertApprovedScope(f.effect, scope);
    expect(await callbacks.readCurrentOwnerNativeStore(f.effect, nativeStore)).toEqual({
      configurationId: nativeStore.configurationId,
      neonProjectId: plan.neon.projectId,
      ownerId: target.scopeId,
      resourceId: nativeStore.resourceId,
      vercelProjectId: nativeStore.sourceProjectId,
    });
    expect(f.fetcher).toHaveBeenCalledTimes(3);
    expect(f.controlPlane.readCredential).toHaveBeenCalledWith(authority, target.installationId);
  });
  it.each([
    "projectId",
    "branchId",
    "hostname",
    "endpointId",
    "maintenanceDatabase",
    "maintenanceRole",
  ])("rejects a scope outside the frozen plan: %s", async (field) => {
    const f = fixture();
    await expect(
      f.callbacks().assertApprovedScope(f.effect, { ...scope, [field]: "other" }),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
  });
  it.each(["membership", "approval", "credential", "fence", "attempt", "expiry"])(
    "rejects revoked or stale authority: %s",
    async (change) => {
      const f = fixture();
      if (change === "membership") {
        f.setMember(false);
      }
      if (change === "approval") {
        f.setApproved(false);
      }
      if (change === "credential") {
        f.setCredential(false);
      }
      if (change === "fence") {
        f.operator.fenceGeneration = 5;
      }
      if (change === "attempt") {
        f.pendingAttempt.id = randomUUID();
      }
      if (change === "expiry") {
        f.record.leaseExpiresAt = new Date(f.now - 1).toISOString();
      }
      await expect(
        f.callbacks().readCurrentOwnerNativeStore(f.effect, nativeStore),
      ).rejects.toThrow();
      expect(f.fetcher).not.toHaveBeenCalled();
    },
  );
  it.each(["membership", "approval", "fence"])(
    "rechecks current authority after provider GET: %s",
    async (change) => {
      const f = fixture();
      f.duringGet(() => {
        if (change === "membership") {
          f.setMember(false);
        }
        if (change === "approval") {
          f.setApproved(false);
        }
        if (change === "fence") {
          f.operator.fenceGeneration = 5;
        }
      });
      await expect(
        f.callbacks().readCurrentOwnerNativeStore(f.effect, nativeStore),
      ).rejects.toThrow();
      expect(f.fetcher).toHaveBeenCalledTimes(1);
    },
  );
  it("rejects changed owner/native-store identity without exposing provider credentials", async () => {
    const f = fixture();
    f.store.ownerId = "another-team";
    await expect(
      f.callbacks().readCurrentOwnerNativeStore(f.effect, nativeStore),
    ).rejects.toThrow();
    const other = fixture();
    await expect(
      other
        .callbacks()
        .readCurrentOwnerNativeStore(other.effect, { ...nativeStore, configurationId: "other" }),
    ).rejects.toThrow();
    expect(other.fetcher).not.toHaveBeenCalled();
  });
  it("supports first reconciliation without a worker attempt and recorded same-effect recovery", async () => {
    const f = fixture();
    delete f.operator.pendingEffectId;
    delete f.operator.pendingEffectAttempt;
    const callbacks = createNativePreviewNeonReconciliationAuthority({
      controlPlane: f.controlPlane,
      effect: f.effect,
      fetch: f.fetcher,
      nativeStore,
      now: () => f.now,
    });
    await expect(callbacks.assertApprovedScope(f.effect, scope)).resolves.toBeUndefined();
    f.record.status = "failed";
    f.operator.pendingEffectId = f.effect.effect.id;
    f.operator.pendingEffectAttempt = { id: randomUUID() };
    await expect(callbacks.assertApprovedScope(f.effect, scope)).resolves.toBeUndefined();
    await expect(f.callbacks().assertApprovedScope(f.effect, scope)).rejects.toThrow();
    f.operator.pendingEffectId = "app-resources";
    await expect(callbacks.assertApprovedScope(f.effect, scope)).rejects.toThrow();
  });
});

it.each(["externalResourceId", "product", "projectsMetadata"])(
  "rejects provider native metadata outside the exact selected Neon/store/config: %s",
  async (field) => {
    const f = fixture();
    if (field === "externalResourceId") {
      f.store.externalResourceId = "another-neon-project";
    }
    if (field === "product") {
      f.store.product.integrationConfigurationId = "another-configuration";
    }
    if (field === "projectsMetadata") {
      f.store.projectsMetadata = [{ projectId: "another-project" }];
    }
    await expect(
      f.callbacks().readCurrentOwnerNativeStore(f.effect, nativeStore),
    ).rejects.toThrow();
  },
);
it("rejects a source project whose provider owner response mismatches the current OAuth grant", async () => {
  const f = fixture();
  const callbacks = createNativePreviewNeonExecutionAuthority({
    controlPlane: f.controlPlane,
    effect: f.effect,
    fetch: async () =>
      await Promise.resolve(
        Response.json({
          accountId: "another-team",
          id: nativeStore.sourceProjectId,
          name: "Wrong owner",
        }),
      ),
    nativeStore,
    now: () => f.now,
  });
  await expect(callbacks.readCurrentOwnerNativeStore(f.effect, nativeStore)).rejects.toThrow();
});
it("rejects a different owner context before any provider request", async () => {
  const f = fixture();
  await expect(
    f
      .callbacks()
      .assertApprovedScope(
        { ...f.effect, authority: { ...authority, ownerUserId: "another-owner" } },
        scope,
      ),
  ).rejects.toThrow();
  expect(f.fetcher).not.toHaveBeenCalled();
});
