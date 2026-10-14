import { randomUUID } from "node:crypto";
import type { ApprovalContext } from "eve/tools/approval";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it } from "vitest";

import { evaluateHostedRuntimePreparationApproval } from "../../agent/tools/prepare-app-hosted-runtime";
import { createPrivateHostedApprovalRecorder } from "../eve/private-hosted-approval";
import { InMemoryHostedEveStore } from "../eve/hosted-store";
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
import { createHostedRuntimePriorApprovalReader } from "./hosted-runtime-prior-approval";

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
  const http: typeof fetch = async (target, init) => {
    const request = new Request(target, init);
    const body: unknown = await request.json();
    const parsed = operatorRequestSchema.parse(body);
    requests.push(parsed);
    if (!statusAvailable) {
      throw new Error("Private technical outage");
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
    await recorder.observe(requested);
    await recorder.observe(settled);
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

  it("denies a cancellation of the same scope and a nonowner responder", async () => {
    const f = await fixture();
    await f.approve();
    await f.approve({
      outcome: "cancelled",
      requestId: "cancelled-request",
      callId: "cancelled-call",
      sequence: 10,
    });
    expect(await evaluateHostedRuntimePreparationApproval(f.context, f.read)).toMatchObject({
      type: "denied",
    });
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
