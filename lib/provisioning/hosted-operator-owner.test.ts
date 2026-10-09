import { generateKeyPair, SignJWT } from "jose";
import type { MessageStreamEvent } from "eve/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { durableHostedSessionRecordSchema, hostedSessionRecordSchema } from "../eve/hosted-store";
import type { HostedEveStore, HostedSessionRecord } from "../eve/hosted-store";
import type { HostedEveTransport } from "../eve/hosted-service";
import { privateHostedApprovalReceiptSchema } from "../eve/private-hosted-approval";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import {
  hostedOperatorPlanSchema,
  operatorOwnerContextSchema,
  operatorPlanDigest,
} from "./hosted-operator-contract";
import type { OperatorOwnerContext, OperatorSelection } from "./hosted-operator-contract";
import type { PrivateHostedApprovalReceipt } from "../eve/private-hosted-approval";
import {
  createHostedOperatorOwnerAuthority,
  createHostedOperatorReadApproval,
} from "./hosted-operator-owner";
import {
  hostedRuntimeJournalRecordSchema,
  hostedRuntimeTargetSchema,
  // oxlint-disable-next-line import/consistent-type-specifier-style -- Keep this module in one import declaration.
  type HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";

const handoffId = "851d5dd6-0983-4f91-ae80-797fd61cfd4f";
const principal: HostedPrincipal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner-1",
  scopes: ["autograph:session"],
  workspaceId: "workspace-1",
};
const ownerContext: OperatorOwnerContext = {
  adapterGeneration: 1,
  adapterSessionId: "adapter-session-1",
  authority: {
    audience: principal.audience,
    issuer: principal.issuer,
    ownerUserId: principal.ownerUserId,
    workspaceId: principal.workspaceId,
  },
  kind: "handoff",
  principal,
  sessionId: "public-session-1",
  sourceHandoffId: handoffId,
};
const directOwnerContext: OperatorOwnerContext = {
  adapterGeneration: ownerContext.adapterGeneration,
  adapterSessionId: ownerContext.adapterSessionId,
  authority: ownerContext.authority,
  kind: "direct",
  principal,
  sessionId: ownerContext.sessionId,
};
const selection: OperatorSelection = {
  appId: "vendor-onboarding",
  branch: "main",
  environment: "preview",
  projectId: "prj_1",
  sessionId: ownerContext.sessionId,
};
const directSessionRecord = (
  overrides: {
    adapterGeneration?: number;
    principal?: HostedPrincipal;
  } = {},
) =>
  durableHostedSessionRecordSchema.parse({
    adapterGeneration: directOwnerContext.adapterGeneration,
    adapterSessionId: directOwnerContext.adapterSessionId,
    appId: selection.appId,
    createdAtEpochMs: 100,
    lastProgressAtEpochMs: 100,
    originAdapterSessionId: directOwnerContext.adapterSessionId,
    principal,
    resumability: "live",
    sessionId: directOwnerContext.sessionId,
    stage: "ready",
    status: "waiting",
    title: "Vendor onboarding",
    updatedAtEpochMs: 100,
    version: 2,
    ...overrides,
  });
const approvalRequestEvent = (receipt: PrivateHostedApprovalReceipt) =>
  ({
    data: {
      requests: [
        {
          action: {
            callId: receipt.callId,
            input: receipt.toolInput,
            kind: "tool-call",
            toolName: receipt.toolName,
          },
          kind: "tool-approval",
          prompt: "Approve this hosted operation.",
          requestId: receipt.requestId,
        },
      ],
      sequence: receipt.sequence,
      stepIndex: 0,
      turnId: receipt.turnId,
    },
    meta: { at: "2026-10-06T00:00:00.000Z", id: `request-${receipt.requestId}` },
    type: "input.requested",
  }) satisfies Extract<MessageStreamEvent, { type: "input.requested" }>;
const approvalSettledEvent = (receipt: PrivateHostedApprovalReceipt) =>
  ({
    data: {
      outcome: "approved",
      requestId: receipt.requestId,
      responderPrincipalId: receipt.responderPrincipalId,
      sequence: receipt.sequence,
      stepIndex: 1,
      turnId: receipt.turnId,
    },
    meta: { at: "2026-10-06T00:00:01.000Z", id: `settled-${receipt.requestId}` },
    type: "approval.settled",
  }) satisfies Extract<MessageStreamEvent, { type: "approval.settled" }>;
const approvalCandidateEvent = (receipt: PrivateHostedApprovalReceipt) =>
  ({
    data: {
      candidateId: "candidate_1",
      outcome: "pending",
      requestId: receipt.requestId,
      responderPrincipalId: receipt.responderPrincipalId,
      sequence: receipt.sequence,
      stepIndex: 0,
      turnId: receipt.turnId,
    },
    meta: { at: "2026-10-06T00:00:01.000Z", id: `candidate-${receipt.requestId}` },
    type: "approval.candidate",
  }) satisfies Extract<MessageStreamEvent, { type: "approval.candidate" }>;
const workloadPolicy: OperatorWorkloadPolicy = {
  audience: "https://vercel.com/owner/project",
  environment: "preview",
  issuer: "https://oidc.vercel.com",
  ownerId: "owner",
  projectId: "project",
  subject: "owner/project/preview",
};
let token: string;
let keyResolver: Parameters<typeof createHostedOperatorOwnerAuthority>[0]["keyResolver"];

beforeAll(async () => {
  const keys = await generateKeyPair("RS256");
  // oxlint-disable-next-line eslint/require-await, typescript/promise-function-async -- jose's key resolver interface requires a promise-returning function.
  keyResolver = async () => keys.publicKey;
  token = await new SignJWT({
    environment: workloadPolicy.environment,
    owner_id: workloadPolicy.ownerId,
    project_id: workloadPolicy.projectId,
  })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(workloadPolicy.issuer)
    .setAudience(workloadPolicy.audience)
    .setSubject(workloadPolicy.subject)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(keys.privateKey);
});

const makeFixture = (
  sessionOverride?: HostedSessionRecord,
  missingHandoff = false,
  activeMember = true,
) => {
  const currentSession = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: ownerContext.adapterSessionId,
    appId: selection.appId,
    createdAtEpochMs: 100,
    lastProgressAtEpochMs: 100,
    originAdapterSessionId: ownerContext.adapterSessionId,
    principal,
    resumability: "live" as const,
    sessionId: ownerContext.sessionId,
    sourceHandoffId: handoffId,
    stage: "ready" as const,
    status: "waiting" as const,
    title: "Vendor onboarding",
    updatedAtEpochMs: 100,
    version: 2 as const,
  });
  const intent = {
    appId: selection.appId,
    appName: "Vendor Onboarding",
    brief: "Review vendors.",
    connections: [],
    modelId: "openai/gpt-5.6-terra" as const,
    providers: { vercelInstallationId: "icfg_1" },
    provisioning: {
      appId: selection.appId,
      github: { code: "not_selected", retryable: false, status: "skipped" },
      requestDigest: "c".repeat(64),
      requestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
      status: "settled",
      updatedAt: "2026-09-01T12:00:00.000Z",
      vercel: {
        dashboardUrl: "https://vercel.com/acme/apps-vendor-onboarding",
        framework: "services",
        installationId: "icfg_1",
        name: "apps-vendor-onboarding",
        projectId: selection.projectId,
        rootDirectory: ".",
        scope: { id: "team_1", slug: "acme", type: "team" },
        status: "succeeded",
      },
      version: 1,
    },
    provisioningRequestDigest: "c".repeat(64),
    provisioningRequestId: "f1184eeb-0c49-4db2-8f20-15ddfae12236",
    repository: { private: true, requestedName: "vendor-onboarding" },
  };
  const handoff = builderHandoffRecordSchema.parse({
    authority: ownerContext.authority,
    createdAt: new Date("2026-09-01T12:00:00.000Z"),
    creationRequestId: "d92d7d98-a078-411a-a5cd-66371a184da0",
    expiresAt: new Date("2026-09-08T12:00:00.000Z"),
    handoffId,
    intent,
    redeemedAt: new Date("2026-09-01T12:01:00.000Z"),
    requestDigest: "b".repeat(64),
    sessionId: ownerContext.sessionId,
    version: 1,
  });
  const eve: Pick<HostedEveStore, "getSession" | "recordPrivateApprovalReceipts"> = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory store seam has no asynchronous work.
    getSession: vi.fn(async () => {
      await Promise.resolve();
      return sessionOverride ?? currentSession;
    }),
    async recordPrivateApprovalReceipts(input) {
      await Promise.resolve();
      currentSession.privateApprovalReceipts = [
        ...(currentSession.privateApprovalReceipts ?? []),
        ...input.receipts,
      ];
    },
  };
  const handoffs: Pick<BuilderHandoffStore, "read"> = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory store seam has no asynchronous work.
    read: vi.fn(async () => (missingHandoff ? undefined : handoff)),
  };
  const membership: HostedWorkspaceMembership = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory membership seam has no asynchronous work.
    isMember: vi.fn(async () => {
      await Promise.resolve();
      return activeMember;
    }),
  };
  // oxlint-disable-next-line eslint/require-await -- credential fixture is a direct in-memory result.
  const readVercelCredential = vi.fn(async () => ({
    binding: {
      active: true,
      displayName: "Acme",
      installationId: "icfg_1",
      plan: "pro",
      scopeId: "team_1",
      scopeType: "team" as const,
      slug: "acme",
      updatedAt: new Date(),
    },
    token: "credential-never-exposed",
  }));
  // oxlint-disable-next-line eslint/require-await -- provider response fixture is produced locally.
  const fetch = vi.fn(async () =>
    Response.json({
      accountId: "team_1",
      id: selection.projectId,
      name: "apps-vendor-onboarding",
    }),
  );
  const listVercelInstallations = vi.fn(async () => {
    await Promise.resolve();
    return [{ active: true, installationId: "icfg_1" }];
  });
  const authority = createHostedOperatorOwnerAuthority({
    apiOrigin: "https://vercel.example",
    eve,
    fetch,
    handoffs,
    keyResolver,
    listVercelInstallations,
    membership,
    readVercelCredential,
    workloadPolicy,
  });
  return {
    authority,
    currentSession,
    eve,
    fetch,
    handoffs,
    listVercelInstallations,
    membership,
    readVercelCredential,
  };
};

const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "actor", organizationId: "organization", roles: ["owner"] }],
  action: "prepare",
  appDatabase: {
    database: "vendor_app",
    migratorRole: "vendor_migrator",
    resourceId: "app-resource",
    runtimeRole: "vendor_runtime",
  },
  authDatabase: {
    database: "vendor_auth",
    migratorRole: "auth_migrator",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context-1",
  cost: { class: "shared-recovery-group", description: "test", owner: "operator" },
  effects: [
    { description: "resources", id: "resources", kind: "resources" },
    { description: "install", id: "install", kind: "install" },
    { description: "access", id: "access", kind: "access" },
    { description: "bindings", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "branch-1",
    connectionRef: "connection-1",
    endpoint: "ep-1.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://gateway.example",
    projectId: selection.projectId,
  },
  release: { artifactRef: "artifact", id: "release-1", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "test" },
  selection,
  version: 1,
});

const request = (bearer = token) =>
  new Request("https://operator.example/v1/runtime", {
    headers: bearer === "" ? {} : { authorization: `Bearer ${bearer}` },
    method: "POST",
  });

const retainedApprovalFixture = () => {
  const fixture = makeFixture();
  const preparePlan = hostedOperatorPlanSchema.parse({
    ...plan,
    authSchema: {
      artifactRef: "retained-auth-artifact",
      installer: plan.installer,
      planDigest: "c".repeat(64),
      targetDigest: "d".repeat(64),
    },
  });
  const cleanupPlan = hostedOperatorPlanSchema.parse({
    ...preparePlan,
    action: "cleanup",
    effects: [
      { description: "revoke", id: "revoke", kind: "revoke" },
      { description: "remove", id: "remove-bindings", kind: "remove-bindings" },
      {
        description: "retire app only",
        id: "retire",
        kind: "retire",
      },
    ],
  });
  const prepareOperation = "a5c2b20f-0c08-49a8-a34f-cce64c72cc8c";
  const cleanupOperation = "849497e7-38e1-413c-8264-ce0fbd82f242";
  const makeReceipt = (selectedPlan: typeof plan, operationRef: string, callId: string) =>
    privateHostedApprovalReceiptSchema.parse({
      callId,
      format: "autograph-hosted-approval-v1",
      outcome: "approved",
      requestId: `approval-${callId}`,
      responderPrincipalId: principal.ownerUserId,
      sequence: 1,
      toolInput: {
        appId: selection.appId,
        branch: selection.branch,
        environment: selection.environment,
        operationRef,
        plan: selectedPlan,
        planDigest: operatorPlanDigest(selectedPlan),
        projectId: selection.projectId,
      },
      toolName:
        selectedPlan.action === "prepare"
          ? "prepare-app-hosted-runtime"
          : "cleanup-app-hosted-runtime",
      turnId: "turn-1",
    });
  const prepareReceipt = makeReceipt(preparePlan, prepareOperation, "prepare-call");
  const cleanupReceipt = makeReceipt(cleanupPlan, cleanupOperation, "cleanup-call");
  fixture.currentSession.privateApprovalReceipts = [prepareReceipt, cleanupReceipt];
  const runtimeTarget = hostedRuntimeTargetSchema.parse({
    ...selection,
    installationId: "icfg_1",
    scopeId: "team_1",
    scopeType: "team",
  });
  const record = hostedRuntimeJournalRecordSchema.parse({
    approvedByCallId: cleanupReceipt.callId,
    kind: "app-runtime",
    operator: {
      approvalId: cleanupReceipt.requestId,
      mode: "protected-operator-v1",
      operationRef: cleanupOperation,
      plan: cleanupPlan,
      planDigest: cleanupReceipt.toolInput.planDigest,
      receipts: [],
    },
    request: runtimeTarget,
    retainedAuth: {
      approvalId: prepareReceipt.requestId,
      approvedByCallId: prepareReceipt.callId,
      authPreparation: {
        assetSha256: "a".repeat(64),
        catalogFingerprint: "b".repeat(64),
        database: preparePlan.authDatabase.database,
        observedAt: "2026-10-09T00:00:00Z",
        runtimeRole: preparePlan.authDatabase.runtimeRole,
        targetDigest: preparePlan.authSchema?.targetDigest,
      },
      fenceGeneration: 1,
      operationRef: prepareOperation,
      plan: preparePlan,
      planDigest: prepareReceipt.toolInput.planDigest,
      receipts: preparePlan.effects.map((effect) => ({
        effectId: effect.id,
        fenceGeneration: effect.kind === "access" ? 1 : undefined,
        observedAt: "2026-10-09T00:00:00Z",
        resourceVersion: "a".repeat(64),
      })),
    },
    status: "cleaned",
    step: "cleaned",
    version: 1,
  });
  const journal: Pick<HostedRuntimeJournalStore, "read"> = {
    read: vi.fn(async () => {
      await Promise.resolve();
      return { record, revision: 1 };
    }),
  };
  const observe = vi.fn(async () => {
    await Promise.resolve();
    throw new Error("The exact terminal receipt is already retained.");
  });
  const readApproval = createHostedOperatorReadApproval({ eve: fixture.eve, journal, observe });
  const context = {
    authority: ownerContext.authority,
    ownerContext,
    target: runtimeTarget,
  };
  const prepareInput = {
    ...context,
    action: "prepare" as const,
    callId: prepareReceipt.callId,
    planDigest: prepareReceipt.toolInput.planDigest,
  };
  return {
    cleanupReceipt,
    context,
    fixture,
    observe,
    prepareInput,
    prepareReceipt,
    readApproval,
    record,
  };
};

describe("hosted operator owner authority", () => {
  it("reads the original exact prepare approval after source app cleanup", async () => {
    const retained = retainedApprovalFixture();
    await expect(retained.readApproval(retained.prepareInput)).resolves.toEqual({
      action: "prepare",
      approvalId: retained.prepareReceipt.requestId,
      approved: true,
      callId: retained.prepareReceipt.callId,
      planDigest: retained.prepareReceipt.toolInput.planDigest,
    });
    expect(retained.observe).not.toHaveBeenCalled();
  });

  it("keeps cleanup approval bound to the current cleanup operation", async () => {
    const retained = retainedApprovalFixture();
    await expect(
      retained.readApproval({
        ...retained.context,
        action: "cleanup",
        callId: retained.cleanupReceipt.callId,
        planDigest: retained.cleanupReceipt.toolInput.planDigest,
      }),
    ).resolves.toMatchObject({ action: "cleanup", approvalId: retained.cleanupReceipt.requestId });
    await expect(
      retained.readApproval({ ...retained.prepareInput, action: "cleanup" }),
    ).rejects.toThrow();
  });

  it.each([
    "call",
    "digest",
    "operation",
    "plan",
    "approval",
    "readiness",
    "foreign",
    "cancelled",
  ] as const)("rejects a mismatched retained prepare %s", async (mismatch) => {
    const retained = retainedApprovalFixture();
    const provenance = retained.record.retainedAuth;
    if (provenance === undefined) {
      throw new Error("Expected retained Auth fixture.");
    }
    switch (mismatch) {
      case "call": {
        retained.prepareInput.callId = "another-call";
        break;
      }
      case "digest": {
        retained.prepareInput.planDigest = "e".repeat(64);
        break;
      }
      case "operation": {
        provenance.operationRef = retained.cleanupReceipt.toolInput.operationRef;
        break;
      }
      case "plan": {
        provenance.plan.cost.description = "changed after approval";
        break;
      }
      case "approval": {
        provenance.approvalId = "another-approval";
        break;
      }
      case "readiness": {
        provenance.authPreparation.targetDigest = "e".repeat(64);
        break;
      }
      case "foreign": {
        retained.prepareReceipt.responderPrincipalId = "another-owner";
        break;
      }
      case "cancelled": {
        retained.prepareReceipt.outcome = "cancelled";
        break;
      }
      default: {
        throw new Error("Unexpected retained approval mismatch.");
      }
    }
    await expect(retained.readApproval(retained.prepareInput)).rejects.toThrow();
  });

  it("derives a target from current owner-scoped session, handoff, membership, and Vercel readback", async () => {
    const fixture = makeFixture();
    const context = await fixture.authority.authorize(request(), selection, ownerContext);
    expect(context).toMatchObject({
      authority: ownerContext.authority,
      ownerContext,
      target: {
        appId: selection.appId,
        branch: selection.branch,
        installationId: "icfg_1",
        projectId: selection.projectId,
        scopeId: "team_1",
        scopeType: "team",
        sessionId: selection.sessionId,
      },
    });
    await fixture.authority.assertAuthorized({ ...context, plan });
    expect(fixture.eve.getSession).toHaveBeenCalledWith(principal, ownerContext.sessionId);
    expect(fixture.handoffs.read).toHaveBeenCalledWith({
      authority: ownerContext.authority,
      handoffId,
    });
    expect(fixture.membership.isMember).toHaveBeenCalledWith({
      principal,
      workspaceId: ownerContext.authority.workspaceId,
    });
    expect(fixture.readVercelCredential).toHaveBeenCalled();
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
  });

  it("reads planning authority without fabricating an approved plan and rejects stale ownership", async () => {
    const fixture = makeFixture();
    const context = await fixture.authority.authorize(request(), selection, ownerContext);
    const owned = await fixture.authority.readCurrentPlanningOwner(context);
    expect(owned.target).toEqual(context.target);
    expect(owned.session.adapterSessionId).toBe(ownerContext.adapterSessionId);
    await fixture.authority.assertPlanningAuthorized(context);
    await expect(
      fixture.authority.assertPlanningAuthorized({
        ...context,
        target: { ...context.target, projectId: "prj_foreign" },
      }),
    ).rejects.toThrow();
    fixture.currentSession.adapterGeneration = 2;
    await expect(fixture.authority.readCurrentPlanningOwner(context)).rejects.toThrow();
  });

  it("requires the pinned trusted workload identity before any owner lookup", async () => {
    const fixture = makeFixture();
    await expect(
      fixture.authority.authorize(request(""), selection, ownerContext),
    ).rejects.toThrow();
    expect(fixture.handoffs.read).not.toHaveBeenCalled();
    expect(fixture.eve.getSession).not.toHaveBeenCalled();
  });

  it("keeps legacy private handoff owner contexts bound to the existing handoff path", async () => {
    const legacyHandoffInput = {
      adapterGeneration: ownerContext.adapterGeneration,
      adapterSessionId: ownerContext.adapterSessionId,
      authority: ownerContext.authority,
      principal,
      sessionId: ownerContext.sessionId,
      sourceHandoffId: handoffId,
    };
    expect(legacyHandoffInput).not.toHaveProperty("kind");
    const legacyHandoffContext = operatorOwnerContextSchema.parse(legacyHandoffInput);
    const fixture = makeFixture();
    await expect(
      fixture.authority.authorize(request(), selection, legacyHandoffContext),
    ).resolves.toMatchObject({ ownerContext });
    expect(fixture.handoffs.read).toHaveBeenCalledWith({
      authority: ownerContext.authority,
      handoffId,
    });
  });

  it("rejects stale adapter generations and rechecks them before effects", async () => {
    const stale = makeFixture();
    await expect(
      stale.authority.authorize(request(), selection, { ...ownerContext, adapterGeneration: 2 }),
    ).rejects.toThrow();

    const current = makeFixture();
    const context = await current.authority.authorize(request(), selection, ownerContext);
    current.currentSession.adapterGeneration = 2;
    await expect(current.authority.assertAuthorized({ ...context, plan })).rejects.toThrow();
  });

  it("rejects a project selection that differs from the prepared handoff", async () => {
    const fixture = makeFixture();
    await expect(
      fixture.authority.authorize(
        request(),
        { ...selection, projectId: "prj_other" },
        ownerContext,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  });

  it("plans a direct start only for its durable app and a live owner Vercel grant", async () => {
    const fixture = makeFixture(directSessionRecord());
    const context = await fixture.authority.authorize(request(), selection, directOwnerContext);
    expect(context).toMatchObject({
      ownerContext: directOwnerContext,
      target: {
        appId: selection.appId,
        branch: selection.branch,
        installationId: "icfg_1",
        projectId: selection.projectId,
        scopeId: "team_1",
        scopeType: "team",
        sessionId: selection.sessionId,
      },
    });
    await fixture.authority.assertAuthorized({ ...context, plan });
    expect(fixture.handoffs.read).not.toHaveBeenCalled();
    expect(fixture.listVercelInstallations).toHaveBeenCalledWith(ownerContext.authority);
    expect(fixture.readVercelCredential).toHaveBeenCalledWith({
      authority: ownerContext.authority,
      installationId: "icfg_1",
    });
    expect(fixture.fetch).toHaveBeenCalledTimes(2);
    await expect(
      fixture.authority.assertAuthorized({
        ...context,
        plan: { ...plan, selection: { ...selection, branch: "changed-branch" } },
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    fixture.listVercelInstallations.mockResolvedValue([]);
    await expect(fixture.authority.assertAuthorized({ ...context, plan })).rejects.toMatchObject({
      code: "resource_mismatch",
    });
  });

  it("rejects direct app adoption, a stale owner row, and handoff-to-direct downgrade", async () => {
    const directSession = directSessionRecord();
    const direct = makeFixture(directSession);
    await expect(
      direct.authority.authorize(
        request(),
        { ...selection, appId: "another-app" },
        directOwnerContext,
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
    expect(direct.listVercelInstallations).not.toHaveBeenCalled();

    const stale = makeFixture(directSessionRecord({ adapterGeneration: 2 }));
    await expect(
      stale.authority.authorize(request(), selection, directOwnerContext),
    ).rejects.toMatchObject({ code: "authorization_required" });

    const crossOwner = makeFixture(
      directSessionRecord({ principal: { ...principal, ownerUserId: "another-owner" } }),
    );
    await expect(
      crossOwner.authority.authorize(request(), selection, directOwnerContext),
    ).rejects.toMatchObject({ code: "authorization_required" });

    const inactive = makeFixture(directSession, false, false);
    await expect(
      inactive.authority.authorize(request(), selection, directOwnerContext),
    ).rejects.toMatchObject({ code: "authorization_required" });

    const downgraded = makeFixture();
    await expect(
      downgraded.authority.authorize(request(), selection, {
        ...directOwnerContext,
        sessionId: ownerContext.sessionId,
      }),
    ).rejects.toMatchObject({ code: "authorization_required" });
    expect(downgraded.handoffs.read).not.toHaveBeenCalled();

    const forgedHandoff = { ...directOwnerContext, sourceHandoffId: handoffId };
    await expect(
      downgraded.authority.authorize(request(), selection, forgedHandoff),
    ).rejects.toMatchObject({ code: "authorization_required" });
  });

  it("rejects a direct project outside every current owner installation", async () => {
    const fixture = makeFixture(directSessionRecord());
    await expect(
      fixture.authority.authorize(
        request(),
        { ...selection, projectId: "prj_unowned" },
        directOwnerContext,
      ),
    ).rejects.toMatchObject({ code: "resource_mismatch" });
  });

  it("normalizes an owner-bound v1 session using its exact redeemed handoff and adapter binding", async () => {
    const legacySession = hostedSessionRecordSchema.parse({
      adapterSessionId: ownerContext.adapterSessionId,
      createdAtEpochMs: 100,
      principal,
      sessionId: ownerContext.sessionId,
      status: "waiting",
      updatedAtEpochMs: 100,
      version: 1,
    });
    const fixture = makeFixture(legacySession);
    await expect(
      fixture.authority.authorize(request(), selection, ownerContext),
    ).resolves.toMatchObject({ target: { sessionId: ownerContext.sessionId } });

    const mismatchedAdapter = hostedSessionRecordSchema.parse({
      ...legacySession,
      adapterSessionId: "another-adapter",
    });
    const stale = makeFixture(mismatchedAdapter);
    await expect(stale.authority.authorize(request(), selection, ownerContext)).rejects.toThrow();

    const missing = makeFixture(legacySession, true);
    await expect(missing.authority.authorize(request(), selection, ownerContext)).rejects.toThrow();
  });

  it("reads only the exact terminal owner approval for the frozen journal plan", async () => {
    const fixture = makeFixture();
    const planDigest = operatorPlanDigest(plan);
    const operationRef = "a5c2b20f-0c08-49a8-a34f-cce64c72cc8c";
    const receipt = privateHostedApprovalReceiptSchema.parse({
      callId: "tool-call-1",
      format: "autograph-hosted-approval-v1",
      outcome: "approved",
      requestId: "f0ecb436-8042-4689-bb01-043c45a81631",
      responderPrincipalId: principal.ownerUserId,
      sequence: 1,
      toolInput: {
        appId: selection.appId,
        branch: selection.branch,
        environment: selection.environment,
        operationRef,
        plan,
        planDigest,
        projectId: selection.projectId,
      },
      toolName: "prepare-app-hosted-runtime",
      turnId: "turn-1",
    });
    const runtimeTarget = hostedRuntimeTargetSchema.parse({
      ...selection,
      installationId: "icfg_1",
      scopeId: "team_1",
      scopeType: "team",
    });
    const record = hostedRuntimeJournalRecordSchema.parse({
      approvedByCallId: "operator:unapproved-plan",
      kind: "app-runtime",
      operator: {
        mode: "protected-operator-v1",
        operationRef,
        plan,
        planDigest,
        receipts: [],
      },
      request: runtimeTarget,
      status: "pending",
      step: "planned",
      version: 1,
    });
    const journal: Pick<HostedRuntimeJournalStore, "read"> = {
      // oxlint-disable-next-line eslint/require-await -- this fixture returns the exact in-memory journal row.
      read: vi.fn(async () => ({ record, revision: 1 })),
    };
    const context = await fixture.authority.authorize(request(), selection, ownerContext);
    let concurrentRead:
      | {
          action: "prepare" | "cleanup";
          approvalId: string;
          approved: boolean;
          callId: string;
          planDigest: string;
        }
      | undefined;
    const concurrentReader = createHostedOperatorReadApproval({
      eve: fixture.eve,
      journal,
      observe: async () => {
        await Promise.resolve();
        throw new Error("The terminal receipt was already persisted.");
      },
    });
    let observationFinished = false;
    const observe = vi.fn(
      async (streamRequest: Parameters<NonNullable<HostedEveTransport["observe"]>>[0]) => {
        expect(streamRequest.sessionId).toBe(ownerContext.sessionId);
        expect(streamRequest.adapterSessionId).toBe(ownerContext.adapterSessionId);
        expect(streamRequest.readDeadline).toBe(true);
        await streamRequest.onPrivateEvent?.(approvalRequestEvent(receipt));
        await streamRequest.onPrivateEvent?.(approvalSettledEvent(receipt));
        concurrentRead = await concurrentReader({
          ...context,
          action: "prepare",
          callId: receipt.callId,
          planDigest,
        });
        expect(observationFinished).toBe(false);
        observationFinished = true;
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 2,
          pendingRequests: [],
          publicEventCount: 0,
          status: "waiting" as const,
        };
      },
    );
    const readApproval = createHostedOperatorReadApproval({ eve: fixture.eve, journal, observe });
    await expect(
      readApproval({
        ...context,
        action: "prepare",
        callId: receipt.callId,
        planDigest,
      }),
    ).resolves.toEqual({
      action: "prepare",
      approvalId: receipt.requestId,
      approved: true,
      callId: receipt.callId,
      planDigest,
    });
    expect(observationFinished).toBe(true);
    expect(concurrentRead).toMatchObject({ approvalId: receipt.requestId, approved: true });
    expect(fixture.currentSession.privateApprovalReceipts).toEqual([receipt]);
    const restartedReader = createHostedOperatorReadApproval({
      eve: fixture.eve,
      journal,
      observe: vi.fn(async () => {
        await Promise.resolve();
        throw new Error("A persisted terminal receipt must not require another stream read.");
      }),
    });
    await expect(
      restartedReader({ ...context, action: "prepare", callId: receipt.callId, planDigest }),
    ).resolves.toMatchObject({ approvalId: receipt.requestId, approved: true });
    expect(observe).toHaveBeenCalledTimes(1);
    fixture.currentSession.privateApprovalReceipts = [];
    const submittedOnlyReader = createHostedOperatorReadApproval({
      eve: fixture.eve,
      journal,
      observe: async (streamRequest) => {
        await streamRequest.onPrivateEvent?.(approvalRequestEvent(receipt));
        await streamRequest.onPrivateEvent?.(approvalCandidateEvent(receipt));
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 2,
          pendingRequests: [],
          publicEventCount: 0,
          status: "waiting",
        };
      },
    });
    await expect(
      submittedOnlyReader({ ...context, action: "prepare", callId: receipt.callId, planDigest }),
    ).rejects.toThrow();
    expect(fixture.currentSession.privateApprovalReceipts).toEqual([]);
    fixture.currentSession.privateApprovalReceipts = [{ ...receipt, outcome: "cancelled" }];
    await expect(
      readApproval({ ...context, action: "prepare", callId: receipt.callId, planDigest }),
    ).rejects.toThrow();
    fixture.currentSession.privateApprovalReceipts = [
      { ...receipt, responderPrincipalId: "another-owner" },
    ];
    await expect(
      readApproval({ ...context, action: "prepare", callId: receipt.callId, planDigest }),
    ).rejects.toThrow();
  });
});
