import { generateKeyPair, SignJWT } from "jose";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { durableHostedSessionRecordSchema, hostedSessionRecordSchema } from "../eve/hosted-store";
import type { HostedEveStore, HostedSessionRecord } from "../eve/hosted-store";
import { privateHostedApprovalReceiptSchema } from "../eve/private-hosted-approval";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { builderHandoffRecordSchema } from "../handoff/contracts";
import type { BuilderHandoffStore } from "../handoff/service";
import type { HostedWorkspaceMembership } from "../mcp/request-handler";
import { hostedOperatorPlanSchema, operatorPlanDigest } from "./hosted-operator-contract";
import type { OperatorOwnerContext, OperatorSelection } from "./hosted-operator-contract";
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
  principal,
  sessionId: "public-session-1",
  sourceHandoffId: handoffId,
};
const selection: OperatorSelection = {
  appId: "vendor-onboarding",
  branch: "main",
  environment: "preview",
  projectId: "prj_1",
  sessionId: ownerContext.sessionId,
};
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

const makeFixture = (sessionOverride?: HostedSessionRecord, missingHandoff = false) => {
  const currentSession = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: ownerContext.adapterSessionId,
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
  const eve: Pick<HostedEveStore, "getSession"> = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory store seam has no asynchronous work.
    getSession: vi.fn(async () => sessionOverride ?? currentSession),
  };
  const handoffs: Pick<BuilderHandoffStore, "read"> = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory store seam has no asynchronous work.
    read: vi.fn(async () => (missingHandoff ? undefined : handoff)),
  };
  const membership: HostedWorkspaceMembership = {
    // oxlint-disable-next-line eslint/require-await -- this in-memory membership seam has no asynchronous work.
    isMember: vi.fn(async () => true),
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
  const authority = createHostedOperatorOwnerAuthority({
    apiOrigin: "https://vercel.example",
    eve,
    fetch,
    handoffs,
    keyResolver,
    membership,
    readVercelCredential,
    workloadPolicy,
  });
  return { authority, currentSession, eve, fetch, handoffs, membership, readVercelCredential };
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

describe("hosted operator owner authority", () => {
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

  it("requires the pinned trusted workload identity before any owner lookup", async () => {
    const fixture = makeFixture();
    await expect(
      fixture.authority.authorize(request(""), selection, ownerContext),
    ).rejects.toThrow();
    expect(fixture.handoffs.read).not.toHaveBeenCalled();
    expect(fixture.eve.getSession).not.toHaveBeenCalled();
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
    fixture.currentSession.privateApprovalReceipts = [receipt];
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
    const readApproval = createHostedOperatorReadApproval({ eve: fixture.eve, journal });
    const context = await fixture.authority.authorize(request(), selection, ownerContext);
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
