import { generateKeyPair, SignJWT } from "jose";
import type { MessageStreamEvent } from "eve/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { activeBuilderModelId } from "../integrations/active-model";
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
  createHostedOperatorReadApprovedPlan,
} from "./hosted-operator-owner";
import {
  hostedRuntimeJournalRecordSchema,
  hostedRuntimeTargetSchema,
  // oxlint-disable-next-line import/consistent-type-specifier-style -- Keep this module in one import declaration.
  type HostedRuntimeJournalStore,
} from "./hosted-runtime-journal";
import type { OperatorWorkloadPolicy } from "./hosted-operator-workload";
import { normalActorProgramDigest } from "./hosted-operator-normal-actor-program";

import type {
  HostedOperatorConsentDiagnostic,
  HostedOperatorConsentDiagnosticSink,
} from "./hosted-operator-consent-diagnostic";

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
  diagnosticSink?: HostedOperatorConsentDiagnosticSink,
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
    modelId: activeBuilderModelId,
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
  const readVercelCredential = vi.fn<
    Parameters<typeof createHostedOperatorOwnerAuthority>[0]["readVercelCredential"]
  >(async () => {
    await Promise.resolve();
    return {
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
    };
  });
  // oxlint-disable-next-line eslint/require-await -- provider response fixture is produced locally.
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
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
    diagnosticSink,
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

const expectNoProviderReads = (fixture: ReturnType<typeof makeFixture>) => {
  expect(fixture.listVercelInstallations).not.toHaveBeenCalled();
  expect(fixture.readVercelCredential).not.toHaveBeenCalled();
  expect(fixture.fetch).not.toHaveBeenCalled();
};

describe("hosted operator artifact ownership", () => {
  const contextFor = (owner: OperatorOwnerContext = ownerContext) => ({
    authority: owner.authority,
    ownerContext: owner,
    target: hostedRuntimeTargetSchema.parse({
      ...selection,
      installationId: "icfg_1",
      scopeId: "team_1",
      scopeType: "team",
    }),
  });

  it.each(["direct", "handoff"] as const)(
    "reads current %s artifact ownership independently of provider grants",
    async (kind) => {
      const fixture = makeFixture(kind === "direct" ? directSessionRecord() : undefined);
      const context = contextFor(kind === "direct" ? directOwnerContext : ownerContext);
      await fixture.authority.assertArtifactAuthorized(context);
      expectNoProviderReads(fixture);
      expect(fixture.eve.getSession).toHaveBeenCalledWith(principal, ownerContext.sessionId);
      expect(fixture.membership.isMember).toHaveBeenCalledWith({
        principal,
        workspaceId: principal.workspaceId,
      });
      vi.mocked(fixture.membership.isMember).mockResolvedValue(false);
      await expect(fixture.authority.assertArtifactAuthorized(context)).rejects.toThrow();
      expectNoProviderReads(fixture);
    },
  );

  it.each(["direct", "handoff"] as const)(
    "rejects foreign or stale %s identity before exposing artifact bytes",
    async (kind) => {
      const fixture = makeFixture(kind === "direct" ? directSessionRecord() : undefined);
      const owner = kind === "direct" ? directOwnerContext : ownerContext;
      const context = contextFor(owner);
      const mismatches = [
        { ...context, authority: { ...context.authority, ownerUserId: "foreign" } },
        { ...context, target: { ...context.target, appId: "foreign-app" } },
        { ...context, target: { ...context.target, sessionId: "foreign-session" } },
        {
          ...context,
          ownerContext: { ...owner, authority: { ...owner.authority, workspaceId: "foreign" } },
        },
        {
          ...context,
          ownerContext: { ...owner, principal: { ...principal, scopes: ["foreign"] } },
        },
        {
          ...context,
          ownerContext: { ...owner, sessionId: "foreign-session" },
          target: { ...context.target, sessionId: "foreign-session" },
        },
        { ...context, ownerContext: { ...owner, adapterSessionId: "foreign-adapter" } },
        { ...context, ownerContext: { ...owner, adapterGeneration: 2 } },
      ];
      const readArtifact = vi.fn();
      for (const mismatch of mismatches) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Each rejected ownership check completes before the next attempt.
        await expect(
          (async () => {
            await fixture.authority.assertArtifactAuthorized(mismatch);
            readArtifact();
          })(),
        ).rejects.toThrow();
      }
      expect(readArtifact).not.toHaveBeenCalled();
      expectNoProviderReads(fixture);
    },
  );

  it("supports legacy v1 handoff ownership without provider access", async () => {
    const fixture = makeFixture(
      hostedSessionRecordSchema.parse({
        adapterSessionId: ownerContext.adapterSessionId,
        createdAtEpochMs: 100,
        principal,
        sessionId: ownerContext.sessionId,
        status: "waiting",
        updatedAtEpochMs: 100,
        version: 1,
      }),
    );
    await fixture.authority.assertArtifactAuthorized(contextFor());
    await expect(
      fixture.authority.assertArtifactAuthorized(contextFor(directOwnerContext)),
    ).rejects.toThrow();
    expectNoProviderReads(fixture);
  });

  it("rechecks canonical session and handoff linkage on every read", async () => {
    const fixture = makeFixture();
    const context = contextFor();
    await fixture.authority.assertArtifactAuthorized(context);
    fixture.currentSession.sourceHandoffId = "e0920c75-1fba-4a55-b12c-eef55396c03b";
    await expect(fixture.authority.assertArtifactAuthorized(context)).rejects.toThrow();
    fixture.currentSession.sourceHandoffId = handoffId;
    const handoff = await fixture.handoffs.read({ authority: ownerContext.authority, handoffId });
    if (handoff === undefined) {
      throw new Error("Missing fixture handoff.");
    }
    for (const changed of [
      { ...handoff, handoffId: "e0920c75-1fba-4a55-b12c-eef55396c03b" },
      { ...handoff, sessionId: "foreign-session" },
      { ...handoff, authority: { ...handoff.authority, ownerUserId: "foreign" } },
      { ...handoff, intent: { ...handoff.intent, appId: "foreign-app" } },
    ]) {
      vi.mocked(fixture.handoffs.read).mockResolvedValue(changed);
      // oxlint-disable-next-line eslint/no-await-in-loop -- Each attempt replaces the same canonical store response.
      await expect(fixture.authority.assertArtifactAuthorized(context)).rejects.toThrow();
    }
    expectNoProviderReads(fixture);
  });

  it.each(["direct", "handoff"] as const)(
    "retains live project grant enforcement for %s planning",
    async (kind) => {
      const fixture = makeFixture(kind === "direct" ? directSessionRecord() : undefined);
      const context = contextFor(kind === "direct" ? directOwnerContext : ownerContext);
      fixture.fetch.mockResolvedValue(
        Response.json({ error: { code: "forbidden" } }, { status: 403 }),
      );
      await fixture.authority.assertArtifactAuthorized(context);
      await expect(fixture.authority.assertPlanningAuthorized(context)).rejects.toThrow();
      expect(fixture.readVercelCredential).toHaveBeenCalled();
      expect(fixture.fetch).toHaveBeenCalled();
      fixture.fetch.mockClear();
      fixture.listVercelInstallations.mockResolvedValue([]);
      // oxlint-disable-next-line unicorn/no-useless-undefined -- Absence is the credential reader contract.
      vi.mocked(fixture.readVercelCredential).mockResolvedValue(undefined);
      await expect(fixture.authority.assertPlanningAuthorized(context)).rejects.toThrow();
      expect(fixture.fetch).not.toHaveBeenCalled();
    },
  );
});

describe("owner project access diagnostics", () => {
  it.each([
    ["direct", 403],
    ["direct", 429],
    ["handoff", 403],
    ["handoff", 429],
  ] as const)(
    "observes %s owner HTTP %s without exposing private request or response data",
    async (kind, status) => {
      const diagnostics: HostedOperatorConsentDiagnostic[] = [];
      const fixture = makeFixture(
        kind === "direct" ? directSessionRecord() : undefined,
        false,
        true,
        (event) => {
          diagnostics.push(event);
        },
      );
      const response = Response.json(
        { privateToken: "never-log-response", uri: "postgres://private-password@private-host/db" },
        { status, headers: { "private-header": "never-log-header" } },
      );
      const readJson = vi.spyOn(response, "json");
      const readText = vi.spyOn(response, "text");
      fixture.fetch.mockImplementation(async (providerRequest, init) => {
        await Promise.resolve();
        const url = new URL(
          providerRequest instanceof Request ? providerRequest.url : providerRequest,
        );
        expect(url.pathname).toBe(`/v9/projects/${selection.projectId}`);
        expect(url.searchParams.get("teamId")).toBe("team_1");
        expect(init?.method).toBe("GET");
        expect(init?.redirect).toBe("error");
        expect(init?.headers).toMatchObject({ Authorization: "Bearer credential-never-exposed" });
        return response;
      });
      await expect(
        fixture.authority.authorize(
          request(),
          selection,
          kind === "direct" ? directOwnerContext : ownerContext,
        ),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            httpStatus: status,
            planningFailure: { stage: "plan_owner_authorization", errorClass: "unexpected" },
          }),
        ]),
      );
      expect(fixture.fetch).toHaveBeenCalledTimes(1);
      expect(readJson).not.toHaveBeenCalled();
      expect(readText).not.toHaveBeenCalled();
      const serialized = JSON.stringify(diagnostics);
      for (const privateValue of [
        "never-log-response",
        "never-log-header",
        "private-password",
        "private-host",
        "credential-never-exposed",
        selection.projectId,
        ownerContext.sessionId,
        ownerContext.authority.ownerUserId,
      ]) {
        expect(serialized).not.toContain(privateValue);
      }
    },
  );

  it.each(["direct", "handoff"] as const)(
    "preserves %s owner denial when the diagnostic sink throws",
    async (kind) => {
      const fixture = makeFixture(
        kind === "direct" ? directSessionRecord() : undefined,
        false,
        true,
        () => {
          throw new Error("sink unavailable");
        },
      );
      fixture.fetch.mockResolvedValue(Response.json({}, { status: 403 }));
      await expect(
        fixture.authority.authorize(
          request(),
          selection,
          kind === "direct" ? directOwnerContext : ownerContext,
        ),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(fixture.fetch).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["direct", "handoff"] as const)(
    "observes %s transport categories before existing access normalization",
    async (kind) => {
      const diagnostics: HostedOperatorConsentDiagnostic[] = [];
      const fixture = makeFixture(
        kind === "direct" ? directSessionRecord() : undefined,
        false,
        true,
        (event) => {
          diagnostics.push(event);
        },
      );
      fixture.fetch.mockRejectedValue(
        new TypeError("credential-never-exposed private transport failure"),
      );
      await expect(
        fixture.authority.authorize(
          request(),
          selection,
          kind === "direct" ? directOwnerContext : ownerContext,
        ),
      ).rejects.toMatchObject({ code: "resource_mismatch" });
      expect(diagnostics).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            planningFailure: { stage: "plan_owner_authorization", errorClass: "type_error" },
          }),
        ]),
      );
      expect(diagnostics.some((event) => event.httpStatus !== undefined)).toBe(false);
      expect(JSON.stringify(diagnostics)).not.toContain("credential-never-exposed");
      expect(JSON.stringify(diagnostics)).not.toContain("private transport failure");
      expect(fixture.fetch).toHaveBeenCalledTimes(1);
    },
  );
});

describe("hosted operator owner authority", () => {
  it("verifies the original account approval after a new app operation replaces the plan", async () => {
    const retained = retainedApprovalFixture();
    const program = {
      version: 1 as const,
      appId: selection.appId,
      origin: "https://apps.example.test",
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
    const accountPlan = hostedOperatorPlanSchema.parse({
      ...retained.prepareReceipt.toolInput.plan,
      stage: "auth-participants",
      access: [],
      normalActorProgram: program,
      publicGateway: { branch: selection.branch, origin: program.origin, projectId: "prj_gateway" },
      deploymentBoundary: {
        authority: ownerContext.authority,
        teamId: "team_1",
        app: {
          branch: selection.branch,
          deploymentId: "dpl_app",
          environment: "preview",
          projectId: selection.projectId,
        },
        gateway: {
          branch: selection.branch,
          deploymentId: "dpl_gateway",
          environment: "preview",
          projectId: "prj_gateway",
        },
        operator: {
          deploymentId: "dpl_operator",
          environment: "preview",
          projectId: "prj_operator",
        },
        verification: {
          gatewayOrigin: "https://gateway.example.test",
          jwksUrl: "https://gateway.example.test/_platform/jwks.json",
          publicOrigin: program.origin,
        },
      },
      effects: [
        {
          id: "normal-accounts",
          kind: "normal-accounts",
          description: "Connect approved accounts",
        },
      ],
    });
    const planDigest = operatorPlanDigest(accountPlan);
    retained.prepareReceipt.toolInput.plan = accountPlan;
    retained.prepareReceipt.toolInput.planDigest = planDigest;
    retained.prepareInput.planDigest = planDigest;
    retained.record.accountPreparation = {
      program,
      programDigest: normalActorProgramDigest(program),
      accountOperationRef: retained.prepareReceipt.toolInput.operationRef,
      accountPlan,
      accountPlanDigest: planDigest,
      accountApprovalId: retained.prepareReceipt.requestId,
      accountApprovedByCallId: retained.prepareReceipt.callId,
      sealedState: { encryptedToken: "private", keyVersion: "v1", tokenIv: "iv", tokenTag: "tag" },
      captures: [],
    };
    await expect(retained.readApproval(retained.prepareInput)).resolves.toMatchObject({
      approved: true,
      approvalId: retained.prepareReceipt.requestId,
      planDigest,
    });
    retained.record.accountPreparation.accountOperationRef =
      retained.cleanupReceipt.toolInput.operationRef;
    await expect(retained.readApproval(retained.prepareInput)).rejects.toThrow();
    expect(retained.observe).not.toHaveBeenCalled();
  });

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

describe("canonical original approved plan reader", () => {
  const operationRef = "f58de890-c49f-4e5c-86d2-03d2d44166b9";
  const receipt = privateHostedApprovalReceiptSchema.parse({
    callId: "original-call",
    format: "autograph-hosted-approval-v1",
    outcome: "approved",
    requestId: "original-approval",
    responderPrincipalId: principal.ownerUserId,
    sequence: 1,
    toolInput: {
      appId: selection.appId,
      branch: selection.branch,
      environment: selection.environment,
      operationRef,
      plan,
      planDigest: operatorPlanDigest(plan),
      projectId: selection.projectId,
    },
    toolName: "prepare-app-hosted-runtime",
    turnId: "turn-original",
  });
  const setup = async () => {
    const f = makeFixture();
    f.currentSession.privateApprovalReceipts = [receipt];
    const context = await f.authority.authorize(request(), selection, ownerContext);
    const read = createHostedOperatorReadApprovedPlan({
      eve: f.eve,
      assertCanonicalOwner: f.authority.assertArtifactAuthorized,
    });
    const proposed = {
      ...plan,
      retention: { ...plan.retention, expiresAt: "2099-12-31T23:59:59Z" },
    };
    return {
      f,
      read,
      input: { ...context, plan: proposed, now: Date.parse("2026-10-14T00:00:00Z") },
    };
  };
  it("selects the actual original owner approval without extending its expiry", async () => {
    const { read, input } = await setup();
    expect(await read(input)).toEqual({
      operationRef,
      plan,
      planDigest: receipt.toolInput.planDigest,
    });
  });
  it("never reuses changed effects or expired original authority", async () => {
    const { read, input } = await setup();
    expect(await read({ ...input, plan: { ...input.plan, contextId: "changed" } })).toBeNull();
    expect(await read({ ...input, now: Date.parse(plan.retention.expiresAt) })).toBeNull();
  });
  it("denies latest cancellation, foreign responder and revoked canonical membership", async () => {
    const { f, read, input } = await setup();
    f.currentSession.privateApprovalReceipts = [
      receipt,
      { ...receipt, sequence: 2, requestId: "cancelled-request", outcome: "cancelled" },
    ];
    await expect(read(input)).rejects.toMatchObject({ code: "authorization_required" });
    f.currentSession.privateApprovalReceipts = [{ ...receipt, responderPrincipalId: "foreign" }];
    await expect(read(input)).rejects.toMatchObject({ code: "authorization_required" });
    f.currentSession.privateApprovalReceipts = [receipt];
    vi.spyOn(f.membership, "isMember").mockResolvedValue(false);
    await expect(read(input)).rejects.toMatchObject({ code: "authorization_required" });
  });
  it("denies restoration over a different actually approved replacement operation", async () => {
    const { f, read, input } = await setup();
    const replacement = {
      ...receipt,
      requestId: "new-approval",
      sequence: 0,
      toolInput: { ...receipt.toolInput, operationRef: "fcc825bc-d683-422c-8b58-0d0a065ceb57" },
    };
    f.currentSession.privateApprovalReceipts = [replacement, receipt];
    await expect(read({ ...input, currentOperation: replacement.toolInput })).rejects.toMatchObject(
      { code: "operation_in_progress" },
    );
  });
});
