import { randomUUID } from "node:crypto";

import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";

import { hostedEveOperationScopes } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { createHostedEveSessionService } from "./hosted-service";
import type { HostedEveTransport } from "./hosted-service";
import {
  createPrivateHostedApprovalCapture,
  createPrivateHostedApprovalRecorder,
  hydratePrivateHostedApprovalCaptureState,
  serializePrivateHostedApprovalCaptureState,
  privateHostedApprovalReceiptSchema,
  readPrivateHostedApproval,
} from "./private-hosted-approval";
import type { PrivateHostedApprovalReceipt } from "./private-hosted-approval";
import { projectInstalledEveEvent } from "./public-events";
import {
  hostedSessionRecordSchema,
  hostedSessionSummary,
  InMemoryHostedEveStore,
} from "./hosted-store";
import type { HostedEveStore } from "./hosted-store";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
} from "../provisioning/hosted-operator-contract";
import { publicSessionSummarySchema } from "../mcp/contracts";

const principal: HostedPrincipal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner_1",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace_1",
};

const sessionId = "session_fixture";
const selection = {
  appId: "spend-review",
  branch: "preview",
  environment: "preview" as const,
  projectId: "prj_fixture",
  sessionId,
};
const plan = hostedOperatorPlanSchema.parse({
  access: [{ actorId: "reviewer", organizationId: "org", roles: ["reviewer"] }],
  action: "prepare",
  appDatabase: {
    database: "spend",
    migratorRole: "spend_owner",
    resourceId: "app-resource",
    runtimeRole: "spend_runtime",
  },
  authDatabase: {
    database: "shared_auth",
    migratorRole: "auth_owner",
    resourceId: "auth-resource",
    runtimeRole: "auth_runtime",
  },
  contextId: "context",
  cost: { class: "shared-recovery-group", description: "fixture", owner: "owner" },
  effects: [
    { description: "verify resources", id: "resources", kind: "resources" },
    { description: "install release", id: "install", kind: "install" },
    { description: "grant access", id: "access", kind: "access" },
    { description: "bind runtime", id: "bindings", kind: "bindings" },
  ],
  installer: { reference: "installer", sha256: "a".repeat(64) },
  neon: {
    branchId: "br_synthetic",
    connectionRef: "owner-connection",
    endpoint: "ep-fixture.us-east-1.aws.neon.tech",
    projectId: "neon-project",
    source: "synthetic-only",
  },
  publicGateway: {
    branch: selection.branch,
    origin: "https://apps-preview.example.test",
    projectId: selection.projectId,
  },
  release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
  retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "retain" },
  selection,
  version: 1,
});
const toolInput = {
  appId: selection.appId,
  branch: selection.branch,
  environment: selection.environment,
  operationRef: "a3f06690-718f-41c7-a67f-c6c1c0ecdbf3",
  plan,
  planDigest: operatorPlanDigest(plan),
  projectId: selection.projectId,
};

const inputRequested = (
  requestId: string,
  toolName = "prepare-app-hosted-runtime",
  requestedToolInput = toolInput,
): MessageStreamEvent => ({
  data: {
    requests: [
      {
        action: { callId: "call_fixture", input: requestedToolInput, kind: "tool-call", toolName },
        kind: "tool-approval",
        prompt: "Approve hosted runtime preparation",
        requestId,
      },
    ],
    sequence: 4,
    stepIndex: 2,
    turnId: "turn_fixture",
  },
  meta: { at: "2026-10-06T00:00:00.000Z", id: `evt_${requestId}` },
  type: "input.requested",
});

const approvalSettled = (
  requestId: string,
  outcome: "approved" | "cancelled" = "approved",
): MessageStreamEvent => ({
  data: {
    outcome,
    requestId,
    responderPrincipalId: "owner_1",
    sequence: 5,
    stepIndex: 2,
    turnId: "turn_fixture",
  },
  meta: { at: "2026-10-06T00:00:00.000Z", id: `evt_settled_${requestId}` },
  type: "approval.settled",
});

const receipt = (
  savedSessionId: string,
  outcome: "approved" | "cancelled" = "approved",
): PrivateHostedApprovalReceipt => {
  const receiptPlan = hostedOperatorPlanSchema.parse({
    ...plan,
    selection: { ...selection, sessionId: savedSessionId },
  });
  return privateHostedApprovalReceiptSchema.parse({
    callId: "call_fixture",
    format: "autograph-hosted-approval-v1",
    outcome,
    requestId: "request_fixture",
    responderPrincipalId: "owner_1",
    sequence: 5,
    toolInput: {
      ...toolInput,
      plan: receiptPlan,
      planDigest: operatorPlanDigest(receiptPlan),
    },
    toolName: "prepare-app-hosted-runtime",
    turnId: "turn_fixture",
  });
};

const startedStore = async () => {
  const store = new InMemoryHostedEveStore();
  const snapshot = { events: [], status: "waiting" as const };
  // oxlint-disable-next-line typescript/promise-function-async -- test stubs preserve the transport Promise contract
  const transport: HostedEveTransport = {
    // oxlint-disable-next-line typescript/promise-function-async -- test stub
    cancel: () => Promise.resolve(snapshot),
    // oxlint-disable-next-line typescript/promise-function-async -- test stub
    get: () => Promise.resolve(snapshot),
    // oxlint-disable-next-line typescript/promise-function-async -- test stub
    respond: () => Promise.resolve(snapshot),
    // oxlint-disable-next-line typescript/promise-function-async -- test stub
    send: () => Promise.resolve(snapshot),
    // oxlint-disable-next-line typescript/promise-function-async -- test stub
    start: () => Promise.resolve({ adapterSessionId: "adapter_fixture", snapshot }),
  };
  const service = createHostedEveSessionService({ now: () => 10, principal, store, transport });
  const started = await service.start({ clientRequestId: randomUUID(), prompt: "Build an app" });
  return { sessionId: started.sessionId, store };
};

const recordReceipts = async (
  store: InMemoryHostedEveStore,
  savedSessionId: string,
  receipts: readonly PrivateHostedApprovalReceipt[],
) => {
  if (store.recordPrivateApprovalReceipts === undefined) {
    throw new Error("Private approval persistence is unavailable.");
  }
  await store.recordPrivateApprovalReceipts({ principal, receipts, sessionId: savedSessionId });
};

describe("private hosted approval receipts", () => {
  it("captures only exact hosted-runtime tool requests and authoritative Eve settlement", () => {
    const capture = createPrivateHostedApprovalCapture(sessionId);
    capture.observe(inputRequested("request_fixture"));
    capture.observe(approvalSettled("request_fixture", "cancelled"));
    const [saved] = capture.values();
    expect(saved?.outcome).toBe("cancelled");
    expect(saved?.toolInput).toEqual(toolInput);
    expect(saved?.responderPrincipalId).toBe("owner_1");

    const unrelated = createPrivateHostedApprovalCapture(sessionId);
    unrelated.observe(inputRequested("request_other", "publish-github-draft-pr"));
    unrelated.observe(approvalSettled("request_other"));
    expect(unrelated.values()).toEqual([]);
  });

  it("does not expose tool input or responder identity in public Eve projections", () => {
    const rawRequest = inputRequested("request_fixture");
    const rawSettlement = approvalSettled("request_fixture");
    const publicEvents = [
      ...projectInstalledEveEvent(rawRequest, 0),
      ...projectInstalledEveEvent(rawSettlement, 1),
    ];
    const serialized = JSON.stringify(publicEvents);
    expect(serialized).not.toContain("call_fixture");
    expect(serialized).not.toContain("planDigest");
    expect(serialized).not.toContain("responderPrincipalId");
  });

  it("persists owner-scoped receipts across concurrent checkpoint and recovery updates", async () => {
    const { sessionId: savedSessionId, store } = await startedStore();
    const savedReceipt = receipt(savedSessionId);
    await Promise.all([
      recordReceipts(store, savedSessionId, [savedReceipt]),
      recordReceipts(store, savedSessionId, [savedReceipt]),
    ]);
    await store.observeSession?.({
      checkpoint: { capturedAtEpochMs: 11, events: [], status: "waiting", version: 1 },
      nowEpochMs: 11,
      principal,
      resumability: "live",
      sessionId: savedSessionId,
      stage: "designing",
    });
    let current = await store.getSession(principal, savedSessionId);
    expect(current?.version === 2 ? current.privateApprovalReceipts : undefined).toEqual([
      savedReceipt,
    ]);
    if (current?.version !== 2) {
      throw new Error("Expected durable hosted session.");
    }
    await store.replaceSessionAdapter?.({
      adapterSessionId: "adapter_recovered",
      checkpoint: { capturedAtEpochMs: 12, events: [], status: "waiting", version: 1 },
      expectedAdapterGeneration: current.adapterGeneration,
      expectedCheckpointDigest: current.checkpointDigest,
      nowEpochMs: 12,
      principal,
      resumability: "live",
      sessionId: savedSessionId,
      stage: "designing",
    });
    current = await store.getSession(principal, savedSessionId);
    expect(current?.version === 2 ? current.privateApprovalReceipts : undefined).toEqual([
      savedReceipt,
    ]);

    if (current === null) {
      throw new Error("Hosted session disappeared after recovery.");
    }
    const publicSummary = publicSessionSummarySchema.parse(hostedSessionSummary(current));
    expect(JSON.stringify(publicSummary)).not.toContain("privateApprovalReceipts");
    expect(JSON.stringify(publicSummary)).not.toContain("call_fixture");
  });

  it("captures raw stream approvals during hosted spool and keeps them out of the public read", async () => {
    const base = new InMemoryHostedEveStore();
    const store: HostedEveStore = {
      getSession: base.getSession.bind(base),
      listSessions: base.listSessions.bind(base),
      observeSession: base.observeSession.bind(base),
      observeSessionPaged: async (input) => {
        const events = [];
        for await (const event of input.events) {
          events.push(event);
        }
        return await base.observeSession({
          checkpoint: {
            capturedAtEpochMs: input.metadata.capturedAtEpochMs,
            events,
            status: input.metadata.status,
            version: 1,
          },
          nowEpochMs: input.nowEpochMs,
          principal: input.principal,
          resumability: input.resumability,
          sessionId: input.sessionId,
          stage: input.stage,
        });
      },
      // oxlint-disable-next-line typescript/promise-function-async -- Inline fixture checkpoint does not use page reads.
      readCheckpointPage: () =>
        Promise.reject(new Error("Inline fixture checkpoint does not use page reads.")),
      recordPrivateApprovalReceipts: base.recordPrivateApprovalReceipts?.bind(base),
      reserveOperation: base.reserveOperation.bind(base),
      settleSucceeded: base.settleSucceeded.bind(base),
      settleUnsuccessful: base.settleUnsuccessful.bind(base),
    };
    const transport: HostedEveTransport = {
      // oxlint-disable-next-line typescript/promise-function-async -- test stub
      cancel: () => Promise.resolve({ events: [], status: "waiting" }),
      // oxlint-disable-next-line typescript/promise-function-async -- test stub
      get: () => Promise.resolve({ events: [], status: "waiting" }),
      observe: async (request) => {
        const requestPlan = hostedOperatorPlanSchema.parse({
          ...plan,
          selection: { ...selection, sessionId: request.sessionId },
        });
        const requestInput = {
          ...toolInput,
          plan: requestPlan,
          planDigest: operatorPlanDigest(requestPlan),
        };
        await request.onPrivateEvent?.(inputRequested("request_spooled", undefined, requestInput));
        await request.onPrivateEvent?.(approvalSettled("request_spooled"));
        const savedDuringObservation = await store.getSession(principal, request.sessionId);
        expect(
          savedDuringObservation?.version === 2
            ? savedDuringObservation.privateApprovalReceipts?.[0]?.outcome
            : undefined,
        ).toBe("approved");
        return {
          artifactProjectionRequiresLegacyReadback: false,
          installedEventCount: 2,
          pendingRequests: [],
          publicEventCount: 0,
          status: "waiting",
        };
      },
      // oxlint-disable-next-line typescript/promise-function-async -- test stub
      respond: () => Promise.resolve({ events: [], status: "waiting" }),
      // oxlint-disable-next-line typescript/promise-function-async -- test stub
      send: () => Promise.resolve({ events: [], status: "waiting" }),
      // oxlint-disable-next-line typescript/promise-function-async -- test stub
      start: () =>
        Promise.resolve({
          adapterSessionId: "adapter_fixture",
          snapshot: { events: [], status: "waiting" },
        }),
    };
    const service = createHostedEveSessionService({ now: () => 10, principal, store, transport });
    const started = await service.start({ clientRequestId: randomUUID(), prompt: "Build an app" });
    const result = await service.get({ cursor: 0, limit: 10, sessionId: started.sessionId });
    const saved = await store.getSession(principal, started.sessionId);
    expect(saved?.version === 2 ? saved.privateApprovalReceipts?.[0]?.outcome : undefined).toBe(
      "approved",
    );
    expect(JSON.stringify(result)).not.toContain("call_fixture");
    expect(JSON.stringify(result)).not.toContain("responderPrincipalId");
  });

  it("keeps legacy v1 and v2 records without private receipts readable", async () => {
    const legacy = hostedSessionRecordSchema.parse({
      adapterSessionId: "old_adapter",
      createdAtEpochMs: 1,
      principal,
      sessionId: "old_public_session",
      status: "waiting",
      updatedAtEpochMs: 1,
      version: 1,
    });
    expect(legacy.version).toBe(1);
    const { sessionId: savedSessionId, store } = await startedStore();
    const current = await store.getSession(principal, savedSessionId);
    expect(current?.version).toBe(2);
    expect(current?.version === 2 ? current.privateApprovalReceipts : undefined).toBeUndefined();
  });

  it("reads only the matching owner, request and call, and rejects conflicting settlements", async () => {
    const { sessionId: savedSessionId, store } = await startedStore();
    const approved = receipt(savedSessionId);
    const savedSelection = { ...selection, sessionId: savedSessionId };
    await recordReceipts(store, savedSessionId, [approved]);
    expect(
      await readPrivateHostedApproval({
        action: "prepare",
        callId: approved.callId,
        planDigest: approved.toolInput.planDigest,
        principal,
        selection: savedSelection,
        sessionId: savedSessionId,
        store,
      }),
    ).toEqual(approved);
    expect(
      await readPrivateHostedApproval({
        action: "prepare",
        callId: approved.callId,
        planDigest: approved.toolInput.planDigest,
        principal: { ...principal, ownerUserId: "other" },
        selection: savedSelection,
        sessionId: savedSessionId,
        store,
      }),
    ).toBeNull();
    await expect(
      recordReceipts(store, savedSessionId, [receipt(savedSessionId, "cancelled")]),
    ).rejects.toThrow("conflicts with its saved terminal outcome");
  });

  it("rejects ambiguous owner-scoped matches when Eve reused a call ID", async () => {
    const { sessionId: savedSessionId, store } = await startedStore();
    const first = receipt(savedSessionId);
    const second = { ...first, requestId: "request_second", sequence: first.sequence + 2 };
    await recordReceipts(store, savedSessionId, [first, second]);
    await expect(
      readPrivateHostedApproval({
        action: "prepare",
        callId: first.callId,
        planDigest: first.toolInput.planDigest,
        principal,
        selection: { ...selection, sessionId: savedSessionId },
        sessionId: savedSessionId,
        store,
      }),
    ).rejects.toThrow("matched more than one Eve request");
    await expect(
      readPrivateHostedApproval({
        action: "prepare",
        callId: first.callId,
        planDigest: first.toolInput.planDigest,
        principal,
        requestId: second.requestId,
        selection: { ...selection, sessionId: savedSessionId },
        sessionId: savedSessionId,
        store,
      }),
    ).resolves.toEqual(second);
  });
});

describe("private approval delta checkpoints", () => {
  it("hydrates an earlier pending request and produces the exact later approval receipt", () => {
    const full = createPrivateHostedApprovalCapture(sessionId);
    full.observe(inputRequested("split-request"));
    const snapshot = full.snapshot();
    const saved = serializePrivateHostedApprovalCaptureState(snapshot);
    const resumed = createPrivateHostedApprovalCapture(
      sessionId,
      hydratePrivateHostedApprovalCaptureState(sessionId, saved),
    );
    resumed.observe(approvalSettled("split-request"));
    full.observe(approvalSettled("split-request"));
    expect(resumed.values()).toEqual(full.values());
    expect(resumed.snapshot().pendingRequests).toEqual([]);
    expect(resumed.snapshot().receipts).toEqual(full.values());
    expect(() => hydratePrivateHostedApprovalCaptureState("foreign-session", saved)).toThrow(
      "another session",
    );
  });
  it("validates malformed, duplicate and changed scope without trusting or sharing checkpoint objects", () => {
    const capture = createPrivateHostedApprovalCapture(sessionId);
    capture.observe(inputRequested("split-request"));
    const snapshot = capture.snapshot();
    const [request] = snapshot.pendingRequests;
    expect(() =>
      hydratePrivateHostedApprovalCaptureState(sessionId, {
        ...snapshot,
        pendingRequests: [request, request],
      }),
    ).toThrow();
    expect(() =>
      hydratePrivateHostedApprovalCaptureState(sessionId, {
        ...snapshot,
        pendingRequests: [
          { ...request, toolInput: { ...request.toolInput, planDigest: "f".repeat(64) } },
        ],
      }),
    ).toThrow();
    expect(() =>
      hydratePrivateHostedApprovalCaptureState(sessionId, {
        ...snapshot,
        pendingRequests: [
          { ...request, toolInput: { ...request.toolInput, appId: "foreign-app" } },
        ],
      }),
    ).toThrow();
    request.toolInput.appId = "changed-snapshot";
    expect(capture.snapshot().pendingRequests[0]?.toolInput.appId).toBe(selection.appId);
    expect(() => {
      capture.hydrate({
        ...capture.snapshot(),
        pendingRequests: [{ ...capture.snapshot().pendingRequests[0], callId: "different-call" }],
      });
    }).toThrow("Conflicting private pending");
    expect(capture.snapshot().pendingRequests[0]?.callId).toBe("call_fixture");
  });
  it("persists later delta approvals through the real owner store and revalidates hydrated receipts", async () => {
    const { sessionId: savedSessionId, store } = await startedStore();
    const original = createPrivateHostedApprovalRecorder({
      principal,
      sessionId: savedSessionId,
      store,
    });
    await original.observe(
      inputRequested(
        "delta-store-request",
        "prepare-app-hosted-runtime",
        receipt(savedSessionId).toolInput,
      ),
    );
    expect(original.values()).toEqual([]);
    const state = hydratePrivateHostedApprovalCaptureState(
      savedSessionId,
      serializePrivateHostedApprovalCaptureState(original.snapshot()),
    );
    const resumed = createPrivateHostedApprovalRecorder({
      principal,
      sessionId: savedSessionId,
      state,
      store,
    });
    await resumed.observe(approvalSettled("delta-store-request"));
    const saved = await store.getSession(principal, savedSessionId);
    expect(saved?.version === 2 ? saved.privateApprovalReceipts : undefined).toEqual(
      resumed.values(),
    );
    const foreign = createPrivateHostedApprovalRecorder({
      principal: { ...principal, ownerUserId: "foreign-owner" },
      sessionId: savedSessionId,
      state: resumed.snapshot(),
      store,
    });
    await expect(foreign.observe(approvalSettled("unrelated-delta"))).rejects.toThrow();
    const current = createPrivateHostedApprovalRecorder({
      principal,
      sessionId: savedSessionId,
      state: resumed.snapshot(),
      store,
    });
    await current.observe(approvalSettled("unrelated-delta"));
    expect(current.values()).toEqual(resumed.values());
  });
});
