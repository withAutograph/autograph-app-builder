import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import type { HostedEveStore } from "../eve/hosted-store";
import { privateHostedApprovalReceiptSchema } from "../eve/private-hosted-approval";
import {
  hostedOperatorPlanSchema,
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import { createHostedOperatorReadApproval } from "./hosted-operator-owner";
import {
  readApprovedRetainedMembershipInspection,
  readApprovedRetainedMembershipInspections,
} from "./hosted-operator-membership-inspection";
import type { HostedOperatorEffectContext } from "./hosted-operator-service";
import { hostedRuntimeJournalRecordSchema } from "./hosted-runtime-journal";
import {
  normalActorProgramDigest,
  normalActorProgramSchema,
} from "./hosted-operator-normal-actor-program";

const membershipInspectionFixture = () => {
  const principal = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "fixture-owner",
    scopes: ["autograph:session"],
    workspaceId: "fixture-workspace",
  };
  const authority = {
    audience: principal.audience,
    issuer: principal.issuer,
    ownerUserId: principal.ownerUserId,
    workspaceId: principal.workspaceId,
  };
  const ownerContext = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "fixture-adapter-session",
    authority,
    kind: "direct",
    principal,
    sessionId: "fixture-public-session",
  });
  const selection = {
    appId: "membership-fixture",
    branch: "preview",
    environment: "preview",
    projectId: "prj_app",
    sessionId: ownerContext.sessionId,
  };
  const originalPlan = hostedOperatorPlanSchema.parse({
    access: [{ actorId: "fixture-actor", organizationId: "fixture-org", roles: ["member"] }],
    action: "prepare",
    appDatabase: {
      database: "fixture_app",
      migratorRole: "app_owner",
      resourceId: "app-resource",
      runtimeRole: "app_runtime",
    },
    authDatabase: {
      database: "fixture_auth",
      migratorRole: "auth_owner",
      resourceId: "auth-resource",
      runtimeRole: "auth_runtime",
    },
    authMembership: {
      actorId: "fixture-actor",
      bootstrapPlanDigest: "8".repeat(64),
      identityCapture: { capturedAt: "2026-10-17T19:00:00Z", realmSessionId: "fixture-realm" },
      identityNonceSha256: "5".repeat(64),
      identityProof: { reference: "fixture-proof", sha256: "6".repeat(64) },
      identityVerification: {
        audience: "https://app.example",
        issuer: "https://app.example",
        jwksUrl: "https://app.example/jwks",
        transportSource: {
          audience: "https://vercel.com/team",
          environment: "preview",
          issuer: "https://oidc.vercel.com/team",
          ownerId: "team",
          projectId: "prj_gateway",
        },
      },
      kind: "create-owned-organization",
      name: "Fixture organization",
      organizationId: "fixture-org",
      slug: "fixture-org",
    },
    contextId: "fixture-context",
    cost: { class: "shared-recovery-group", description: "Fixture resources", owner: "operator" },
    deploymentBoundary: {
      app: {
        branch: selection.branch,
        deploymentId: "dpl_app",
        environment: "preview",
        projectId: "prj_app",
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
      teamId: "team",
      verification: {
        gatewayOrigin: "https://gateway.example",
        jwksUrl: "https://gateway.example/_platform/jwks.json",
        publicOrigin: "https://app.example",
      },
    },
    effects: [
      { description: "Prepare resources", id: "resources", kind: "resources" },
      { description: "Install schema", id: "install", kind: "install" },
      { description: "Confirm membership", id: "membership", kind: "auth-membership" },
      { description: "Grant access", id: "access", kind: "access" },
      { description: "Bind runtime", id: "bindings", kind: "bindings" },
    ],
    installer: { reference: "original-installer", sha256: "3".repeat(64) },
    neon: {
      branchId: "br_fixture",
      connectionRef: "fixture-connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon-fixture",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: selection.branch,
      origin: "https://app.example",
      projectId: "prj_gateway",
    },
    release: { artifactRef: "fixture-artifact", id: "fixture-release", sha256: "4".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "Fixture retention" },
    selection,
    stage: "app",
    version: 1,
  });
  const operationRef = "b209b89b-0bad-4a60-820f-4e29d5e5a4cc";
  const planDigest = operatorPlanDigest(originalPlan);
  const approval = privateHostedApprovalReceiptSchema.parse({
    callId: "original-membership-call",
    format: "autograph-hosted-approval-v1",
    outcome: "approved",
    requestId: "original-membership-request",
    responderPrincipalId: principal.ownerUserId,
    sequence: 1,
    toolInput: {
      appId: selection.appId,
      branch: selection.branch,
      environment: selection.environment,
      operationRef,
      plan: originalPlan,
      planDigest,
      projectId: selection.projectId,
    },
    toolName: "prepare-app-hosted-runtime",
    turnId: "fixture-turn",
  });
  // The worker's canonical marker/readback contract uses this alphabetical key order.
  const marker = JSON.stringify({
    actorId: "fixture-actor",
    identityProofSha256: "6".repeat(64),
    ownerSessionId: selection.sessionId,
    planDigest,
    purpose: "protected-owned-organization-v1",
    version: 1,
  });
  const resourceVersion = createHash("sha256")
    .update(
      JSON.stringify({
        actorId: "fixture-actor",
        marker,
        organizationId: "fixture-org",
        role: "owner",
      }),
    )
    .digest("hex");
  const original = {
    approvalId: approval.requestId,
    mode: "protected-operator-v1",
    operationRef,
    plan: originalPlan,
    planDigest,
    receipts: [{ effectId: "membership", observedAt: "2026-10-17T19:01:00Z", resourceVersion }],
  };
  const currentPlan = hostedOperatorPlanSchema.parse({
    ...originalPlan,
    installer: { reference: "current-installer", sha256: "7".repeat(64) },
  });
  const record = hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: "current-call",
    kind: "app-runtime",
    operator: {
      ...original,
      approvalId: "current-request",
      plan: currentPlan,
      planDigest: operatorPlanDigest(currentPlan),
      fenceGeneration: 7,
      receipts: [],
      retainedInstallerOperations: [{ approvedByCallId: approval.callId, operator: original }],
    },
    request: { ...selection, installationId: "icfg_fixture", scopeId: "team", scopeType: "team" },
    status: "pending",
    step: "reserved",
    version: 1,
  });
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: ownerContext.adapterSessionId,
    appId: selection.appId,
    createdAtEpochMs: 100,
    lastProgressAtEpochMs: 100,
    originAdapterSessionId: ownerContext.adapterSessionId,
    principal,
    privateApprovalReceipts: [approval],
    resumability: "live",
    sessionId: ownerContext.sessionId,
    stage: "ready",
    status: "waiting",
    title: "Membership fixture",
    updatedAtEpochMs: 100,
    version: 2,
  });
  const eve: Pick<HostedEveStore, "getSession" | "recordPrivateApprovalReceipts"> = {
    getSession: vi.fn(() => Promise.resolve(session)),
    recordPrivateApprovalReceipts: vi.fn(() => Promise.resolve()),
  };
  const observe = vi.fn(() =>
    Promise.resolve({
      artifactProjectionRequiresLegacyReadback: false,
      installedEventCount: 0,
      pendingRequests: [],
      publicEventCount: 0,
      status: "waiting" as const,
    }),
  );
  const journal = { read: vi.fn(() => Promise.resolve({ record, revision: 1 })) };
  const readApproval = createHostedOperatorReadApproval({ eve, journal, observe });
  const context = {
    action: "prepare" as const,
    authority,
    callId: approval.callId,
    ownerContext,
    planDigest,
    target: record.request,
  };
  return { approval, context, eve, observe, readApproval, record, session };
};

describe("retained membership inspection owner approval", () => {
  it("reads the original canonical owner approval through installer history", async () => {
    const f = membershipInspectionFixture();
    await expect(f.readApproval(f.context)).resolves.toEqual({
      action: "prepare",
      approvalId: f.approval.requestId,
      approved: true,
      callId: f.approval.callId,
      planDigest: f.context.planDigest,
    });
    expect(f.observe).not.toHaveBeenCalled();
  });

  it.each([
    "missing-receipt",
    "cancelled",
    "foreign-responder",
    "foreign-owner",
    "foreign-request",
    "foreign-call",
    "foreign-digest",
    "foreign-operation",
    "changed-membership",
    "cleanup",
  ] as const)("denies %s despite archived provenance", async (mismatch) => {
    const f = membershipInspectionFixture();
    const context = {
      ...f.context,
      action: mismatch === "cleanup" ? ("cleanup" as const) : ("prepare" as const),
    };
    if (mismatch === "missing-receipt") {
      f.session.privateApprovalReceipts = [];
    }
    if (mismatch === "cancelled") {
      f.approval.outcome = "cancelled";
    }
    if (mismatch === "foreign-responder") {
      f.approval.responderPrincipalId = "foreign-owner";
    }
    if (mismatch === "foreign-request") {
      f.approval.requestId = "foreign-request";
    }
    if (mismatch === "foreign-call") {
      context.callId = "foreign-call";
    }
    if (mismatch === "foreign-digest") {
      context.planDigest = "f".repeat(64);
    }
    if (mismatch === "foreign-operation") {
      f.approval.toolInput.operationRef = "849497e7-38e1-413c-8264-ce0fbd82f242";
    }
    if (mismatch === "foreign-owner") {
      context.ownerContext = operatorOwnerContextSchema.parse({
        ...context.ownerContext,
        authority: { ...context.authority, ownerUserId: "foreign-owner" },
        principal: { ...context.ownerContext.principal, ownerUserId: "foreign-owner" },
      });
    }
    if (mismatch === "changed-membership" && f.record.operator !== undefined) {
      f.record.operator.plan = hostedOperatorPlanSchema.parse({
        ...f.record.operator.plan,
        authMembership: {
          ...f.record.operator.plan.authMembership,
          identityNonceSha256: "9".repeat(64),
        },
      });
      f.record.operator.planDigest = operatorPlanDigest(f.record.operator.plan);
    }
    // The store, not the archived checkpoint, owns the canonical terminal receipt.
    if (mismatch !== "missing-receipt") {
      f.session.privateApprovalReceipts = [f.approval];
    }
    await expect(f.readApproval(context)).rejects.toMatchObject({ code: "authorization_required" });
  });
});

const approvedInspectionFixture = () => {
  const f = membershipInspectionFixture();
  const operator = f.record.operator;
  const effect = operator?.plan.effects.find((candidate) => candidate.kind === "auth-membership");
  if (operator === undefined || effect === undefined) {
    throw new Error("Missing fixture effect");
  }
  const context: HostedOperatorEffectContext = {
    authority: f.context.authority,
    ownerContext: f.context.ownerContext,
    target: f.context.target,
    assertCurrent: vi.fn(() => Promise.resolve()),
    checkpoint: vi.fn(() => Promise.resolve()),
    effect,
    fenceGeneration: operator.fenceGeneration ?? 7,
    leaseId: "3e38466d-46fd-4277-a9f7-432e13447354",
    operationRef: operator.operationRef,
    plan: operator.plan,
    workerCheckpoints: [],
  };
  const readApproval = vi.fn(f.readApproval);
  const readCurrentRecord = vi.fn(() => Promise.resolve(f.record));
  return { ...f, context, readApproval, readCurrentRecord };
};

const selectedInspectionFixture = () => {
  const f = approvedInspectionFixture();
  const current = f.record.operator;
  const original = current?.retainedInstallerOperations?.[0]?.operator;
  const spec = current?.plan.authMembership;
  if (
    current === undefined ||
    original === undefined ||
    spec?.kind !== "create-owned-organization"
  ) {
    throw new Error("Expected current and original organization authority");
  }
  const organizations = [
    spec,
    { ...spec, organizationId: "second-org", name: "Second", slug: "second-org" },
  ];
  const program = normalActorProgramSchema.parse({
    version: 1,
    appId: current.plan.selection.appId,
    origin: current.plan.publicGateway?.origin,
    actors: [
      {
        actorKey: "owner",
        email: "owner@example.test",
        name: "Owner",
        account: "capture-existing",
      },
    ],
    organizations: organizations.map((organization) => ({
      organizationId: organization.organizationId,
      name: organization.name,
      slug: organization.slug,
      ownerActorKey: "owner",
    })),
    memberships: organizations.map(({ organizationId }) => ({
      organizationId,
      actorKey: "owner",
      role: "owner",
    })),
    appAccess: organizations.map(({ organizationId }) => ({
      organizationId,
      actorKey: "owner",
      roles: ["member"],
    })),
  });
  current.plan = hostedOperatorPlanSchema.parse({
    ...current.plan,
    authMembership: { kind: "create-owned-organizations", organizations },
    normalActorProgram: program,
    normalActorPreparation: {
      accountOperationRef: "33333333-3333-4333-8333-333333333333",
      accountPlanDigest: "a".repeat(64),
      accountApprovalId: "account-approval",
      accountApprovedByCallId: "account-call",
      programDigest: normalActorProgramDigest(program),
    },
    effects: current.plan.effects.flatMap((effect) =>
      effect.kind === "auth-membership"
        ? organizations.map(({ organizationId }) => ({
            ...effect,
            id: `auth-membership:${organizationId}`,
          }))
        : [effect],
    ),
  });
  current.planDigest = operatorPlanDigest(current.plan);
  current.operationRef = "44444444-4444-4444-8444-444444444444";
  original.receipts = [];
  const effect = current.plan.effects.find(
    (entry) => entry.id === `auth-membership:${spec.organizationId}`,
  );
  if (effect === undefined) {
    throw new Error("Expected selected current membership effect");
  }
  f.context.plan = current.plan;
  f.context.effect = effect;
  f.context.operationRef = current.operationRef;
  return { ...f, organizationId: spec.organizationId, original };
};

describe("approved retained membership inspection", () => {
  it("uses the canonical original approval after creation committed before receipt persistence", async () => {
    const f = selectedInspectionFixture();
    const currentDigest = operatorPlanDigest(f.context.plan);
    const result = await readApprovedRetainedMembershipInspections({
      effect: f.context,
      organizationId: f.organizationId,
      readApproval: f.readApproval,
      readCurrentRecord: f.readCurrentRecord,
    });
    expect(result[0]?.plan).toEqual(f.approval.toolInput.plan);
    expect(result[0]?.effect.id).toBe("membership");
    expect(f.original.operationRef).toBe(f.approval.toolInput.operationRef);
    expect(f.context.operationRef).not.toBe(f.original.operationRef);
    expect(operatorPlanDigest(f.context.plan)).toBe(currentDigest);
    expect(f.context.assertCurrent).toHaveBeenCalled();
  });

  it.each(["cancelled", "foreign-responder", "foreign-operation"] as const)(
    "skips a %s original approval for selected organization recovery",
    async (mismatch) => {
      const f = selectedInspectionFixture();
      if (mismatch === "cancelled") {
        f.approval.outcome = "cancelled";
      }
      if (mismatch === "foreign-responder") {
        f.approval.responderPrincipalId = "foreign-owner";
      }
      if (mismatch === "foreign-operation") {
        f.approval.toolInput.operationRef = f.context.operationRef;
      }
      f.session.privateApprovalReceipts = [f.approval];
      await expect(
        readApprovedRetainedMembershipInspections({
          effect: f.context,
          organizationId: f.organizationId,
          readApproval: f.readApproval,
          readCurrentRecord: f.readCurrentRecord,
        }),
      ).resolves.toEqual([]);
    },
  );

  it("rejects a different selected organization before reading its historical approval", async () => {
    const f = selectedInspectionFixture();
    await expect(
      readApprovedRetainedMembershipInspections({
        effect: f.context,
        organizationId: "second-org",
        readApproval: f.readApproval,
        readCurrentRecord: f.readCurrentRecord,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.readCurrentRecord).not.toHaveBeenCalled();
  });

  it("returns independently approved source revisions for actual ownership readback", async () => {
    const f = selectedInspectionFixture();
    const plan = hostedOperatorPlanSchema.parse({
      ...f.original.plan,
      installer: { ...f.original.plan.installer, sha256: "9".repeat(64) },
    });
    if (f.record.operator === undefined) {
      throw new Error("Expected current operator");
    }
    f.record.operator.retainedGatewayDeliveries = [
      {
        approvedByCallId: "another-original-call",
        operator: {
          ...f.original,
          approvalId: "another-original-request",
          plan,
          planDigest: operatorPlanDigest(plan),
        },
      },
    ];
    const anotherApproval = privateHostedApprovalReceiptSchema.parse({
      ...f.approval,
      callId: "another-original-call",
      requestId: "another-original-request",
      sequence: 2,
      toolInput: { ...f.approval.toolInput, plan, planDigest: operatorPlanDigest(plan) },
    });
    f.session.privateApprovalReceipts = [f.approval, anotherApproval];
    const results = await readApprovedRetainedMembershipInspections({
      effect: f.context,
      organizationId: f.organizationId,
      readApproval: f.readApproval,
      readCurrentRecord: f.readCurrentRecord,
    });
    expect(results.map((result) => operatorPlanDigest(result.plan))).toEqual([
      f.approval.toolInput.planDigest,
      anotherApproval.toolInput.planDigest,
    ]);
  });

  it("does not let a denied archived operation hide a separately approved identical plan", async () => {
    const f = selectedInspectionFixture();
    if (f.record.operator === undefined) {
      throw new Error("Expected current operator");
    }
    const operationRef = "55555555-5555-4555-8555-555555555555";
    f.record.operator.retainedGatewayDeliveries = [
      {
        approvedByCallId: "approved-original-call",
        operator: { ...f.original, approvalId: "approved-original-request", operationRef },
      },
    ];
    const approval = privateHostedApprovalReceiptSchema.parse({
      ...f.approval,
      callId: "approved-original-call",
      requestId: "approved-original-request",
      sequence: 2,
      toolInput: { ...f.approval.toolInput, operationRef },
    });
    f.approval.outcome = "cancelled";
    f.session.privateApprovalReceipts = [f.approval, approval];
    const results = await readApprovedRetainedMembershipInspections({
      effect: f.context,
      organizationId: f.organizationId,
      readApproval: f.readApproval,
      readCurrentRecord: f.readCurrentRecord,
    });
    expect(results.map((result) => operatorPlanDigest(result.plan))).toEqual([
      approval.toolInput.planDigest,
    ]);
  });

  it("propagates a current owner authorization failure without classifying it as an old approval denial", async () => {
    const f = selectedInspectionFixture();
    const failure = new HostedOperatorError("authorization_required");
    f.context.assertCurrent = vi.fn(() => Promise.reject(failure));
    await expect(
      readApprovedRetainedMembershipInspections({
        effect: f.context,
        organizationId: f.organizationId,
        readApproval: f.readApproval,
        readCurrentRecord: f.readCurrentRecord,
      }),
    ).rejects.toBe(failure);
    expect(f.readApproval).not.toHaveBeenCalled();
  });

  it("does not swallow an authorization failure raised by the approval transport", async () => {
    const f = selectedInspectionFixture();
    const failure = new HostedOperatorError("authorization_required");
    await expect(
      readApprovedRetainedMembershipInspections({
        effect: f.context,
        organizationId: f.organizationId,
        readApproval: () => Promise.reject(failure),
        readCurrentRecord: f.readCurrentRecord,
      }),
    ).rejects.toBe(failure);
  });

  it("requires the real original approval and preserves the current execution fence", async () => {
    const f = approvedInspectionFixture();
    const currentDigest = operatorPlanDigest(f.context.plan);
    const historical = f.record.operator?.retainedInstallerOperations?.[0]?.operator;
    const result = await readApprovedRetainedMembershipInspection({
      effect: f.context,
      readApproval: f.readApproval,
      readCurrentRecord: f.readCurrentRecord,
    });
    expect(result).toEqual({
      plan: f.approval.toolInput.plan,
      effect: f.approval.toolInput.plan.effects.find((effect) => effect.kind === "auth-membership"),
    });
    expect(result?.plan).not.toBe(historical?.plan);
    expect(result?.effect).not.toBe(
      historical?.plan.effects.find((effect) => effect.kind === "auth-membership"),
    );
    expect(f.readCurrentRecord).toHaveBeenCalledTimes(2);
    expect(f.context.assertCurrent).toHaveBeenCalledTimes(2);
    expect(f.readApproval).toHaveBeenCalledWith(
      expect.objectContaining({
        plan: f.context.plan,
        fenceGeneration: 7,
        leaseId: f.context.leaseId,
        callId: f.approval.callId,
        planDigest: f.approval.toolInput.planDigest,
      }),
    );
    expect(operatorPlanDigest(f.context.plan)).toBe(currentDigest);
    expect(currentDigest).not.toBe(f.approval.toolInput.planDigest);
  });

  it.each(["null", "unapproved", "foreign-request", "foreign-call", "foreign-digest"] as const)(
    "denies a %s approval response",
    async (mismatch) => {
      const f = approvedInspectionFixture();
      const approval = {
        action: "prepare" as const,
        approvalId: f.approval.requestId,
        approved: true,
        callId: f.approval.callId,
        planDigest: f.approval.toolInput.planDigest,
      };
      if (mismatch === "unapproved") {
        approval.approved = false;
      }
      if (mismatch === "foreign-request") {
        approval.approvalId = "foreign-request";
      }
      if (mismatch === "foreign-call") {
        approval.callId = "foreign-call";
      }
      if (mismatch === "foreign-digest") {
        approval.planDigest = "f".repeat(64);
      }
      await expect(
        readApprovedRetainedMembershipInspection({
          effect: f.context,
          readCurrentRecord: f.readCurrentRecord,
          readApproval: () => Promise.resolve(mismatch === "null" ? null : approval),
        }),
      ).rejects.toMatchObject({ code: "authorization_required" });
      expect(f.readCurrentRecord).toHaveBeenCalledTimes(1);
    },
  );

  it("checks the live execution lease before looking up historical approval", async () => {
    const f = approvedInspectionFixture();
    const failure = new Error("Current execution lease was revoked");
    f.context.assertCurrent = vi.fn(() => Promise.reject(failure));
    await expect(
      readApprovedRetainedMembershipInspection({
        effect: f.context,
        readApproval: f.readApproval,
        readCurrentRecord: f.readCurrentRecord,
      }),
    ).rejects.toBe(failure);
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.readCurrentRecord).not.toHaveBeenCalled();
  });

  it.each(["removed", "changed"] as const)(
    "denies provenance %s after approval",
    async (mutation) => {
      const f = approvedInspectionFixture();
      const readApproval = vi.fn(async (input: Parameters<typeof f.readApproval>[0]) => {
        const result = await f.readApproval(input);
        const original = f.record.operator?.retainedInstallerOperations?.[0]?.operator;
        if (mutation === "removed" && f.record.operator !== undefined) {
          f.record.operator.retainedInstallerOperations = [];
        } else if (original !== undefined) {
          original.approvalId = "changed-after-approval";
        }
        return result;
      });
      await expect(
        readApprovedRetainedMembershipInspection({
          effect: f.context,
          readApproval,
          readCurrentRecord: f.readCurrentRecord,
        }),
      ).rejects.toMatchObject({ code: "reconciliation_required" });
      expect(readApproval).toHaveBeenCalledOnce();
      expect(f.readCurrentRecord).toHaveBeenCalledTimes(2);
    },
  );

  it("denies other current effects before any historical lookup", async () => {
    const f = approvedInspectionFixture();
    const otherEffect = f.context.plan.effects.find((effect) => effect.kind === "install");
    if (otherEffect === undefined) {
      throw new Error("Missing fixture install");
    }
    f.context.effect = otherEffect;
    await expect(
      readApprovedRetainedMembershipInspection({
        effect: f.context,
        readApproval: f.readApproval,
        readCurrentRecord: f.readCurrentRecord,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(f.context.assertCurrent).not.toHaveBeenCalled();
    expect(f.readApproval).not.toHaveBeenCalled();
    expect(f.readCurrentRecord).not.toHaveBeenCalled();
  });
});
