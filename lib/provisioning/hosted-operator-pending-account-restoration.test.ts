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
  environment: "preview" as const,
  issuer: "https://oidc.vercel.com/team",
  ownerId: "team",
  projectId: "builder",
  subject: "builder-workload",
};
const desiredPlan = () =>
  hostedOperatorPlanSchema.parse({
    ...bootstrapPlan(),
    deploymentBoundary: {
      app: {
        branch: context.target.branch,
        deploymentId: "app-deployment",
        environment: "preview",
        projectId: context.target.projectId,
      },
      authority,
      gateway: {
        branch: context.target.branch,
        deploymentId: "gateway-deployment",
        environment: "preview",
        projectId: "gateway",
      },
      operator: {
        deploymentId: "operator-deployment",
        environment: "preview",
        projectId: "operator",
      },
      teamId: "team",
      verification: {
        gatewayOrigin: "https://gateway.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: "https://apps.example",
      },
    },
    effects: [
      ...bootstrapPlan().effects,
      { description: "Gateway configuration", id: "gateway-bindings", kind: "gateway-bindings" },
      { description: "Gateway delivery", id: "gateway-delivery", kind: "gateway-delivery" },
    ],
    gatewayBindings: {
      authBrowserOrigin: "https://apps.example",
      builderCallbackOrigin: "https://builder.example",
      catalogAppIds: [context.target.appId],
      operatorOrigin: "https://operator.example",
      sourceWorkload,
    },
    gatewayDelivery: {
      branch: context.target.branch,
      gitSha: "c".repeat(40),
      projectId: "gateway",
      repoId: "gateway-repo",
    },
    normalActorProgram: normalActorProgramSchema.parse({
      actors: [
        {
          account: "capture-existing",
          actorKey: "owner",
          email: "owner@example.test",
          name: "Owner",
        },
      ],
      appAccess: [],
      appId: context.target.appId,
      memberships: [],
      organizations: [],
      origin: "https://apps.example",
      version: 1,
    }),
    publicGateway: {
      branch: context.target.branch,
      origin: "https://apps.example",
      projectId: "gateway",
    },
  });
const completedRecord = (plan: HostedOperatorPlan = desiredPlan()) =>
  hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "ordinary-public-approval",
    kind: "app-runtime",
    operator: {
      approvalId: "actual-approval",
      authPreparation: {
        assetSha256: "d".repeat(64),
        catalogFingerprint: "e".repeat(64),
        database: plan.authDatabase.database,
        observedAt,
        runtimeRole: plan.authDatabase.runtimeRole,
        targetDigest: plan.authSchema?.targetDigest,
      },
      deliveredGatewayDeploymentId: "gateway-delivery",
      gatewayDeliveryCandidates: [
        {
          branch: context.target.branch,
          deploymentId: "gateway-delivery",
          operationRef,
          origin: "https://gateway.example",
          projectId: "gateway",
          readyState: "READY",
          repoId: "gateway-repo",
        },
      ],
      gatewayEnvironment: [
        {
          branch: context.target.branch,
          comment: `App Builder protected operator ${operationRef}`,
          id: "owned-environment-row",
          key: "PLATFORM_REALM_OPERATOR_LINK_CONFIG",
          operationRef,
          projectId: "gateway",
          valueSha256: hostedOperatorRealmLinkConfigSha256(plan),
        },
      ],
      mode: "protected-operator-v1",
      operationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      receipts: plan.effects.map((effect) => ({
        effectId: effect.id,
        observedAt,
        resourceVersion: "actual-readback",
      })),
    },
    privateState: {
      encryptedToken: "private-ciphertext",
      keyVersion: "key-version",
      tokenIv: "iv",
      tokenTag: "tag",
    },
    request: context.target,
    status: "pending",
    step: "reserved",
    version: 1,
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
    effects: [
      {
        description: "Capture the approved existing account",
        id: "normal-accounts",
        kind: "normal-accounts",
      },
    ],
    gatewayDelivery: { ...live.plan.gatewayDelivery, gitSha: "a".repeat(40) },
    stage: "auth-participants",
  });
  const program = required(accountPlan.normalActorProgram);
  record.retainedAuth = retainedOperatorAuthFromJournal(record);
  record.accountPreparation = {
    accountApprovalId: "account-approval",
    accountApprovedByCallId: "account-call",
    accountOperationRef,
    accountPlan,
    accountPlanDigest: operatorPlanDigest(accountPlan),
    captures: [
      {
        actorKey: "owner",
        expiresAt: "2027-01-01T00:00:00Z",
        nonceSha256: "a".repeat(64),
        proofSha256: "b".repeat(64),
        reference: "00000000-0000-4000-8000-000000000003",
      },
    ],
    organizationProofs: [],
    pendingCaptures: [
      { actorKey: "owner", expiresAt: "2027-01-01T00:00:00Z", nonceSha256: "c".repeat(64) },
    ],
    program,
    programDigest: normalActorProgramDigest(program),
    sealedState: encryptNormalActorState({
      authority,
      config: keyring,
      operationRef: accountOperationRef,
      ownerSessionId: context.target.sessionId,
      program,
      state: initialNormalActorState(program, accountOperationRef),
    }),
    supersededOrganizationProofs: [],
  };
  let row: HostedRuntimeJournalRow = { record, revision: 1 };
  const read = vi.fn(async () => await Promise.resolve(structuredClone(row)));
  const compareAndSet = vi.fn<ProtectedHostedOperatorDependencies["store"]["compareAndSet"]>(
    async (input) => {
      if (input.expectedRevision !== row.revision) {
        return undefined;
      }
      row = {
        record: hostedRuntimeJournalRecordSchema.parse(input.record),
        revision: row.revision + 1,
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
        approvalId: input.callId === "account-call" ? "account-approval" : "actual-approval",
        approved: true,
        callId: input.callId,
        planDigest: input.planDigest,
      }),
  );
  const ports = { assertAuthorized, readApproval, store: { compareAndSet, read } };
  const input = { action: "plan", operation: "prepare", selection: accountPlan.selection } as const;
  return {
    accountPlan,
    input,
    ports,
    get row() {
      return row;
    },
    run: async () =>
      await restorePendingAccountPreparation(ports, context, input, accountPlan, () => now),
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
      plan: original.accountPlan,
      planDigest: original.accountPlanDigest,
    });
    const after = f.row.record;
    expect(
      decryptNormalActorState({
        authority,
        config: keyring,
        operationRef: accountOperationRef,
        ownerSessionId: context.target.sessionId,
        program: original.program,
        sealed: required(after.accountPreparation).sealedState,
      }),
    ).toEqual(initialNormalActorState(original.program, accountOperationRef));
    expect(after.accountPreparation).toEqual(original);
    expect(after.privateState).toEqual(before.privateState);
    expect(after.approvedByCallId).toBe(original.accountApprovedByCallId);
    expect(after.operator).toMatchObject({
      approvalId: original.accountApprovalId,
      authPreparation: current.authPreparation,
      deliveredGatewayDeploymentId: current.deliveredGatewayDeploymentId,
      gatewayDeliveryCandidates: current.gatewayDeliveryCandidates,
      gatewayEnvironment: current.gatewayEnvironment,
      operationRef: accountOperationRef,
      plan: original.accountPlan,
      planDigest: original.accountPlanDigest,
      receipts: [],
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
      const { record } = f.row;
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
          approvalId: input.callId === "account-call" ? "account-approval" : "actual-approval",
          approved:
            input.callId !== (which === "account" ? "account-call" : "ordinary-public-approval"),
          callId: input.callId,
          planDigest: input.planDigest,
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
    authorize: async () => await Promise.resolve(context),
    bindings: forbidden,
    executeEffect: forbidden,
    now: () => now,
    plan: async () => await Promise.resolve(f.accountPlan),
    readApprovedPlan: forbidden,
    reconcile: forbidden,
    store: {
      ...f.ports.store,
      reserve: async () => await Promise.resolve(f.row),
      reserveFenceGeneration: forbidden,
    },
    verify: forbidden,
    withResourceLease: forbidden,
  };
  const response = await createProtectedHostedOperatorHandler(deps)(
    new Request("https://operator.example/v1/runtime", {
      body: JSON.stringify(f.input),
      headers: { "content-type": "application/json" },
      method: "POST",
    }),
  );
  expect(await response.json()).toMatchObject({
    operationRef: accountOperationRef,
    plan: f.accountPlan,
    status: "planned",
  });
  const owner = vi.fn(async () => {});
  const captureAuthority = createNormalActorJournalAuthority({
    assertApprovedOwner: f.ports.assertAuthorized,
    assertCanonicalOwner: owner,
    keyring,
    now: () => now,
    readApproval: f.ports.readApproval,
    store: f.ports.store,
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
  const { record } = f.row;
  const current = required(record.operator);
  record.pendingAccountRestorations = [
    {
      approvedByCallId: "older-call",
      operator: structuredClone(current),
      retainedAuth: record.retainedAuth,
    },
  ];
  record.executionObservation = {
    approvalId: required(current.approvalId),
    attemptRef: "00000000-0000-4000-8000-000000000004",
    callId: record.approvedByCallId,
    operationRef,
    outcome: { code: "reconciliation_required", status: "blocked" },
    planDigest: current.planDigest,
    state: "settled",
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
    approvalId: required(current.approvalId),
    attemptRef: "00000000-0000-4000-8000-000000000004",
    callId: f.row.record.approvedByCallId,
    operationRef,
    planDigest: current.planDigest,
    state: "running",
  };
  await expect(f.run()).rejects.toMatchObject({ code: "operation_in_progress" });
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});

it.each(["claimed", "unknown", "accepted"] as const)(
  "refuses a current-adapter %s continuation without replay or loss",
  async (status) => {
    const f = setup();
    f.row.record.realmContinuation = {
      adapterSessionId: required(context.ownerContext).adapterSessionId,
      approvedPlanDigest: required(f.row.record.operator).planDigest,
      claimedAt: observedAt,
      dispatchId: "d".repeat(64),
      nonceSha256: "e".repeat(64),
      operationRef,
      status,
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
    browserOrigin: original.program.origin,
    browserSession: {
      operationRef: original.accountOperationRef,
      participantProgramDigest: original.programDigest,
    },
    endpointOrigin: "https://gateway.example",
    expiresAt: "2027-01-01T00:00:00Z",
    issuer: required(original.accountPlan.deploymentBoundary).verification.publicOrigin,
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
    acceptedAt: observedAt,
    adapterSessionId: "displaced-adapter",
    approvedPlanDigest: original.accountPlanDigest,
    claimedAt: observedAt,
    dispatchId: "d".repeat(64),
    nonceSha256: "c".repeat(64),
    operationRef: accountOperationRef,
    receiverClaimedAt: observedAt,
    status: "accepted",
  };
  const before = structuredClone(f.row.record);
  await f.run();
  expect(f.row.record.accountPreparation).toEqual(original);
  expect(f.row.record.operator?.identityLink).toEqual(operator.identityLink);
  expect(f.row.record.realmIdentityWait).toBeUndefined();
  expect(f.row.record.realmContinuation).toBeUndefined();
  expect(f.row.record.pendingAccountRestorations?.[0]).toMatchObject({
    realmContinuation: before.realmContinuation,
    realmIdentityWait: before.realmIdentityWait,
  });
});

it("does not discard an old-adapter unknown continuation", async () => {
  const f = setup();
  f.row.record.realmContinuation = {
    adapterSessionId: "displaced-adapter",
    approvedPlanDigest: required(f.row.record.operator).planDigest,
    claimedAt: observedAt,
    dispatchId: "d".repeat(64),
    nonceSha256: "e".repeat(64),
    operationRef,
    status: "unknown",
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

it("reports a closed authorized candidate before a nonparticipant proposal silently falls back", async () => {
  const f = setup();
  const original = structuredClone(f.row.record);
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await expect(
      restorePendingAccountPreparation(
        f.ports,
        context,
        f.input,
        required(f.row.record.operator).plan,
        () => now,
      ),
    ).resolves.toBeNull();
    expect(logs).toHaveBeenCalledWith("[builder:pending-account-restoration]", {
      allPlanEffectsReceipted: true,
      continuation: "absent",
      continuationAcceptanceReceiptPresent: false,
      continuationArchiveable: false,
      currentExecutionAcknowledged: false,
      executionState: "absent",
      hasLeaseExpiry: false,
      hasPendingAttempt: false,
      hasPendingEffect: false,
      lease: "absent",
      linkScope: "absent",
      missingEffectKinds: [],
      ownerRestrictedCapabilityPresent: false,
      proposalIsOriginalAccountPlan: false,
      proposalStage: "auth-bootstrap",
      wait: "absent",
    });
    expect(f.row.record).toEqual(original);
    expect(f.ports.readApproval).not.toHaveBeenCalled();
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  } finally {
    logs.mockRestore();
  }
});

it("distinguishes an exact account proposal without exporting any retained private payload", async () => {
  const f = setup();
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await f.run();
    expect(logs).toHaveBeenCalledWith(
      "[builder:pending-account-restoration]",
      expect.objectContaining({
        proposalIsOriginalAccountPlan: true,
        proposalStage: "auth-participants",
      }),
    );
    const output = JSON.stringify(logs.mock.calls);
    for (const forbidden of [
      accountOperationRef,
      operationRef,
      "owner@example.test",
      "https://apps.example",
      "private-ciphertext",
      "private-hook",
      "actual-approval",
      normalActorProgramDigest(required(f.accountPlan.normalActorProgram)),
      "c".repeat(64),
    ]) {
      expect(output).not.toContain(forbidden);
    }
  } finally {
    logs.mockRestore();
  }
});

it.each(["read", "unauthorized", "logger"])(
  "keeps %s diagnostic failure advisory for the original nonparticipant fallback",
  async (failure) => {
    const f = setup();
    const logs = vi.spyOn(console, "info").mockImplementation(() => {
      if (failure === "logger") {
        throw new Error("private-logger-error");
      }
    });
    if (failure === "read") {
      f.ports.store.read.mockRejectedValueOnce(new Error("private-read-error"));
    }
    if (failure === "unauthorized") {
      f.ports.assertAuthorized.mockRejectedValueOnce(
        new HostedOperatorError("authorization_required"),
      );
    }
    try {
      await expect(
        restorePendingAccountPreparation(
          f.ports,
          context,
          f.input,
          required(f.row.record.operator).plan,
          () => now,
        ),
      ).resolves.toBeNull();
      if (failure !== "logger") {
        expect(logs).not.toHaveBeenCalled();
      }
      expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
    } finally {
      logs.mockRestore();
    }
  },
);

it("emits nothing for a consistently unauthorized actual restoration", async () => {
  const f = setup();
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  f.ports.assertAuthorized.mockRejectedValue(new HostedOperatorError("authorization_required"));
  try {
    await expect(f.run()).rejects.toMatchObject({ code: "authorization_required" });
    expect(logs).not.toHaveBeenCalled();
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  } finally {
    logs.mockRestore();
  }
});

it.each(["current-account", "old-adapter", "observed", "unrelated"] as const)(
  "classifies %s identity waits with fixed values only",
  async (classification) => {
    const f = setup();
    const original = required(f.row.record.accountPreparation);
    const operator = required(f.row.record.operator);
    if (classification === "current-account") {
      operator.identityLink = {
        audience: required(original.accountPlan.gatewayBindings).operatorOrigin,
        authResourceId: original.accountPlan.authDatabase.resourceId,
        bootstrapPlanDigest: original.accountPlanDigest,
        browserOrigin: original.program.origin,
        browserSession: {
          operationRef: original.accountOperationRef,
          participantProgramDigest: original.programDigest,
        },
        endpointOrigin: "https://gateway.example",
        expiresAt: "2027-01-01T00:00:00Z",
        issuer: required(original.accountPlan.deploymentBoundary).verification.publicOrigin,
        nonceSha256: "c".repeat(64),
        organizationId: null,
        ownerSessionId: context.target.sessionId,
      };
    }
    f.row.record.realmIdentityWait = {
      adapterSessionId:
        classification === "old-adapter"
          ? "private-old-adapter"
          : required(context.ownerContext).adapterSessionId,
      approvedPlanDigest: original.accountPlanDigest,
      callId: original.accountApprovedByCallId,
      hook: { encryptedToken: "private-hook", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
      nonceSha256: "c".repeat(64),
      operationRef: accountOperationRef,
      registeredAt: observedAt,
      ...(classification === "observed" ? { eventId: "f".repeat(64), observedAt } : {}),
    };
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await restorePendingAccountPreparation(f.ports, context, f.input, operator.plan, () => now);
      expect(logs).toHaveBeenCalledWith(
        "[builder:pending-account-restoration]",
        expect.objectContaining({ wait: classification }),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-hook|private-old-adapter/u);
    } finally {
      logs.mockRestore();
    }
  },
);

it.each(["old-accepted", "current-accepted", "current-pending", "old-unknown"] as const)(
  "classifies %s continuation without exporting capability data",
  async (classification) => {
    const f = setup();
    const accepted = classification.endsWith("accepted");
    f.row.record.realmContinuation = {
      adapterSessionId: classification.startsWith("old")
        ? "private-displaced-adapter"
        : required(context.ownerContext).adapterSessionId,
      approvedPlanDigest: required(f.row.record.operator).planDigest,
      claimedAt: observedAt,
      dispatchId: "d".repeat(64),
      nonceSha256: "e".repeat(64),
      operationRef,
      status: accepted ? "accepted" : "unknown",
      ...(accepted ? { acceptedAt: observedAt, receiverClaimedAt: observedAt } : {}),
    };
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await restorePendingAccountPreparation(
        f.ports,
        context,
        f.input,
        required(f.row.record.operator).plan,
        () => now,
      );
      expect(logs).toHaveBeenCalledWith(
        "[builder:pending-account-restoration]",
        expect.objectContaining({
          continuation: classification,
          continuationArchiveable: classification === "old-accepted",
        }),
      );
      expect(JSON.stringify(logs.mock.calls)).not.toMatch(/private-displaced-adapter/u);
    } finally {
      logs.mockRestore();
    }
  },
);

it("projects pending record facts and only the presence of restricted owner capability", async () => {
  const f = setup();
  const operator = required(f.row.record.operator);
  f.row.record.leaseId = "00000000-0000-4000-8000-000000000009";
  f.row.record.leaseExpiresAt = "2027-01-01T00:00:00Z";
  operator.pendingEffectId = "private-effect-id";
  operator.pendingEffectAttempt = { id: "00000000-0000-4000-8000-000000000008" };
  operator.receipts.pop();
  f.row.record.executionObservation = {
    approvalId: required(operator.approvalId),
    attemptRef: f.row.record.leaseId,
    callId: f.row.record.approvedByCallId,
    operationRef,
    planDigest: operator.planDigest,
    state: "running",
  };
  const restrictedContext = {
    ...context,
    ownerContext: {
      ...required(context.ownerContext),
      realmContinuation: { sealedAuthority: "private-sealed-authority" },
    },
  };
  const logs = vi.spyOn(console, "info").mockImplementation(() => {});
  try {
    await restorePendingAccountPreparation(
      f.ports,
      restrictedContext,
      f.input,
      operator.plan,
      () => now,
    );
    expect(logs).toHaveBeenCalledWith(
      "[builder:pending-account-restoration]",
      expect.objectContaining({
        allPlanEffectsReceipted: false,
        executionState: "running",
        hasLeaseExpiry: true,
        hasPendingAttempt: true,
        hasPendingEffect: true,
        lease: "active",
        missingEffectKinds: ["gateway-delivery"],
        ownerRestrictedCapabilityPresent: true,
      }),
    );
    expect(JSON.stringify(logs.mock.calls)).not.toMatch(
      /private-sealed-authority|private-effect-id/u,
    );
    expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
  } finally {
    logs.mockRestore();
  }
});

it("does not change an authorized restoration when its advisory logger throws", async () => {
  const f = setup();
  const logs = vi.spyOn(console, "info").mockImplementation(() => {
    throw new Error("private-logging-failure");
  });
  try {
    await expect(f.run()).resolves.toMatchObject({
      operationRef: accountOperationRef,
      status: "planned",
    });
    expect(f.ports.store.compareAndSet).toHaveBeenCalledOnce();
  } finally {
    logs.mockRestore();
  }
});

const completedNotification = () => {
  const f = setup();
  const operator = required(f.row.record.operator);
  f.row.record.executionObservation = {
    approvalId: required(operator.approvalId),
    attemptRef: "00000000-0000-4000-8000-000000000007",
    callId: f.row.record.approvedByCallId,
    operationRef,
    outcome: { status: "auth-schema-prepared" },
    planDigest: operator.planDigest,
    state: "settled",
  };
  f.row.record.realmContinuation = {
    acceptedAt: observedAt,
    adapterSessionId: required(context.ownerContext).adapterSessionId,
    approvedPlanDigest: operator.planDigest,
    claimedAt: observedAt,
    dispatchId: "d".repeat(64),
    nonceSha256: "e".repeat(64),
    operationRef,
    receiverClaimedAt: observedAt,
    status: "accepted",
  };
  f.row.record.realmIdentityWait = {
    adapterSessionId: required(context.ownerContext).adapterSessionId,
    approvedPlanDigest: "a".repeat(64),
    callId: "past-notification-call",
    eventId: "f".repeat(64),
    hook: { encryptedToken: "private-hook", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
    nonceSha256: "b".repeat(64),
    observedAt,
    operationRef: accountOperationRef,
    registeredAt: observedAt,
  };
  return f;
};

it.each(["past", "absent", "account"] as const)(
  "archives a fully acknowledged current-adapter notification without requiring past wait scope equality (wait %s)",
  async (waitKind) => {
    const f = completedNotification();
    if (waitKind === "absent") {
      delete f.row.record.realmIdentityWait;
    }
    if (waitKind === "account") {
      const wait = required(f.row.record.realmIdentityWait);
      const account = required(f.row.record.accountPreparation);
      wait.operationRef = account.accountOperationRef;
      wait.approvedPlanDigest = account.accountPlanDigest;
      wait.callId = account.accountApprovedByCallId;
    }
    const before = structuredClone(f.row.record);
    const logs = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      await expect(f.run()).resolves.toMatchObject({
        operationRef: accountOperationRef,
        status: "planned",
      });
      expect(f.row.record.realmContinuation).toBeUndefined();
      expect(f.row.record.realmIdentityWait).toBeUndefined();
      expect(f.row.record.operator?.identityLink).toBeUndefined();
      expect(f.row.record.accountPreparation).toEqual(before.accountPreparation);
      expect(f.row.record.privateState).toEqual(before.privateState);
      expect(f.row.record.pendingAccountRestorations?.[0]).toMatchObject({
        executionObservation: before.executionObservation,
        realmContinuation: before.realmContinuation,
      });
      expect(f.row.record.pendingAccountRestorations?.[0].realmIdentityWait).toEqual(
        before.realmIdentityWait,
      );
      expect(logs).toHaveBeenCalledWith(
        "[builder:pending-account-restoration]",
        expect.objectContaining({
          continuation: "current-accepted",
          continuationAcceptanceReceiptPresent: true,
          continuationArchiveable: true,
          currentExecutionAcknowledged: true,
        }),
      );
    } finally {
      logs.mockRestore();
    }
  },
);

it.each([
  "claimed",
  "unknown",
  "running",
  "ack-operation",
  "ack-plan",
  "ack-call",
  "ack-approval",
  "ack-outcome",
  "unobserved-wait",
  "missing-event-id",
  "missing-acceptance",
  "missing-receiver-claim",
  "identity-link",
  "restricted-owner",
])("keeps completed-notification exception closed for %s", async (change) => {
  const f = completedNotification();
  const execution = required(f.row.record.executionObservation);
  const continuation = required(f.row.record.realmContinuation);
  if (change === "claimed" || change === "unknown") {
    continuation.status = change;
  }
  if (change === "running") {
    f.row.record.executionObservation = { ...execution, state: "running" };
  }
  if (change === "ack-operation") {
    execution.operationRef = accountOperationRef;
  }
  if (change === "ack-plan") {
    execution.planDigest = "c".repeat(64);
  }
  if (change === "ack-call") {
    execution.callId = "other-call";
  }
  if (change === "ack-approval") {
    execution.approvalId = "other-approval";
  }
  if (change === "ack-outcome" && execution.state === "settled") {
    execution.outcome.status = "pending";
  }
  if (change === "unobserved-wait") {
    delete required(f.row.record.realmIdentityWait).observedAt;
  }
  if (change === "missing-event-id") {
    delete required(f.row.record.realmIdentityWait).eventId;
  }
  if (change === "missing-acceptance") {
    delete continuation.acceptedAt;
  }
  if (change === "missing-receiver-claim") {
    delete continuation.receiverClaimedAt;
  }
  if (change === "identity-link") {
    const account = required(f.row.record.accountPreparation);
    required(f.row.record.operator).identityLink = {
      audience: required(account.accountPlan.gatewayBindings).operatorOrigin,
      authResourceId: account.accountPlan.authDatabase.resourceId,
      bootstrapPlanDigest: account.accountPlanDigest,
      browserOrigin: account.program.origin,
      browserSession: {
        operationRef: account.accountOperationRef,
        participantProgramDigest: account.programDigest,
      },
      endpointOrigin: "https://gateway.example",
      expiresAt: "2027-01-01T00:00:00Z",
      issuer: required(account.accountPlan.deploymentBoundary).verification.publicOrigin,
      nonceSha256: "c".repeat(64),
      organizationId: null,
      ownerSessionId: context.target.sessionId,
    };
  }
  const invocation =
    change === "restricted-owner"
      ? {
          ...context,
          ownerContext: {
            ...required(context.ownerContext),
            realmContinuation: { sealedAuthority: "private-capability" },
          },
        }
      : context;
  const before = structuredClone(f.row.record);
  await expect(
    restorePendingAccountPreparation(f.ports, invocation, f.input, f.accountPlan, () => now),
  ).rejects.toMatchObject({ code: "operation_in_progress" });
  expect(f.row.record).toEqual(before);
  expect(f.ports.store.compareAndSet).not.toHaveBeenCalled();
});
