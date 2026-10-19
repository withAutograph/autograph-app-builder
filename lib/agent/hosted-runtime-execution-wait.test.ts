import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";
import type { WorkflowToolContext } from "eve/tools";
import {
  hostedOperatorPlanSchema,
  operatorPlanDigest,
  operatorRequestSchema,
  HostedOperatorError,
  operatorOwnerContextSchema,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { OperatorPublicResult } from "../provisioning/hosted-operator-contract";
import {
  createHostedOperatorClient,
  HostedOperatorTransportUnknown,
  isHostedOperatorTransportUnknown,
} from "../provisioning/hosted-operator-client";
import { durableHostedSessionRecordSchema } from "../eve/hosted-store";
import { privateHostedApprovalReceiptSchema } from "../eve/private-hosted-approval";
import { prepareHostedRuntimeWithOperator } from "./prepare-app-hosted-runtime-step";
import { continueHostedRuntimeOwnerPreparation } from "./hosted-runtime-identity-wait";
import {
  assertHostedRuntimeExecutionObservationAuthority,
  createHostedRuntimeExecutionObserver,
  observedHostedRuntimeExecutionIsSettled,
} from "./hosted-runtime-execution-wait";
import { waitForHostedRuntimeApprovalReceipt } from "./hosted-runtime-approval-wait";

const fixture = () => {
  const selection = {
    appId: "reports",
    branch: "review",
    projectId: "project-reports",
    sessionId: "session-reports",
    environment: "preview" as const,
  };
  const plan = hostedOperatorPlanSchema.parse({
    version: 1,
    action: "prepare",
    selection,
    contextId: "context",
    appDatabase: {
      database: "reports",
      migratorRole: "reports_owner",
      resourceId: "reports",
      runtimeRole: "reports_reader",
    },
    authDatabase: {
      database: "identity",
      migratorRole: "identity_owner",
      resourceId: "identity",
      runtimeRole: "identity_reader",
    },
    access: [],
    cost: { class: "shared-recovery-group", description: "fixture", owner: "fixture" },
    effects: [
      { id: "resources", kind: "resources", description: "Resources" },
      { id: "install", kind: "install", description: "Install" },
      { id: "access", kind: "access", description: "Access" },
      { id: "bindings", kind: "bindings", description: "Bind" },
    ],
    installer: { reference: "installer", sha256: "a".repeat(64) },
    neon: {
      projectId: "neon",
      branchId: "branch",
      endpoint: "ep-fixture.neon.tech",
      connectionRef: "connection",
      source: "synthetic-only",
    },
    release: { id: "release", artifactRef: "artifact", sha256: "b".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "retain" },
  });
  const approved = {
    appId: selection.appId,
    branch: selection.branch,
    projectId: selection.projectId,
    environment: selection.environment,
    operationRef: "801583e6-b763-46eb-b9ca-9ac5a13733c4",
    plan,
    planDigest: operatorPlanDigest(plan),
  };
  const principal = {
    issuer: "https://builder.example/api/auth",
    audience: "https://builder.example/mcp",
    ownerUserId: "owner",
    workspaceId: "workspace",
    scopes: ["autograph:session"],
  };
  const ownerContext = operatorOwnerContextSchema.parse({
    kind: "direct",
    sessionId: selection.sessionId,
    adapterSessionId: "adapter",
    adapterGeneration: 1,
    authority: {
      issuer: principal.issuer,
      audience: principal.audience,
      workspaceId: principal.workspaceId,
      ownerUserId: principal.ownerUserId,
    },
    principal,
  });
  const receipt = privateHostedApprovalReceiptSchema.parse({
    format: "autograph-hosted-approval-v1",
    callId: "human-call",
    requestId: "human-request",
    outcome: "approved",
    responderPrincipalId: principal.ownerUserId,
    sequence: 1,
    toolName: "prepare-app-hosted-runtime",
    toolInput: approved,
    turnId: "turn",
  });
  const session = durableHostedSessionRecordSchema.parse({
    version: 2,
    sessionId: selection.sessionId,
    adapterSessionId: "adapter",
    adapterGeneration: 1,
    originAdapterSessionId: "adapter",
    cancellationRevision: 3,
    principal,
    createdAtEpochMs: 1,
    lastProgressAtEpochMs: 1,
    updatedAtEpochMs: 1,
    resumability: "live",
    stage: "planning",
    status: "working",
    title: "Reports",
    privateApprovalReceipts: [receipt],
  });
  const abort = new AbortController();
  const context: WorkflowToolContext = {
    callId: "original-tool-call",
    toolName: "prepare-app-hosted-runtime",
    abortSignal: abort.signal,
    ask: () => Promise.reject(new Error("No human continuation")),
    agents: {},
    agent: () => Promise.reject(new Error("No agent call")),
    getToken: () => Promise.reject(new Error("No provider grant")),
    requireAuth: () => {
      throw new Error("No provider grant");
    },
    session: {
      id: "adapter",
      auth: { current: null, initiator: null },
      turn: { id: "turn", sequence: 1 },
    },
  };
  const snapshot = {
    sessionId: selection.sessionId,
    adapterSessionId: "adapter",
    adapterGeneration: 1,
    cancellationRevision: 3,
    callId: context.callId,
    operationRef: approved.operationRef,
    planDigest: approved.planDigest,
  };
  const store = { getSession: () => Promise.resolve(session) };
  const calls: string[] = [];
  let observed: OperatorPublicResult = {
    appId: approved.appId,
    authenticatedBehavior: "unassessed",
    operationRef: approved.operationRef,
    planDigest: approved.planDigest,
    status: "pending",
    execution: { state: "running" },
  };
  const operator = createHostedOperatorClient({
    endpoint: "https://operator.example",
    ownerContext,
    sessionId: selection.sessionId,
    token: () => Promise.resolve("synthetic-private"),
    fetch: (_url, init) => {
      const body = operatorRequestSchema.parse(JSON.parse(z.string().parse(init?.body)));
      calls.push(body.action);
      if (body.action === "execute") {
        return Promise.reject(new TypeError("synthetic lost transport"));
      }
      return Promise.resolve(Response.json(observed));
    },
  });
  const contract = {
    createResourceMismatch: () => new HostedOperatorError("resource_mismatch"),
    digest: operatorPlanDigest,
    isOperatorError: (error: unknown): error is HostedOperatorError =>
      error instanceof HostedOperatorError,
    sameSelection: sameOperatorSelection,
    isTransportUnknown: isHostedOperatorTransportUnknown,
  };
  const retain = vi.fn<(selection: PreparedRuntimeSelection) => void>();
  const prepare = vi.fn(
    async () =>
      await prepareHostedRuntimeWithOperator(approved, context, operator, retain, contract),
  );
  const read = createHostedRuntimeExecutionObserver({
    now: () => 1000,
    isTransportUnknown: isHostedOperatorTransportUnknown,
    assertAuthority: async (_input, ctx, expected) => {
      await assertHostedRuntimeExecutionObservationAuthority({
        approved,
        context: ctx,
        operator,
        snapshot: expected,
        store,
      });
    },
    readStatus: async () =>
      await operator.request(
        { action: "status", operationRef: approved.operationRef, selection },
        abort.signal,
      ),
    prepareObserved: async (_input, ctx, result) =>
      await prepareHostedRuntimeWithOperator(approved, ctx, operator, retain, contract, result),
  });
  return {
    approved,
    context,
    snapshot,
    session,
    abort,
    operator,
    read,
    prepare,
    calls,
    setObserved: (next: OperatorPublicResult) => {
      observed = next;
    },
    get observed() {
      return observed;
    },
    store,
  };
};

describe("automatic observation of one approved execution", () => {
  it.each(["prepared", "reconciliation_required"] as const)(
    "keeps waiting after lost transport and returns actual %s without another execute/plan",
    async (outcome) => {
      const f = fixture();
      let sleeps = 0;
      const generator = continueHostedRuntimeOwnerPreparation(f.approved, f.context, f.prepare, {
        createHook: () => {
          throw new Error("No identity hook");
        },
        register: () => Promise.reject(new Error("No identity")),
        acknowledge: () => Promise.reject(new Error("No identity")),
        sleepUntil: () => Promise.resolve(),
        execution: {
          snapshot: f.snapshot,
          read: f.read,
          sleepUntil: () => {
            sleeps += 1;
            const status = outcome === "prepared" ? "prepared" : "blocked";
            f.setObserved({
              ...f.observed,
              status,
              ...(outcome === "prepared" ? {} : { code: outcome }),
              execution: {
                state: "settled",
                outcome: { status, ...(outcome === "prepared" ? {} : { code: outcome }) },
              },
            });
            return Promise.resolve();
          },
        },
      });
      expect(await generator.next()).toMatchObject({ done: false, value: { status: "pending" } });
      expect(await generator.next()).toMatchObject({
        done: true,
        value: { status: outcome === "prepared" ? "prepared" : "blocked" },
      });
      expect(sleeps).toBe(1);
      expect(f.calls).toEqual(["execute", "status", "status"]);
      expect(f.prepare).toHaveBeenCalledOnce();
    },
  );
  it.each(["cancellation", "owner", "approval", "adapter", "session-cancelled"] as const)(
    "rejects changed %s without taking a new snapshot or dispatching work",
    async (change) => {
      const f = fixture();
      if (change === "cancellation") {
        f.session.cancellationRevision = 4;
      }
      if (change === "owner") {
        f.session.principal.ownerUserId = "foreign";
      }
      if (change === "approval") {
        f.session.privateApprovalReceipts = [];
      }
      if (change === "adapter") {
        f.session.adapterGeneration = 2;
      }
      if (change === "session-cancelled") {
        f.session.status = "cancelled";
      }
      await expect(f.read(f.approved, f.context, f.snapshot, 1000)).rejects.toMatchObject({
        code: "authorization_required",
      });
      expect(f.calls).toEqual([]);
    },
  );
  it("does not publish a recovered result or selection when cancellation changes during materialization", async () => {
    const f = fixture();
    const publish = vi.fn<() => void>();
    const read = createHostedRuntimeExecutionObserver({
      now: () => 1000,
      isTransportUnknown: isHostedOperatorTransportUnknown,
      assertAuthority: async (_input, ctx, expected) => {
        await assertHostedRuntimeExecutionObservationAuthority({
          approved: f.approved,
          context: ctx,
          operator: f.operator,
          snapshot: expected,
          store: f.store,
        });
      },
      readStatus: () =>
        Promise.resolve({
          ...f.observed,
          status: "prepared",
          execution: { state: "settled", outcome: { status: "prepared" } },
        }),
      prepareObserved: () => {
        f.session.cancellationRevision = 4;
        return Promise.resolve({
          identityInput: null,
          result: { ...f.observed, status: "prepared" },
        });
      },
      commitObserved: publish,
    });
    await expect(read(f.approved, f.context, f.snapshot, 1000)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(publish).not.toHaveBeenCalled();
  });
  it("stops explicit session cancellation and never dispatches a retry", async () => {
    const f = fixture();
    f.abort.abort();
    await expect(f.prepare()).rejects.toThrow();
    expect(f.calls).toEqual([]);
  });
  it.each([undefined, { state: "unknown" as const }])(
    "keeps absent/unknown evidence pending (%j)",
    async (execution) => {
      const f = fixture();
      f.setObserved({ ...f.observed, execution });
      expect(await f.read(f.approved, f.context, f.snapshot, 1000)).toMatchObject({
        status: "waiting",
      });
      expect(f.calls).toEqual(["status"]);
    },
  );
  it("rejects a drifted operation/digest and contradictory settled result", () => {
    const f = fixture();
    expect(() =>
      observedHostedRuntimeExecutionIsSettled(f.approved, {
        ...f.observed,
        planDigest: "f".repeat(64),
      }),
    ).toThrow();
    expect(() =>
      observedHostedRuntimeExecutionIsSettled(f.approved, {
        ...f.observed,
        status: "prepared",
        execution: {
          state: "settled",
          outcome: { status: "blocked", code: "reconciliation_required" },
        },
      }),
    ).toThrow();
  });
  it("keeps a transient STATUS transport failure pending under the original authority", async () => {
    const f = fixture();
    let reads = 0;
    const read = createHostedRuntimeExecutionObserver({
      now: () => 1000,
      isTransportUnknown: isHostedOperatorTransportUnknown,
      assertAuthority: async (_input, ctx, snapshot) => {
        await assertHostedRuntimeExecutionObservationAuthority({
          approved: f.approved,
          context: ctx,
          operator: f.operator,
          snapshot,
          store: f.store,
        });
      },
      readStatus: () => {
        reads += 1;
        return Promise.reject(
          new HostedOperatorTransportUnknown(new TypeError("lost STATUS transport")),
        );
      },
      prepareObserved: () => Promise.reject(new Error("No terminal evidence")),
    });
    expect(await read(f.approved, f.context, f.snapshot, 1000)).toEqual({
      status: "waiting",
      checkAfter: new Date(2000).toISOString(),
    });
    expect(reads).toBe(1);
    expect(f.calls).toEqual([]);
  });
  it("accepts a legacy terminal STATUS reply and leaves legacy pending evidence unresolved", () => {
    const f = fixture();
    expect(
      observedHostedRuntimeExecutionIsSettled(f.approved, { ...f.observed, execution: undefined }),
    ).toBe(false);
    expect(
      observedHostedRuntimeExecutionIsSettled(f.approved, {
        ...f.observed,
        status: "prepared",
        execution: undefined,
      }),
    ).toBe(true);
  });
  it("returns the original approval-wait snapshot for observation while existing ignored-return callers remain valid", async () => {
    const f = fixture();
    const result = await waitForHostedRuntimeApprovalReceipt(f.approved, f.context, {
      read: () => Promise.resolve({ status: "approved", snapshot: f.snapshot }),
      sleepUntil: () => Promise.reject(new Error("No wait")),
    });
    expect(result.snapshot).toBe(f.snapshot);
  });
});
