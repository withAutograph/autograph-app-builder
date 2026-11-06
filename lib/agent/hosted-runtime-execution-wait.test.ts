import { continueHostedRuntimeExecutionObservation } from "./hosted-runtime-execution-wait";
import type { HostedRuntimeExecutionWaitPorts } from "./hosted-runtime-execution-wait";
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
} from "./hosted-runtime-execution-observation-step";
import { waitForHostedRuntimeApprovalReceipt } from "./hosted-runtime-approval-wait";

const fixture = () => {
  const selection = {
    appId: "reports",
    branch: "review",
    environment: "preview" as const,
    projectId: "project-reports",
    sessionId: "session-reports",
  };
  const plan = hostedOperatorPlanSchema.parse({
    access: [],
    action: "prepare",
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
    contextId: "context",
    cost: { class: "shared-recovery-group", description: "fixture", owner: "fixture" },
    effects: [
      { description: "Resources", id: "resources", kind: "resources" },
      { description: "Install", id: "install", kind: "install" },
      { description: "Access", id: "access", kind: "access" },
      { description: "Bind", id: "bindings", kind: "bindings" },
    ],
    installer: { reference: "installer", sha256: "a".repeat(64) },
    neon: {
      branchId: "branch",
      connectionRef: "connection",
      endpoint: "ep-fixture.neon.tech",
      projectId: "neon",
      source: "synthetic-only",
    },
    release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00Z", policy: "retain" },
    selection,
    version: 1,
  });
  const approved = {
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    operationRef: "801583e6-b763-46eb-b9ca-9ac5a13733c4",
    plan,
    planDigest: operatorPlanDigest(plan),
    projectId: selection.projectId,
  };
  const principal = {
    audience: "https://builder.example/mcp",
    issuer: "https://builder.example/api/auth",
    ownerUserId: "owner",
    scopes: ["autograph:session"],
    workspaceId: "workspace",
  };
  const ownerContext = operatorOwnerContextSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    authority: {
      audience: principal.audience,
      issuer: principal.issuer,
      ownerUserId: principal.ownerUserId,
      workspaceId: principal.workspaceId,
    },
    kind: "direct",
    principal,
    sessionId: selection.sessionId,
  });
  const receipt = privateHostedApprovalReceiptSchema.parse({
    callId: "human-call",
    format: "autograph-hosted-approval-v1",
    outcome: "approved",
    requestId: "human-request",
    responderPrincipalId: principal.ownerUserId,
    sequence: 1,
    toolInput: approved,
    toolName: "prepare-app-hosted-runtime",
    turnId: "turn",
  });
  const session = durableHostedSessionRecordSchema.parse({
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    cancellationRevision: 3,
    createdAtEpochMs: 1,
    lastProgressAtEpochMs: 1,
    originAdapterSessionId: "adapter",
    principal,
    privateApprovalReceipts: [receipt],
    resumability: "live",
    resumedCancellationRevision: 3,
    sessionId: selection.sessionId,
    stage: "planning",
    status: "working",
    title: "Reports",
    updatedAtEpochMs: 1,
    version: 2,
  });
  const abort = new AbortController();
  const context: WorkflowToolContext = {
    abortSignal: abort.signal,
    agent: async () => {
      throw new Error("No agent call");
    },
    agents: {},
    ask: async () => {
      throw new Error("No human continuation");
    },
    callId: "original-tool-call",
    getToken: async () => {
      throw new Error("No provider grant");
    },
    requireAuth: () => {
      throw new Error("No provider grant");
    },
    session: {
      auth: { current: null, initiator: null },
      id: "adapter",
      turn: { id: "turn", sequence: 1 },
    },
    toolName: "prepare-app-hosted-runtime",
  };
  const snapshot = {
    adapterGeneration: 1,
    adapterSessionId: "adapter",
    callId: context.callId,
    cancellationRevision: 3,
    operationRef: approved.operationRef,
    planDigest: approved.planDigest,
    sessionId: selection.sessionId,
  };
  const store = { getSession: async () => session };
  const calls: string[] = [];
  let observed: OperatorPublicResult = {
    appId: approved.appId,
    authenticatedBehavior: "unassessed",
    execution: { state: "running" },
    operationRef: approved.operationRef,
    planDigest: approved.planDigest,
    status: "pending",
  };
  const operator = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: async (_url, init) => {
      const body = operatorRequestSchema.parse(JSON.parse(z.string().parse(init?.body)));
      calls.push(body.action);
      if (body.action === "execute") {
        throw new TypeError("synthetic lost transport");
      }
      return Response.json(observed);
    },
    ownerContext,
    sessionId: selection.sessionId,
    token: async () => "synthetic-private",
  });
  const contract = {
    createResourceMismatch: () => new HostedOperatorError("resource_mismatch"),
    digest: operatorPlanDigest,
    isOperatorError: (error: unknown): error is HostedOperatorError =>
      error instanceof HostedOperatorError,
    isTransportUnknown: isHostedOperatorTransportUnknown,
    sameSelection: sameOperatorSelection,
  };
  const retain = vi.fn<(selection: PreparedRuntimeSelection) => void>();
  const prepare = vi.fn(
    async () =>
      await prepareHostedRuntimeWithOperator(approved, context, operator, retain, contract),
  );
  const read = createHostedRuntimeExecutionObserver({
    assertAuthority: async (_input, ctx, expected) => {
      await assertHostedRuntimeExecutionObservationAuthority({
        approved,
        context: ctx,
        operator,
        snapshot: expected,
        store,
      });
    },
    isTransportUnknown: isHostedOperatorTransportUnknown,
    now: () => 1000,
    prepareObserved: async (_input, ctx, result) =>
      await prepareHostedRuntimeWithOperator(approved, ctx, operator, retain, contract, result),
    readStatus: async () =>
      await operator.request(
        { action: "status", operationRef: approved.operationRef, selection },
        abort.signal,
      ),
  });
  return {
    abort,
    approved,
    calls,
    context,
    get observed() {
      return observed;
    },
    operator,
    prepare,
    read,
    retain,
    session,
    setObserved: (next: OperatorPublicResult) => {
      observed = next;
    },
    snapshot,
    store,
  };
};

describe("automatic observation of one approved execution", () => {
  it("calls observation steps and sleep without serializing a function-bearing ports receiver", async () => {
    const f = fixture();
    const readReceivers: boolean[] = [];
    const sleepReceivers: boolean[] = [];
    const ports: HostedRuntimeExecutionWaitPorts = {
      read: async function read(this: undefined, input, ctx, snapshot, delayMs) {
        readReceivers.push(this === undefined);
        expect(snapshot).toBe(f.snapshot);
        return await f.read(input, ctx, snapshot, delayMs);
      },
      sleepUntil: async function sleepUntil(this: undefined) {
        sleepReceivers.push(this === undefined);
        f.setObserved({
          ...f.observed,
          execution: { outcome: { status: "prepared" }, state: "settled" },
          status: "prepared",
        });
        return;
      },
      snapshot: f.snapshot,
    };
    const prepared = await f.prepare();
    const generator = continueHostedRuntimeExecutionObservation(
      f.approved,
      f.context,
      prepared,
      ports,
    );
    expect(await generator.next()).toMatchObject({ done: false, value: { status: "pending" } });
    expect(await generator.next()).toMatchObject({
      done: true,
      value: { result: { status: "prepared" } },
    });
    expect(readReceivers).toEqual([true, true]);
    expect(sleepReceivers).toEqual([true]);
    expect(f.calls).toEqual(["execute", "status", "status"]);
  });
  it("maps the observed settled planned outcome to ordinary planning without replaying execute", async () => {
    const f = fixture();
    const prepared = await f.prepare();
    f.setObserved({
      ...f.observed,
      execution: { outcome: { status: "planned" }, state: "settled" },
      status: "pending",
    });
    const sleepUntil = vi.fn<(deadline: Date) => Promise<void>>(async () => {});
    const generator = continueHostedRuntimeExecutionObservation(f.approved, f.context, prepared, {
      read: f.read,
      sleepUntil,
      snapshot: f.snapshot,
    });
    expect(await generator.next()).toMatchObject({ done: false, value: { status: "pending" } });
    expect(await generator.next()).toMatchObject({
      done: true,
      value: {
        identityInput: null,
        result: {
          nextAction: {
            approval: "normal-plan-approval",
            input: {
              appId: f.approved.appId,
              branch: f.approved.branch,
              environment: f.approved.environment,
              operation: "prepare",
              projectId: f.approved.projectId,
            },
            tool: "plan-app-hosted-runtime",
          },
          operationRef: f.approved.operationRef,
          planDigest: f.approved.planDigest,
          status: "planned",
        },
      },
    });
    expect(f.calls).toEqual(["execute", "status"]);
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(sleepUntil).not.toHaveBeenCalled();
  });
  it.each(["prepared", "reconciliation_required"] as const)(
    "keeps waiting after lost transport and returns actual %s without another execute/plan",
    async (outcome) => {
      const f = fixture();
      let sleeps = 0;
      const generator = continueHostedRuntimeOwnerPreparation(f.approved, f.context, f.prepare, {
        acknowledge: async () => {
          throw new Error("No identity");
        },
        createHook: () => {
          throw new Error("No identity hook");
        },
        execution: {
          read: f.read,
          sleepUntil: async () => {
            sleeps += 1;
            const status = outcome === "prepared" ? "prepared" : "blocked";
            f.setObserved({
              ...f.observed,
              status,
              ...(outcome === "prepared" ? {} : { code: outcome }),
              execution: {
                outcome: { status, ...(outcome === "prepared" ? {} : { code: outcome }) },
                state: "settled",
              },
            });
            return;
          },
          snapshot: f.snapshot,
        },
        register: async () => {
          throw new Error("No identity");
        },
        sleepUntil: async () => {},
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
  it.each([undefined, 2])(
    "rejects an unacknowledged Stop when resumed cancellation revision is %s",
    async (resumedCancellationRevision) => {
      const f = fixture();
      if (resumedCancellationRevision === undefined) {
        delete f.session.resumedCancellationRevision;
      } else {
        f.session.resumedCancellationRevision = resumedCancellationRevision;
      }
      await expect(f.read(f.approved, f.context, f.snapshot, 1000)).rejects.toMatchObject({
        code: "authorization_required",
      });
      expect(f.calls).toEqual([]);
      expect(f.retain).not.toHaveBeenCalled();
    },
  );
  it("does not publish a recovered result or selection when cancellation changes during materialization", async () => {
    const f = fixture();
    const publish = vi.fn<() => void>();
    const read = createHostedRuntimeExecutionObserver({
      assertAuthority: async (_input, ctx, expected) => {
        await assertHostedRuntimeExecutionObservationAuthority({
          approved: f.approved,
          context: ctx,
          operator: f.operator,
          snapshot: expected,
          store: f.store,
        });
      },
      commitObserved: publish,
      isTransportUnknown: isHostedOperatorTransportUnknown,
      now: () => 1000,
      prepareObserved: async () => {
        f.session.cancellationRevision = 4;
        return {
          identityInput: null,
          result: { ...f.observed, status: "prepared" },
        };
      },
      readStatus: async () => ({
        ...f.observed,
        execution: { outcome: { status: "prepared" }, state: "settled" },
        status: "prepared",
      }),
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
        execution: {
          outcome: { code: "reconciliation_required", status: "blocked" },
          state: "settled",
        },
        status: "prepared",
      }),
    ).toThrow();
  });
  it("keeps a transient STATUS transport failure pending under the original authority", async () => {
    const f = fixture();
    let reads = 0;
    const read = createHostedRuntimeExecutionObserver({
      assertAuthority: async (_input, ctx, snapshot) => {
        await assertHostedRuntimeExecutionObservationAuthority({
          approved: f.approved,
          context: ctx,
          operator: f.operator,
          snapshot,
          store: f.store,
        });
      },
      isTransportUnknown: isHostedOperatorTransportUnknown,
      now: () => 1000,
      prepareObserved: async () => {
        throw new Error("No terminal evidence");
      },
      readStatus: async () => {
        reads += 1;
        throw new HostedOperatorTransportUnknown(new TypeError("lost STATUS transport"));
      },
    });
    expect(await read(f.approved, f.context, f.snapshot, 1000)).toEqual({
      checkAfter: new Date(2000).toISOString(),
      status: "waiting",
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
        execution: undefined,
        status: "prepared",
      }),
    ).toBe(true);
  });
  it("returns the original approval-wait snapshot for observation while existing ignored-return callers remain valid", async () => {
    const f = fixture();
    const result = await waitForHostedRuntimeApprovalReceipt(f.approved, f.context, {
      read: async () => ({ snapshot: f.snapshot, status: "approved" }),
      sleepUntil: async () => {
        throw new Error("No wait");
      },
    });
    expect(result.snapshot).toBe(f.snapshot);
  });
});
