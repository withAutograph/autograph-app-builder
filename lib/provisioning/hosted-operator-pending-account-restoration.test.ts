/* oxlint-disable unicorn/no-useless-undefined -- Undefined models journal CAS conflicts explicitly. */
import { describe, expect, it, vi } from "vitest";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { HostedOperatorPlan } from "./hosted-operator-contract";
import type {
  HostedOperatorContext,
  ProtectedHostedOperatorDependencies,
} from "./hosted-operator-service";
import { createProtectedHostedOperatorHandler } from "./hosted-operator-service";
import {
  hostedRuntimeJournalRecordSchema,
  retainedOperatorAuthFromJournal,
} from "./hosted-runtime-journal";
import type { HostedRuntimeJournalRow } from "./hosted-runtime-journal";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
  initialNormalActorState,
} from "./hosted-operator-normal-actor-program";
import { hostedOperatorRealmLinkConfigSha256 } from "./hosted-operator-realm-link-config";
import { inspectParticipantBootstrapPreparation } from "./hosted-operator-participant-bootstrap";
import {
  encryptNormalActorState,
  decryptNormalActorState,
} from "./hosted-operator-normal-actor-state";
import { restorePendingAccountPreparation } from "./hosted-operator-pending-account-restoration";
import { createNormalActorJournalAuthority } from "./hosted-operator-normal-actor-authority";

const resource = (name: string) => ({
  database: name,
  migratorRole: `${name}_owner`,
  resourceId: `${name}-resource`,
  runtimeRole: `${name}_runtime`,
});
const authority = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  workspaceId: "workspace",
};
const context: HostedOperatorContext = {
  authority,
  ownerContext: {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority,
    kind: "direct",
    principal: { ...authority, scopes: ["autograph:get"] },
    sessionId: "session",
  },
  target: {
    appId: "actual",
    branch: "feature/actual-publication",
    environment: "preview",
    installationId: "installation",
    projectId: "prj_actual",
    scopeId: "team",
    scopeType: "team",
    sessionId: "session",
  },
};
const bootstrapPlan = () =>
  hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
    appDatabase: resource("app"),
    authDatabase: resource("auth"),
    authSchema: {
      artifactRef: "auth-artifact",
      installer: { reference: "auth-worker", sha256: "d".repeat(64) },
      planDigest: "e".repeat(64),
      targetDigest: "f".repeat(64),
    },
    bootstrap: { endpointId: "ep-fixture", maintenanceDatabase: "neondb", role: "neondb_owner" },
    contextId: "spec-digest",
    cost: { class: "shared-recovery-group", description: "Fixture bootstrap", owner: "owner" },
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
      { description: "Auth schema", id: "auth-schema", kind: "install" },
    ],
    installer: { reference: "app-worker", sha256: "a".repeat(64) },
    neon: {
      branchId: "br-fixture",
      connectionRef: "native-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon-fixture",
      source: "synthetic-only",
    },
    release: { artifactRef: "release-artifact", id: "release", sha256: "b".repeat(64) },
    resourcesInstaller: { reference: "resources-worker", sha256: "c".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Retain shared Auth" },
    selection: {
      appId: context.target.appId,
      branch: context.target.branch,
      environment: "preview",
      projectId: context.target.projectId,
      sessionId: context.target.sessionId,
    },
    stage: "auth-bootstrap",
    version: 1,
  });

const operationRef = "00000000-0000-4000-8000-000000000001";
const observedAt = "2026-10-14T12:00:00Z";
const sourceWorkload = {
  audience: "https://vercel.com/team",
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  environment: "preview" as const,
  subject: "builder-workload",
};
const desiredPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...bootstrapPlan(),
    normalActorProgram: normalActorProgramSchema.parse({
      version: 1,
      appId: context.target.appId,
      origin: "https://apps.example",
      actors: [
        {
          actorKey: "owner",
          email: "owner@example.test",
          name: "Owner",
          account: "capture-existing",
        },
      ],
      organizations: [],
      memberships: [],
      appAccess: [],
    }),
    publicGateway: {
      projectId: "gateway",
      branch: context.target.branch,
      origin: "https://apps.example",
    },
    deploymentBoundary: {
      authority,
      teamId: "team",
      app: {
        projectId: context.target.projectId,
        deploymentId: "app-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      gateway: {
        projectId: "gateway",
        deploymentId: "gateway-deployment",
        branch: context.target.branch,
        environment: "preview",
      },
      operator: {
        projectId: "operator",
        deploymentId: "operator-deployment",
        environment: "preview",
      },
      verification: {
        gatewayOrigin: "https://gateway.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: "https://apps.example",
      },
    },
    gatewayBindings: {
      authBrowserOrigin: "https://apps.example",
      builderCallbackOrigin: "https://builder.example",
      operatorOrigin: "https://operator.example",
      catalogAppIds: [context.target.appId],
      sourceWorkload,
    },
    gatewayDelivery: {
      projectId: "gateway",
      branch: context.target.branch,
      repoId: "gateway-repo",
      gitSha: "c".repeat(40),
    },
    effects: [
      ...bootstrapPlan().effects,
      { id: "gateway-bindings", kind: "gateway-bindings", description: "Gateway configuration" },
      { id: "gateway-delivery", kind: "gateway-delivery", description: "Gateway delivery" },
    ],
  });
const completedRecord = (plan: HostedOperatorPlan = desiredPlan()) =>
  hostedRuntimeJournalRecordSchema.parse({
    version: 1,
    kind: "app-runtime",
    approvedByCallId: "ordinary-public-approval",
    request: context.target,
    status: "pending",
    step: "reserved",
    privateState: {
      encryptedToken: "private-ciphertext",
      keyVersion: "key-version",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    operator: {
      mode: "protected-operator-v1",
      approvalId: "actual-approval",
      operationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      authPreparation: {
        assetSha256: "d".repeat(64),
        catalogFingerprint: "e".repeat(64),
        database: plan.authDatabase.database,
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: plan.authSchema?.targetDigest,
        observedAt,
      },
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt,
        resourceVersion: "actual-readback",
      })),
      gatewayEnvironment: [
        {
          key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
          id: "owned-environment-row",
          projectId: "gateway",
          branch: context.target.branch,
          operationRef,
          comment: `App Builder protected operator ${operationRef}`,
          valueSha256: hostedOperatorRealmLinkConfigSha256(plan),
        },
      ],
      gatewayDeliveryCandidates: [
        {
          projectId: "gateway",
          branch: context.target.branch,
          repoId: "gateway-repo",
          operationRef,
          origin: "https://gateway.example",
          deploymentId: "gateway-delivery",
          readyState: "READY",
        },
      ],
      deliveredGatewayDeploymentId: "gateway-delivery",
    },
  });

const required = <T>(value: T | undefined): T => {
  if (value === undefined) {
    throw new Error("Missing controlled fixture");
  }
  return value;
};
const now = Date.parse(observedAt);
const accountOperationRef = "00000000-0000-4000-8000-000000000002";
const keyring = { tokenKey: Buffer.alloc(32, 4), tokenKeyVersion: "v1" };
const setup = () => {
  const record = completedRecord();
  const live = required(record.operator);
  const accountPlan = hostedOperatorPlanSchema.parse({
    ...live.plan,
    stage: "auth-participants",
    gatewayDelivery: { ...live.plan.gatewayDelivery, gitSha: "a".repeat(40) },
    effects: [
      {
        id: "normal-accounts",
        kind: "normal-accounts",
        description: "Capture the approved existing account",
      },
    ],
  });
  const program = required(accountPlan.normalActorProgram);
  record.retainedAuth = retainedOperatorAuthFromJournal(record);
  record.accountPreparation = {
    accountOperationRef,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    accountApprovalId: "account-approval",
    accountApprovedByCallId: "account-call",
    programDigest: normalActorProgramDigest(program),
    program,
    accountPlan,
    sealedState: encryptNormalActorState({
      authority,
      ownerSessionId: context.target.sessionId,
      operationRef: accountOperationRef,
      program,
      config: keyring,
      state: initialNormalActorState(program, accountOperationRef),
    }),
    captures: [
      {
        reference: "00000000-0000-4000-8000-000000000003",
        actorKey: "owner",
        nonceSha256: "a".repeat(64),
        proofSha256: "b".repeat(64),
        expiresAt: "2027-01-01T00:00:00Z",
      },
    ],
    pendingCaptures: [
      { actorKey: "owner", nonceSha256: "c".repeat(64), expiresAt: "2027-01-01T00:00:00Z" },
    ],
    organizationProofs: [],
    supersededOrganizationProofs: [],
  };
  let row: HostedRuntimeJournalRow = { revision: 1, record };
  const read = vi.fn(async () => await Promise.resolve(structuredClone(row)));
  const compareAndSet = vi.fn<ProtectedHostedOperatorDependencies["store"]["compareAndSet"]>(
    async (input) => {
      if (input.expectedRevision !== row.revision) {
        return undefined;
      }
      row = {
        revision: row.revision + 1,
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
      };
      return await Promise.resolve(structuredClone(row));
    },
  );
  const assertAuthorized = vi.fn<ProtectedHostedOperatorDependencies["assertAuthorized"]>(
    async () => {},
  );
  const readApproval = vi.fn<ProtectedHostedOperatorDependencies["readApproval"]>(
    async (input) =>
      await Promise.resolve({
        action: "prepare",
        approved: true,
        callId: input.callId,
        planDigest: input.planDigest,
        approvalId: input.callId === "account-call" ? "account-approval" : "actual-approval",
      }),
  );
  const ports = { store: { read, compareAndSet }, assertAuthorized, readApproval };
  const input = { action: "plan", operation: "prepare", selection: accountPlan.selection } as const;
  return {
    ports,
    input,
    accountPlan,
    get row() {
      return row;
    },
    run: () => restorePendingAccountPreparation(ports, context, input, accountPlan, () => now),
  };
};

describe("pending account restoration after completed infrastructure", () => {
  it("restores exact account authority and retains completed Gateway and previous history without provider effects", async () => {
    const f = setup();
    const before = structuredClone(f.row.record);
    const original = required(before.accountPreparation);
    const current = required(before.operator);
    await expect(f.run()).resolves.toMatchObject({
      operationRef: accountOperationRef,
      planDigest: original.accountPlanDigest,
      plan: original.accountPlan,
    });
    const after = f.row.record;
    expect(
      decryptNormalActorState({
        authority,
        ownerSessionId: context.target.sessionId,
        operationRef: accountOperationRef,
        program: original.program,
        config: keyring,
        sealed: required(after.accountPreparation).sealedState,
      }),
    ).toEqual(initialNormalActorState(original.program, accountOperationRef));
    expect(after.accountPreparation).toEqual(original);
    expect(after.privateState).toEqual(before.privateState);
    expect(after.approvedByCallId).toBe(original.accountApprovedByCallId);
    expect(after.operator).toMatchObject({
      operationRef: accountOperationRef,
      approvalId: original.accountApprovalId,
      planDigest: original.accountPlanDigest,
      plan: original.accountPlan,
      receipts: [],
      authPreparation: current.authPreparation,
      gatewayEnvironment: current.gatewayEnvironment,
      gatewayDeliveryCandidates: current.gatewayDeliveryCandidates,
      deliveredGatewayDeploymentId: current.deliveredGatewayDeploymentId,
    });
    expect(after.pendingAccountRestorations).toEqual([
      {
        approvedByCallId: before.approvedByCallId,
        operator: current,
        retainedAuth: before.retainedAuth,
      },
    ]);
    expect(after.retainedAuth).toEqual(retainedOperatorAuthFromJournal(before));
    expect(inspectParticipantBootstrapPreparation(current.plan, after).gatewayPrepared).toBe(true);
    await expect(f.run()).resolves.toBeNull();
    expect(f.ports.store.compareAndSet).toHaveBeenCalledOnce();
    expect(f.ports.readApproval.mock.calls.map(([call]) => call.callId)).toEqual([
      before.approvedByCallId,
      original.accountApprovedByCallId,
    ]);
  });

  it.each(["lease", "expired-lease", "pending-effect", "pending-attempt", "missing-receipt"])(
    "preserves unknown work and refuses %s",
    async (kind) => {
      const f = setup();
      const record = f.row.record;
      const operator = required(record.operator);
      if (kind === "lease" || kind === "expired-lease") {
        record.leaseId = "00000000-0000-4000-8000-000000000004";
        record.leaseExpiresAt = kind === "lease" ? "2027-01-01T00:00:00Z" : observedAt;
      }
      if (kind === "pending-effect") {
        operator.pendingEffectId = "gateway-delivery";
      }
      if (kind === "pending-attempt") {
        operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000004" };
      }
      if (kind === "missing-receipt") {
        operator.receipts.pop();
      }
      const before = structuredClone(record);
      await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
      expect(f.row.record).toEqual(before);
      expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
    },
  );

  it.each(["account", "bootstrap"])("requires the actual %s human approval", async (which) => {
    const f = setup();
    f.ports.readApproval.mockImplementation(
      async (input) =>
        await Promise.resolve({
          action: "prepare",
          approved:
            input.callId !== (which === "account" ? "account-call" : "ordinary-public-approval"),
          callId: input.callId,
          planDigest: input.planDigest,
          approvalId: input.callId === "account-call" ? "account-approval" : "actual-approval",
        }),
    );
    await expect(f.run()).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  });

  it.each(["account", "bootstrap"])("requires unexpired %s authority", async (which) => {
    const f = setup();
    const plan = which === "account" ? f.accountPlan : required(f.row.record.operator).plan;
    plan.retention.expiresAt = observedAt;
    await expect(f.run()).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  });

  it("rejects even a harmless proposed expiry refresh instead of changing the frozen plan", async () => {
    const f = setup();
    const proposal = structuredClone(f.accountPlan);
    proposal.retention.expiresAt = "2028-01-01T00:00:00Z";
    await expect(
      restorePendingAccountPreparation(f.ports, context, f.input, proposal, () => now),
    ).resolves.toBeNull();
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  });

  it("rechecks owner authority immediately before publication", async () => {
    const f = setup();
    f.ports.assertAuthorized
      .mockResolvedValueOnce()
      .mockResolvedValueOnce()
      .mockRejectedValueOnce(new HostedOperatorError("authorization_required"));
    await expect(f.run()).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  });

  it("rereads both approvals after a CAS conflict and refuses a newly pending write", async () => {
    const f = setup();
    f.ports.store.compareAndSet.mockImplementationOnce(async () => {
      required(f.row.record.operator).pendingEffectId = "gateway-delivery";
      await Promise.resolve();
      return undefined;
    });
    await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(f.row.record.operator?.operationRef).toBe(operationRef);
  });
});

it("restores through ordinary planner then satisfies idle account/capture authority on the retained Gateway", async () => {
  const f = setup();
  const forbidden = vi.fn(() => {
    throw new Error("No provider effects during planning");
  });
  const deps: ProtectedHostedOperatorDependencies = {
    ...f.ports,
    now: () => now,
    store: {
      ...f.ports.store,
      reserve: async () => await Promise.resolve(f.row),
      reserveFenceGeneration: forbidden,
    },
    authorize: async () => await Promise.resolve(context),
    plan: async () => await Promise.resolve(f.accountPlan),
    readApprovedPlan: forbidden,
    withResourceLease: forbidden,
    reconcile: forbidden,
    executeEffect: forbidden,
    verify: forbidden,
    bindings: forbidden,
  };
  const response = await createProtectedHostedOperatorHandler(deps)(
    new Request("https://operator.example/v1/runtime", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(f.input),
    }),
  );
  expect(await response.json()).toMatchObject({
    status: "planned",
    operationRef: accountOperationRef,
    plan: f.accountPlan,
  });
  const owner = vi.fn(async () => {});
  const captureAuthority = createNormalActorJournalAuthority({
    store: f.ports.store,
    keyring,
    now: () => now,
    assertCanonicalOwner: owner,
    assertApprovedOwner: f.ports.assertAuthorized,
    readApproval: f.ports.readApproval,
  });
  await captureAuthority.assertMutationAuthority(context, f.row);
  await captureAuthority.assertAccountApproval(context, required(f.row.record.accountPreparation));
  const restored = required(f.row.record.operator);
  const auth = required(f.row.record.retainedAuth);
  expect(restored.plan.stage).toBe("auth-participants");
  expect(restored.operationRef).toBe(accountOperationRef);
  expect(restored.authPreparation).toEqual(auth.authPreparation);
  expect(restored.plan.authDatabase).toEqual(auth.plan.authDatabase);
  expect(restored.plan.neon).toEqual(auth.plan.neon);
  expect(inspectParticipantBootstrapPreparation(auth.plan, f.row.record).gatewayPrepared).toBe(
    true,
  );
  expect(forbidden).not.toHaveBeenCalled();
});

it("rereads original and current approvals on a successful CAS retry", async () => {
  const f = setup();
  f.ports.store.compareAndSet.mockResolvedValueOnce(undefined);
  await f.run();
  expect(f.ports.readApproval.mock.calls.map(([input]) => input.callId)).toEqual([
    "ordinary-public-approval",
    "account-call",
    "ordinary-public-approval",
    "account-call",
  ]);
  expect(f.row.record.pendingAccountRestorations).toHaveLength(1);
});

it.each(["auth-resource", "app-resource", "browser", "issuer", "program", "gateway-candidate"])(
  "refuses changed %s scope or missing Gateway evidence",
  async (change) => {
    const f = setup();
    const live = required(f.row.record.operator);
    if (change === "auth-resource") {
      live.plan.authDatabase.database = "other_auth";
    }
    if (change === "app-resource") {
      live.plan.appDatabase.database = "other_app";
    }
    if (change === "browser") {
      required(live.plan.gatewayBindings).authBrowserOrigin = "https://other.example";
    }
    if (change === "issuer") {
      required(live.plan.gatewayBindings).operatorOrigin = "https://other.example";
    }
    if (change === "program") {
      required(live.plan.normalActorProgram).actors[0].email = "other@example.test";
    }
    if (change === "gateway-candidate") {
      live.gatewayDeliveryCandidates = [];
    }
    live.planDigest = operatorPlanDigest(live.plan);
    await expect(f.run()).rejects.toBeInstanceOf(HostedOperatorError);
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  },
);

it("archives old success/failure histories and settled execution observation without reusing its active authority", async () => {
  const f = setup();
  const record = f.row.record;
  const current = required(record.operator);
  record.pendingAccountRestorations = [
    {
      approvedByCallId: "older-call",
      operator: structuredClone(current),
      retainedAuth: record.retainedAuth,
    },
  ];
  record.executionObservation = {
    state: "settled",
    attemptRef: "00000000-0000-4000-8000-000000000004",
    operationRef,
    planDigest: current.planDigest,
    callId: record.approvedByCallId,
    approvalId: required(current.approvalId),
    outcome: { status: "blocked", code: "reconciliation_required" },
  };
  const before = structuredClone(record);
  await f.run();
  expect(f.row.record.pendingAccountRestorations?.[0]).toEqual(
    before.pendingAccountRestorations?.[0],
  );
  expect(f.row.record.pendingAccountRestorations?.[1].executionObservation).toEqual(
    before.executionObservation,
  );
  expect(f.row.record.executionObservation).toBeUndefined();
});

it("refuses any unsettled native execution rather than discarding it", async () => {
  const f = setup();
  const current = required(f.row.record.operator);
  f.row.record.executionObservation = {
    state: "running",
    attemptRef: "00000000-0000-4000-8000-000000000004",
    operationRef,
    planDigest: current.planDigest,
    callId: f.row.record.approvedByCallId,
    approvalId: required(current.approvalId),
  };
  await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});

it.each(["claimed", "unknown", "accepted"] as const)(
  "refuses a current-adapter %s continuation without replay or loss",
  async (status) => {
    const f = setup();
    f.row.record.realmContinuation = {
      dispatchId: "d".repeat(64),
      operationRef,
      approvedPlanDigest: required(f.row.record.operator).planDigest,
      nonceSha256: "e".repeat(64),
      status,
      claimedAt: observedAt,
      adapterSessionId: required(context.ownerContext).adapterSessionId,
      ...(status === "accepted" ? { acceptedAt: observedAt, receiverClaimedAt: observedAt } : {}),
    };
    const before = structuredClone(f.row.record);
    await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
    expect(f.row.record).toEqual(before);
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  },
);

it("archives only accepted old-adapter continuation and stale hook while preserving original pending capture scope", async () => {
  const f = setup();
  const original = required(f.row.record.accountPreparation);
  const operator = required(f.row.record.operator);
  operator.identityLink = {
    audience: required(original.accountPlan.gatewayBindings).operatorOrigin,
    authResourceId: original.accountPlan.authDatabase.resourceId,
    bootstrapPlanDigest: original.accountPlanDigest,
    browserSession: {
      operationRef: original.accountOperationRef,
      participantProgramDigest: original.programDigest,
    },
    browserOrigin: original.program.origin,
    endpointOrigin: "https://gateway.example",
    issuer: required(original.accountPlan.deploymentBoundary).verification.publicOrigin,
    expiresAt: "2027-01-01T00:00:00Z",
    nonceSha256: "c".repeat(64),
    organizationId: null,
    ownerSessionId: context.target.sessionId,
  };
  f.row.record.realmIdentityWait = {
    adapterSessionId: "displaced-adapter",
    approvedPlanDigest: original.accountPlanDigest,
    callId: original.accountApprovedByCallId,
    hook: { encryptedToken: "private-hook", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
    nonceSha256: "c".repeat(64),
    operationRef: accountOperationRef,
    registeredAt: observedAt,
  };
  f.row.record.realmContinuation = {
    dispatchId: "d".repeat(64),
    operationRef: accountOperationRef,
    approvedPlanDigest: original.accountPlanDigest,
    nonceSha256: "c".repeat(64),
    status: "accepted",
    claimedAt: observedAt,
    acceptedAt: observedAt,
    receiverClaimedAt: observedAt,
    adapterSessionId: "displaced-adapter",
  };
  const before = structuredClone(f.row.record);
  await f.run();
  expect(f.row.record.accountPreparation).toEqual(original);
  expect(f.row.record.operator?.identityLink).toEqual(operator.identityLink);
  expect(f.row.record.realmIdentityWait).toBeUndefined();
  expect(f.row.record.realmContinuation).toBeUndefined();
  expect(f.row.record.pendingAccountRestorations?.[0]).toMatchObject({
    realmIdentityWait: before.realmIdentityWait,
    realmContinuation: before.realmContinuation,
  });
});

it("does not discard an old-adapter unknown continuation", async () => {
  const f = setup();
  f.row.record.realmContinuation = {
    dispatchId: "d".repeat(64),
    operationRef,
    approvedPlanDigest: required(f.row.record.operator).planDigest,
    nonceSha256: "e".repeat(64),
    status: "unknown",
    claimedAt: observedAt,
    adapterSessionId: "displaced-adapter",
  };
  await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});

it("leaves unrelated or completed participant planning to the existing generic path", async () => {
  const f = setup();
  required(f.row.record.accountPreparation).accountsCompletedAt = observedAt;
  await expect(f.run()).resolves.toBeNull();
  expect(f.ports.readApproval).not.toHaveBeenCalled();
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});

it("refuses a live mismatched identity wait instead of carrying a stale nonce into account capture", async () => {
  const f = setup();
  const original = required(f.row.record.accountPreparation);
  f.row.record.realmIdentityWait = {
    adapterSessionId: required(context.ownerContext).adapterSessionId,
    approvedPlanDigest: original.accountPlanDigest,
    callId: original.accountApprovedByCallId,
    hook: { encryptedToken: "private-hook", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
    nonceSha256: "c".repeat(64),
    operationRef: accountOperationRef,
    registeredAt: observedAt,
  };
  await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});
