import { randomUUID } from "node:crypto";
import type { ApprovalContext } from "eve/tools/approval";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";

import { evaluateHostedRuntimePreparationApproval } from "../../agent/tools/prepare-app-hosted-runtime";
import { nativeObservationStateSchema } from "../eve/native-observation-state";
import { createPrivateHostedApprovalRecorder } from "../eve/private-hosted-approval";
import type { HostedEveStore } from "../eve/hosted-store";
import { InMemoryHostedEveStore, toDurableHostedSessionRecord } from "../eve/hosted-store";
import { createHostedEveSessionService } from "../eve/hosted-service";
import type { HostedEveTransport } from "../eve/hosted-service";
import type { HostedPrincipal } from "../eve/hosted-auth";
import { createHostedOperatorClient } from "../provisioning/hosted-operator-client";
import {
  HostedOperatorError,
  hostedOperatorPlanSchema,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  operatorRequestSchema,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";
import { prepareHostedRuntimeWithOperator } from "./prepare-app-hosted-runtime-step";
import {
  captureHostedRuntimeApproval,
  createHostedRuntimeExecutionApprovalReader,
  createHostedRuntimePriorApprovalReader,
} from "./hosted-runtime-prior-approval";

const principal: HostedPrincipal = {
  audience: "https://builder.example/mcp",
  issuer: "https://builder.example/api/auth",
  ownerUserId: "owner",
  scopes: ["autograph:start", "autograph:get", "autograph:send", "autograph:respond"],
  workspaceId: "workspace",
};
const fixture = async () => {
  const store = new InMemoryHostedEveStore();
  const snapshot = { events: [], status: "waiting" as const };
  const transport: HostedEveTransport = {
    cancel: async () => await Promise.resolve(snapshot),
    get: async () => await Promise.resolve(snapshot),
    respond: async () => await Promise.resolve(snapshot),
    send: async () => await Promise.resolve(snapshot),
    start: async () => await Promise.resolve({ adapterSessionId: "owned-adapter", snapshot }),
  };
  const service = createHostedEveSessionService({ principal, store, transport, now: () => 10 });
  const started = await service.start({ clientRequestId: randomUUID(), prompt: "Build an app" });
  const saved = await store.getSession(principal, started.sessionId);
  if (saved?.version !== 2) {
    throw new Error("Missing owned fixture session");
  }
  const selection = {
    appId: "spend-review",
    branch: "preview",
    environment: "preview" as const,
    projectId: "prj_fixture",
    sessionId: saved.sessionId,
  };
  const plan = hostedOperatorPlanSchema.parse({
    action: "prepare",
    access: [],
    contextId: "context",
    version: 1,
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
    cost: { class: "shared-recovery-group", description: "fixture", owner: "owner" },
    effects: [
      { id: "resources", kind: "resources", description: "Verify resources" },
      { id: "install", kind: "install", description: "Install release" },
      { id: "access", kind: "access", description: "Grant access" },
      { id: "bindings", kind: "bindings", description: "Bind runtime" },
    ],
    installer: { reference: "installer", sha256: "a".repeat(64) },
    neon: {
      branchId: "br_fixture",
      connectionRef: "owner-connection",
      endpoint: "ep-fixture.us-east-1.aws.neon.tech",
      projectId: "neon-project",
      source: "synthetic-only",
    },
    publicGateway: {
      branch: selection.branch,
      origin: "https://preview.example",
      projectId: selection.projectId,
    },
    release: { artifactRef: "artifact", id: "release", sha256: "b".repeat(64) },
    retention: { expiresAt: "2027-01-01T00:00:00.000Z", policy: "retain" },
    selection,
  });
  const input = {
    appId: selection.appId,
    branch: selection.branch,
    environment: selection.environment,
    operationRef: randomUUID(),
    plan,
    planDigest: operatorPlanDigest(plan),
    projectId: selection.projectId,
  };
  const ownerContext = operatorOwnerContextSchema.parse({
    adapterGeneration: saved.adapterGeneration,
    adapterSessionId: saved.adapterSessionId,
    authority: {
      audience: principal.audience,
      issuer: principal.issuer,
      ownerUserId: principal.ownerUserId,
      workspaceId: principal.workspaceId,
    },
    kind: "direct",
    principal,
    sessionId: saved.sessionId,
  });
  const requests: ReturnType<typeof operatorRequestSchema.parse>[] = [];
  let statusAvailable = true;
  let currentDigest = input.planDigest;
  let recovery: string | null = null;
  let recoveryStatusCount = 0;
  const http: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    const body: unknown = await request.json();
    const parsed = operatorRequestSchema.parse(body);
    requests.push(parsed);
    if (!statusAvailable) {
      throw new Error("Private technical outage");
    }
    if (recovery !== null) {
      if (parsed.action === "status") {
        recoveryStatusCount += 1;
        if (recoveryStatusCount === 1 || recovery === "status") {
          return Response.json({
            appId: input.appId,
            authenticatedBehavior: "unassessed",
            status: "blocked",
            code: "resource_mismatch",
          });
        }
      }
      if (parsed.action === "plan") {
        if (recovery === "denied") {
          return Response.json({
            appId: input.appId,
            authenticatedBehavior: "unassessed",
            status: "blocked",
            code: "authorization_required",
          });
        }
        return Response.json({
          appId: input.appId,
          authenticatedBehavior: "unassessed",
          status: "planned",
          operationRef: recovery === "operation" ? randomUUID() : input.operationRef,
          planDigest: recovery === "digest" ? "d".repeat(64) : input.planDigest,
          plan: input.plan,
        });
      }
    }
    return Response.json({
      appId: input.appId,
      authenticatedBehavior: "unassessed",
      operationRef: input.operationRef,
      planDigest: currentDigest,
      status: "pending",
    });
  };
  const operator = createHostedOperatorClient({
    endpoint: "https://operator.example",
    fetch: http,
    ownerContext,
    token: async () => await Promise.resolve("fixture-only"),
    sessionId: saved.sessionId,
  });
  const context: ApprovalContext<HostedRuntimeApprovalEnvelope> = {
    callId: "retry-call",
    abortSignal: new AbortController().signal,
    approvedTools: new Set(),
    toolInput: input,
    toolName: "prepare-app-hosted-runtime",
    session: {
      id: saved.adapterSessionId,
      auth: { current: null, initiator: null },
      turn: { id: "retry-turn", sequence: 1 },
    },
    getSandbox: async () => await Promise.reject(new Error("No Sandbox in approval fixture")),
  };
  const reader = createHostedRuntimePriorApprovalReader({
    store,
    now: () => Date.parse("2026-10-14T12:00:00Z"),
  });
  const read = async (
    requested: HostedRuntimeApprovalEnvelope,
    ctx: Parameters<typeof reader>[1],
  ) => await reader(requested, ctx, operator);
  const recorder = createPrivateHostedApprovalRecorder({
    principal,
    sessionId: saved.sessionId,
    store,
  });
  const approve = async (
    options: {
      outcome?: "approved" | "cancelled";
      persist?: boolean;
      callId?: string;
      requestId?: string;
      sequence?: number;
      responderPrincipalId?: string;
    } = {},
  ) => {
    const requestId = options.requestId ?? "original-request";
    const sequence = options.sequence ?? 4;
    const requested: MessageStreamEvent = {
      type: "input.requested",
      meta: { at: "2026-10-14T12:00:00Z", id: `requested-${requestId}` },
      data: {
        sequence,
        turnId: "original-turn",
        stepIndex: 0,
        requests: [
          {
            action: {
              callId: options.callId ?? "original-call",
              input,
              kind: "tool-call",
              toolName: "prepare-app-hosted-runtime",
            },
            kind: "tool-approval",
            prompt: "Approve preparation",
            requestId,
          },
        ],
      },
    };
    const settled: MessageStreamEvent = {
      type: "approval.settled",
      meta: { at: "2026-10-14T12:00:01Z", id: `settled-${requestId}` },
      data: {
        outcome: options.outcome ?? "approved",
        requestId,
        responderPrincipalId: options.responderPrincipalId ?? principal.ownerUserId,
        sequence: sequence + 1,
        stepIndex: 0,
        turnId: "original-turn",
      },
    };
    if (options.persist !== false) {
      await recorder.observe(requested);
      await recorder.observe(settled);
    }
    return [requested, settled];
  };
  return {
    store,
    saved,
    input,
    context,
    operator,
    requests,
    reader,
    read,
    approve,
    recover: (mode = "same") => {
      recovery = mode;
    },
    unavailable: () => {
      statusAvailable = false;
    },
    changedCurrentPlan: () => {
      currentDigest = "c".repeat(64);
    },
  };
};

describe("owned hosted runtime prior approval", () => {
  it("requests ordinary first approval and performs no protected status request", async () => {
    const f = await fixture();
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toBe("user-approval");
    expect(f.requests).toEqual([]);
  });

  it("reuses the real terminal owner-approved receipt for an identical technical retry", async () => {
    const f = await fixture();
    await f.approve();
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toBe(
      "not-applicable",
    );
    expect(await f.read(f.input, f.context)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
    expect(f.requests.map((request) => request.action)).toEqual(["status", "status"]);
  });

  it("keeps the original approval epoch after a duplicate identical card was also approved", async () => {
    const f = await fixture();
    await f.approve();
    await f.approve({ callId: "duplicate-call", requestId: "duplicate-request", sequence: 10 });
    expect(await f.read(f.input, f.context)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
  });

  it("sends the server-derived original call to actual execute without accepting a callId in input", async () => {
    const f = await fixture();
    await f.approve();
    const prior = await f.read(f.input, f.context);
    const result = await prepareHostedRuntimeWithOperator(
      f.input,
      { ...f.context, callId: prior?.callId ?? f.context.callId },
      f.operator,
      () => {},
      {
        createResourceMismatch: () => new HostedOperatorError("resource_mismatch"),
        digest: operatorPlanDigest,
        sameSelection: sameOperatorSelection,
        isOperatorError: (error): error is HostedOperatorError =>
          error instanceof HostedOperatorError,
      },
    );
    expect(result.result.status).toBe("pending");
    const execute = f.requests.find((request) => request.action === "execute");
    expect(execute).toMatchObject({
      action: "execute",
      callId: "original-call",
      operationRef: f.input.operationRef,
      planDigest: f.input.planDigest,
    });
  });

  it.each(["operation", "release", "effects", "context", "expiry"] as const)(
    "requires fresh approval for changed %s scope",
    async (change) => {
      const f = await fixture();
      await f.approve();
      const plan = structuredClone(f.input.plan);
      let { operationRef } = f.input;
      if (change === "operation") {
        operationRef = randomUUID();
      }
      if (change === "release") {
        plan.release.id = "new-release";
      }
      if (change === "effects") {
        plan.effects[0] = { ...plan.effects[0], description: "New resource effect" };
      }
      if (change === "context") {
        plan.contextId = "new-context";
      }
      if (change === "expiry") {
        plan.retention.expiresAt = "2028-01-01T00:00:00.000Z";
      }
      const changed = { ...f.input, operationRef, plan, planDigest: operatorPlanDigest(plan) };
      expect(
        await evaluateHostedRuntimePreparationApproval(
          { ...f.context, toolInput: changed },
          f.read,
        ),
      ).toBe("user-approval");
      expect(f.requests).toEqual([]);
    },
  );

  it("denies a technically unavailable receipt/status lookup without issuing another card", async () => {
    const f = await fixture();
    await f.approve();
    f.unavailable();
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toMatchObject({
      type: "denied",
    });
    expect(f.requests.map((request) => request.action)).toEqual(["status"]);
  });

  it("denies a changed current protected plan and never executes it", async () => {
    const f = await fixture();
    await f.approve();
    f.changedCurrentPlan();
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toMatchObject({
      type: "denied",
    });
    expect(f.requests.map((request) => request.action)).toEqual(["status"]);
  });

  it("automatically restores only the original approved operation through normal planning", async () => {
    const f = await fixture();
    await f.approve();
    f.recover();
    expect(await f.read(f.input, f.context)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
    expect(f.requests.map((request) => request.action)).toEqual(["status", "plan", "status"]);
    expect(f.requests[1]).toMatchObject({
      action: "plan",
      operation: "prepare",
      selection: f.input.plan.selection,
    });
    expect(f.requests.some((request) => request.action === "execute")).toBe(false);
  });
  it.each(["digest", "operation", "status", "denied"] as const)(
    "denies changed or unavailable recovery %s",
    async (mode) => {
      const f = await fixture();
      await f.approve();
      f.recover(mode);
      await expect(f.read(f.input, f.context)).rejects.toThrow();
      expect(f.requests.map((request) => request.action)).toEqual(
        mode === "status" ? ["status", "plan", "status"] : ["status", "plan"],
      );
      expect(f.requests.some((request) => request.action === "execute")).toBe(false);
    },
  );

  it("denies a cancellation of the same scope and a nonowner responder", async () => {
    const f = await fixture();
    await f.approve();
    await f.approve({
      outcome: "cancelled",
      requestId: "cancelled-request",
      callId: "cancelled-call",
      sequence: 10,
    });
    f.recover();
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toMatchObject({
      type: "denied",
    });
    expect(f.requests).toEqual([]);
    const other = await fixture();
    await other.approve({ responderPrincipalId: "another-owner" });
    expect(await evaluateHostedRuntimePreparationApproval(other.context, other.read)).toMatchObject(
      { type: "denied" },
    );
  });

  it("denies a foreign owner/session, invalid digest, expired plan and aborted continuation", async () => {
    const f = await fixture();
    await f.approve();
    const owned = operatorOwnerContextSchema.parse(f.operator.ownerContext);
    const foreign = createHostedOperatorClient({
      endpoint: "https://operator.example",
      ownerContext: {
        ...owned,
        authority: { ...owned.authority, ownerUserId: "other" },
        principal: { ...owned.principal, ownerUserId: "other" },
      },
      sessionId: f.saved.sessionId,
      token: async () => await Promise.resolve("fixture-only"),
    });
    await expect(f.reader(f.input, f.context, foreign)).rejects.toThrow();
    await expect(f.read({ ...f.input, planDigest: "d".repeat(64) }, f.context)).rejects.toThrow();
    const expired = {
      ...f.input.plan,
      retention: { ...f.input.plan.retention, expiresAt: "2025-01-01T00:00:00.000Z" },
    };
    await expect(
      f.read({ ...f.input, plan: expired, planDigest: operatorPlanDigest(expired) }, f.context),
    ).rejects.toThrow();
    const controller = new AbortController();
    controller.abort();
    await expect(
      f.read(f.input, { ...f.context, abortSignal: controller.signal }),
    ).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
});

const nativeApprovalCapture = (
  f: Awaited<ReturnType<typeof fixture>>,
  events: MessageStreamEvent[],
  startIndex = 0,
) => {
  const fetchImplementation = vi.fn<typeof fetch>(async (url, init) => {
    await Promise.resolve();
    const requested = new URL(url instanceof Request ? url.url : url);
    expect(requested.origin).toBe("https://builder.example");
    expect(requested.pathname).toBe(`/eve/v1/session/${f.saved.adapterSessionId}/stream`);
    expect(requested.searchParams.get("startIndex")).toBe(String(startIndex));
    expect(requested.searchParams.get("includeTailIndex")).toBe("1");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer builder-workload-fixture");
    return new Response(
      `${events
        .slice(startIndex)
        .map((event) => JSON.stringify(event))
        .join("\n")}\n`,
      {
        headers: {
          "content-type": "application/x-ndjson",
          "x-eve-session-id": f.saved.adapterSessionId,
          "x-eve-stream-format": "ndjson",
          "x-eve-stream-version": "25",
          "x-eve-stream-tail-index": String(events.length - 1),
        },
      },
    );
  });
  const capture = vi.fn(async (ctx: Parameters<typeof f.reader>[1]) => {
    await captureHostedRuntimeApproval({
      ownerContext: operatorOwnerContextSchema.parse(f.operator.ownerContext),
      store: f.store,
      baseUrl: "https://builder.example",
      signal: ctx.abortSignal,
      workloadIdentity: { token: async () => await Promise.resolve("builder-workload-fixture") },
      fetchImplementation,
    });
  });
  const read = createHostedRuntimeExecutionApprovalReader({ readPrior: f.reader, capture });
  return { read, capture, fetchImplementation };
};
const retainedApprovalCapture = async (
  f: Awaited<ReturnType<typeof fixture>>,
  events: MessageStreamEvent[],
) => {
  const recorder = createPrivateHostedApprovalRecorder({
    principal,
    sessionId: f.saved.sessionId,
    store: f.store,
  });
  await recorder.observe(events[0]);
  const native = nativeObservationStateSchema.parse({
    adapterSessionId: f.saved.adapterSessionId,
    artifactReadback: {
      incompleteArtifacts: [],
      incompleteUiPreviews: [],
      legacy: false,
      markdownCalls: [],
      pending: [],
      references: { requested: [], requestedUiPreview: [] },
    },
    boundary: "input_required",
    invalidInput: false,
    nextNativeIndex: 1,
    pendingRequests: [],
    prototypeProjector: { artifactReadRequests: [], readChunks: [], requested: [], transfers: [] },
    prototypeReference: { requested: [], requestedUiPreview: [] },
    publicEventCount: 1,
    version: 1,
  });
  const ref = { id: randomUUID(), digest: `sha256:${"a".repeat(64)}`, eventCount: 1 };
  const metadata = {
    capturedAtEpochMs: 10,
    status: "input_required" as const,
    version: 1 as const,
    nativeObservationState: native,
    privateApprovalCaptureState: recorder.snapshot(),
  };
  const getSession = f.store.getSession.bind(f.store);
  const read = vi
    .spyOn(f.store, "getSession")
    .mockImplementation(async (candidatePrincipal, sessionId) => {
      const stored = await getSession(candidatePrincipal, sessionId);
      if (stored === null) {
        return null;
      }
      const { checkpoint, ...paged } = toDurableHostedSessionRecord(stored);
      void checkpoint;
      return { ...paged, checkpointRef: ref, checkpointDigest: ref.digest };
    });
  const checkpointDigest = ref.digest;
  f.store.readCheckpointPage = vi.fn<NonNullable<HostedEveStore["readCheckpointPage"]>>(() =>
    Promise.resolve({
      checkpointDigest,
      cursor: 1,
      totalEvents: 1,
      events: [
        {
          index: 0,
          text: "Waiting for approval",
          turnId: "original-turn",
          type: "assistant_message" as const,
        },
      ],
      metadata,
    }),
  );
  return { native, metadata, ref, read, getSession };
};

describe("Builder-local approval capture before execution", () => {
  it("persists actual native approval before the exact protected status/execute path", async () => {
    const f = await fixture();
    const events = await f.approve({ persist: false });
    const local = nativeApprovalCapture(f, events);
    const approval = await local.read(f.input, f.context, f.operator);
    expect(approval).toEqual({ approvalId: "original-request", callId: "original-call" });
    const stored = await f.store.getSession(principal, f.saved.sessionId);
    expect(stored?.version === 2 && stored.privateApprovalReceipts?.[0]?.outcome).toBe("approved");
    expect(local.capture).toHaveBeenCalledOnce();
    expect(local.fetchImplementation).toHaveBeenCalledOnce();
    expect(f.requests.map((request) => request.action)).toEqual(["status"]);
  });
  it("captures a settlement-only delta using the paired saved request without advancing the public checkpoint", async () => {
    const f = await fixture();
    const events = await f.approve({ persist: false });
    const seed = await retainedApprovalCapture(f, events);
    const local = nativeApprovalCapture(f, events, 1);
    expect(await local.read(f.input, f.context, f.operator)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
    const stored = await f.store.getSession(principal, f.saved.sessionId);
    expect(stored?.version === 2 && stored.privateApprovalReceipts?.[0]).toMatchObject({
      requestId: "original-request",
      outcome: "approved",
    });
    expect(stored?.version === 2 && stored.checkpointRef).toEqual(seed.ref);
    expect(seed.metadata.nativeObservationState.nextNativeIndex).toBe(1);
    expect(seed.metadata.privateApprovalCaptureState.pendingRequests).toHaveLength(1);
  });

  it("reuses the immutable pair when ordinary reads advance the current checkpoint in the same generation", async () => {
    const f = await fixture();
    const events = await f.approve({ persist: false });
    const seed = await retainedApprovalCapture(f, events);
    let reads = 0;
    const advancedCheckpointId = randomUUID();
    seed.read.mockImplementation(async (candidatePrincipal, sessionId) => {
      const stored = await seed.getSession(candidatePrincipal, sessionId);
      if (stored === null) {
        return null;
      }
      const { checkpoint, ...paged } = toDurableHostedSessionRecord(stored);
      void checkpoint;
      reads += 1;
      return {
        ...paged,
        checkpointRef: reads > 1 ? { ...seed.ref, id: advancedCheckpointId } : seed.ref,
        checkpointDigest: seed.ref.digest,
      };
    });
    const local = nativeApprovalCapture(f, events, 1);
    await local.capture(f.context);
    expect(await f.reader(f.input, f.context, f.operator)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
  });

  it.each([
    "missing-capture",
    "foreign-session",
    "foreign-adapter",
    "event-count",
    "checkpoint-digest",
    "replaced-generation",
  ])("cold-reads complete approval history instead of reusing %s state", async (failure) => {
    const f = await fixture();
    const events = await f.approve({ persist: false });
    const seed = await retainedApprovalCapture(f, events);
    if (failure === "missing-capture") {
      Reflect.deleteProperty(seed.metadata, "privateApprovalCaptureState");
    }
    if (failure === "foreign-session") {
      seed.metadata.privateApprovalCaptureState.sessionId = "another-session";
    }
    if (failure === "foreign-adapter") {
      seed.native.adapterSessionId = "another-adapter";
    }
    if (failure === "event-count") {
      seed.native.publicEventCount = 2;
    }
    if (failure === "checkpoint-digest") {
      seed.ref.digest = `sha256:${"b".repeat(64)}`;
    }
    if (failure === "replaced-generation") {
      let reads = 0;
      seed.read.mockImplementation(async (candidatePrincipal, sessionId) => {
        const stored = await seed.getSession(candidatePrincipal, sessionId);
        if (stored === null) {
          return null;
        }
        reads += 1;
        const { checkpoint, ...paged } = toDurableHostedSessionRecord(stored);
        void checkpoint;
        return {
          ...paged,
          checkpointRef: seed.ref,
          checkpointDigest: seed.ref.digest,
          ...(reads === 1 && failure === "replaced-generation"
            ? { adapterGeneration: f.saved.adapterGeneration + 1 }
            : {}),
        };
      });
    }
    const local = nativeApprovalCapture(f, events);
    await local.capture(f.context);
    expect(await f.reader(f.input, f.context, f.operator)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
  });

  it("skips native capture when exact durable approval already exists", async () => {
    const f = await fixture();
    const events = await f.approve();
    const local = nativeApprovalCapture(f, events);
    expect(await local.read(f.input, f.context, f.operator)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
    expect(local.capture).not.toHaveBeenCalled();
  });
  it.each(["orphan", "cancelled", "foreign-responder"])(
    "does not promote %s native input into approved authority",
    async (failure) => {
      const f = await fixture();
      const events = await f.approve({
        persist: false,
        ...(failure === "cancelled" ? { outcome: "cancelled" as const } : {}),
        ...(failure === "foreign-responder" ? { responderPrincipalId: "foreign-owner" } : {}),
      });
      const local = nativeApprovalCapture(f, failure === "orphan" ? events.slice(1) : events);
      if (failure === "orphan") {
        expect(await local.read(f.input, f.context, f.operator)).toBeNull();
      } else {
        await expect(local.read(f.input, f.context, f.operator)).rejects.toMatchObject({
          code: "authorization_required",
        });
      }
      expect(f.requests).toEqual([]);
    },
  );
  it("rechecks a real concurrently persisted receipt even when redundant capture fails", async () => {
    const f = await fixture();
    const capture = vi.fn(async () => {
      await f.approve();
      throw new Error("private capture response lost");
    });
    const read = createHostedRuntimeExecutionApprovalReader({ readPrior: f.reader, capture });
    expect(await read(f.input, f.context, f.operator)).toEqual({
      approvalId: "original-request",
      callId: "original-call",
    });
    expect(capture).toHaveBeenCalledOnce();
  });
  it("does not capture or suppress a real saved cancellation", async () => {
    const f = await fixture();
    const events = await f.approve({ outcome: "cancelled" });
    const local = nativeApprovalCapture(f, events);
    await expect(local.read(f.input, f.context, f.operator)).rejects.toMatchObject({
      code: "authorization_required",
    });
    expect(local.capture).not.toHaveBeenCalled();
  });
  it("does not fetch a native stream after adapter generation changed", async () => {
    const f = await fixture();
    const local = nativeApprovalCapture(f, await f.approve({ persist: false }));
    vi.spyOn(f.store, "getSession").mockResolvedValue({
      ...f.saved,
      adapterGeneration: f.saved.adapterGeneration + 1,
    });
    await expect(local.capture(f.context)).rejects.toThrow();
    expect(local.fetchImplementation).not.toHaveBeenCalled();
  });
  it("preserves cancellation after capture instead of executing", async () => {
    const f = await fixture();
    const controller = new AbortController();
    const context = { ...f.context, abortSignal: controller.signal };
    const capture = vi.fn(async () => {
      await f.approve();
      controller.abort();
    });
    const read = createHostedRuntimeExecutionApprovalReader({ readPrior: f.reader, capture });
    await expect(read(f.input, context, f.operator)).rejects.toThrow();
    expect(f.requests).toEqual([]);
  });
});
