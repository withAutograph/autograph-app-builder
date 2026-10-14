import { z } from "zod";
import { createLocalEveSessionService } from "./service";
import { createSameOriginEveTransport, observeSameOriginEveStream } from "./same-origin-http";
import { nativeObservationStateSchema } from "./native-observation-state";
import {
  toDurableHostedSessionRecord,
  InMemoryHostedEveStore,
  hostedSessionCheckpointSchema,
} from "./hosted-store";
import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";
import { createHostedEveSessionService, SubmissionOutcomeUnknownError } from "./hosted-service";
import type { HostedEveTransport, HostedEngineSnapshot } from "./hosted-service";
import { hostedEveOperationScopes } from "./hosted-auth";
import { projectInstalledEveEvents, projectInstalledEveEvent } from "./public-events";
import {
  guardRequestIds,
  uncappedBuilderPolicy,
  internalSessionLimitResponseSchema,
  mergeSessionLimitResponses,
  nativeResponses,
  privateInputForEvents,
  provesSessionLimitResponse,
} from "./session-limit-input";

const principal = {
  audience: "autograph-app-builder",
  issuer: "https://identity.example.test",
  ownerUserId: "owner",
  scopes: Object.values(hostedEveOperationScopes),
  workspaceId: "workspace",
};
const request = (
  requestId = "native:limit:input:120143363",
  kind: "session-limit" | "tool-approval" | "question" = "session-limit",
) => ({
  action: {
    callId: requestId,
    input: {},
    kind: "tool-call" as const,
    toolName: kind === "session-limit" ? "session_limit_continuation" : "ask_question",
  },
  allowFreeform: false,
  kind,
  options: [
    { id: "continue", label: "Continue" },
    { id: "stop", label: "Stop" },
  ],
  prompt: "Technical framework budget",
  requestId,
});
const event = (requests = [request()]): MessageStreamEvent => ({
  data: { requests, sequence: 8, stepIndex: 2, turnId: "old-turn" },
  meta: { at: "2026-10-13T00:00:00Z", id: "requested" },
  type: "input.requested",
});
const resolved = (optionId = "continue"): MessageStreamEvent => ({
  data: {
    resolutions: [
      {
        kind: "session-limit",
        outcome: "answered",
        requestId: request().requestId,
        response: { optionId, requestId: request().requestId },
      },
    ],
    sequence: 8,
    stepIndex: 2,
    turnId: "old-turn",
  },
  meta: { at: "2026-10-13T00:00:01Z", id: "resolved" },
  type: "input.resolved",
});
const stopEvents = (): MessageStreamEvent[] => [
  resolved("stop"),
  {
    data: { sequence: 9, turnId: "stop-turn" },
    meta: { at: "2026-10-13T00:00:02Z", id: "stop-started" },
    type: "turn.started",
  },
  {
    data: { sequence: 9, turnId: "stop-turn" },
    meta: { at: "2026-10-13T00:00:03Z", id: "stop-cancelled" },
    type: "turn.cancelled",
  },
  {
    data: { continuationToken: "native", wait: "next-user-message" },
    meta: { at: "2026-10-13T00:00:04Z", id: "stop-waiting" },
    type: "session.waiting",
  },
];
const snapshot = (events: MessageStreamEvent[]): HostedEngineSnapshot => ({
  events: events.flatMap((entry, index) => projectInstalledEveEvent(entry, index)),
  privateInputState: privateInputForEvents(events),
  status:
    events.at(-1)?.type === "input.resolved" || events.at(-1)?.type === "session.waiting"
      ? "waiting"
      : "input_required",
});
const setup = async (events: MessageStreamEvent[] = [event()], uncertain = false) => {
  const store = new InMemoryHostedEveStore();
  const reservation = vi.spyOn(store, "reserveOperation");
  let current = snapshot(events);
  const assertOwner = vi.fn(async () => {});
  // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
  // oxlint-disable-next-line eslint/require-await -- Preserve asynchronous native response acceptance in this provider-free fixture.
  const respond = vi.fn(async (input: Parameters<HostedEveTransport["respond"]>[0]) => {
    if (uncertain) {
      throw new SubmissionOutcomeUnknownError();
    }
    const decision = input.responses[0]?.response;
    current = snapshot([
      ...events,
      ...(decision?.kind === "answer" && decision.optionId === "stop"
        ? stopEvents()
        : [resolved()]),
    ]);
    return current;
  });
  const adapter: HostedEveTransport = {
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
    cancel: vi.fn(async () => current),
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
    get: vi.fn(async () => current),
    respond,
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
    send: vi.fn(async () => current),
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
    start: vi.fn(async () => ({ adapterSessionId: "native", snapshot: current })),
  };
  const create = () =>
    createHostedEveSessionService({
      assertSessionLimitOwner: assertOwner,
      principal,
      store,
      transport: adapter,
    });
  const start = await create().start({ clientRequestId: "start", prompt: "App" });
  return {
    adapter,
    assertOwner,
    create,
    reservation,
    respond,
    sessionId: start.sessionId,
    setCurrent: (next: MessageStreamEvent[]) => {
      current = snapshot(next);
    },
    store,
  };
};

describe("typed framework session usage continuation", () => {
  it("keeps compact typed provenance; framework questions stay private and legacy checkpoints parse", () => {
    const native = event();
    const state = privateInputForEvents([native]);
    expect(JSON.stringify(state)).not.toMatch(/Technical framework|"action"|"input"|"prompt"/u);
    expect(guardRequestIds(state)).toEqual([request().requestId]);
    expect(projectInstalledEveEvents([native])).toEqual([]);
    expect(
      hostedSessionCheckpointSchema.safeParse({
        capturedAtEpochMs: 0,
        events: [],
        status: "waiting",
        version: 1,
      }).success,
    ).toBe(true);
  });
  it("automatically continues a pure guard once through the canonical full snapshot RESPOND path", async () => {
    const fixture = await setup();
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(result.inputRequests).toEqual([]);
    expect(result.events.some((entry) => entry.type === "input_required")).toBe(false);
    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        adapterSessionId: "native",
        responses: [
          {
            requestId: request().requestId,
            response: { kind: "answer", optionId: "continue", value: "continue" },
          },
        ],
      }),
    );
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.assertOwner).toHaveBeenCalled();
  });
  it("never repeats an unknown POST and reconciles only the observed exact continue choice", async () => {
    const fixture = await setup([event()], true);
    const first = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(first).toMatchObject({
      error: { code: "framework_continuation_settling" },
      inputRequests: [],
      status: "working",
    });
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).toHaveBeenCalledOnce();
    fixture.setCurrent([event(), resolved()]);
    const reconciled = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(reconciled.status).toBe("waiting");
    expect(fixture.respond).toHaveBeenCalledOnce();
    const candidate = fixture.reservation.mock.calls.find(
      ([, entry]) => entry.kind === "respond",
    )?.[1];
    const operation =
      candidate === undefined
        ? null
        : await fixture.store.getPrivateOperation(principal, candidate.operationId);
    expect(operation?.state).toBe("succeeded");
  });
  it("retains a real product decision and merges only the typed guard into the exact human response batch", async () => {
    const product = request("product-question", "question");
    const fixture = await setup([
      event(),
      {
        data: { requests: [product], sequence: 9, stepIndex: 3, turnId: "old-turn" },
        meta: { at: "2026-10-13T00:00:00Z", id: "product" },
        type: "input.requested",
      },
    ]);
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(result.inputRequests?.map((entry) => entry.requestId)).toEqual(["product-question"]);
    expect(fixture.respond).not.toHaveBeenCalled();
    await fixture.create().respond({
      clientRequestId: "human-reply",
      responses: [
        { requestId: "product-question", response: { kind: "answer", value: "Requester" } },
      ],
      sessionId: fixture.sessionId,
    });
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        responses: [
          {
            requestId: request().requestId,
            response: { kind: "answer", optionId: "continue", value: "continue" },
          },
          { requestId: "product-question", response: { kind: "answer", value: "Requester" } },
        ],
      }),
    );
  });
  it("rejects stale ownership before dispatch without presenting the framework guard", async () => {
    const fixture = await setup();
    fixture.assertOwner.mockRejectedValue(new Error("Owner changed"));
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).not.toHaveBeenCalled();
    expect(result.inputRequests).toEqual([]);
    expect(result.events.some((entry) => entry.type === "input_required")).toBe(false);
    expect(result.status).toBe("waiting");
    expect(result.error).toBeDefined();
  });
  it("keeps real human input visible when framework ownership verification fails", async () => {
    const human = request("real-approval", "tool-approval");
    const fixture = await setup([event(), event([human])]);
    fixture.assertOwner.mockRejectedValue(new Error("Owner changed"));
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).not.toHaveBeenCalled();
    expect(result.inputRequests?.map((input) => input.requestId)).toEqual([human.requestId]);
    expect(
      result.events
        .filter((entry) => entry.type === "input_required")
        .map((entry) => entry.request.requestId),
    ).toEqual([human.requestId]);
    expect(result.status).toBe("input_required");
    expect(result.error).toBeDefined();
  });
  it("keeps a typed framework guard internal when legacy coordinates cannot authorize continuation", async () => {
    const missingCoordinates = event();
    if (missingCoordinates.type === "input.requested") {
      Reflect.deleteProperty(missingCoordinates.data, "sequence");
    }
    const fixture = await setup([missingCoordinates]);
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).not.toHaveBeenCalled();
    expect(result.inputRequests).toEqual([]);
    expect(result.events.some((entry) => entry.type === "input_required")).toBe(false);
    expect(result.status).toBe("waiting");
    expect(result.error?.code).toBe("framework_continuation_unavailable");
    const ordinary = event([request("ordinary", "question")]);
    expect(projectInstalledEveEvents([ordinary])[0]).toMatchObject({
      request: { requestId: "ordinary" },
      type: "input_required",
    });
  });
  it("does not coerce text, ordinary questions, or native requests without a continue option", () => {
    const ordinary = request("product", "question");
    const noContinue = { ...request(), options: [{ id: "approve", label: "Approve" }] };
    expect(guardRequestIds(privateInputForEvents([event([ordinary])]))).toEqual([]);
    expect(guardRequestIds(privateInputForEvents([event([noContinue])]))).toEqual([]);
  });
  it("requires exact full order and resolved choices; disappearance, stop, foreign IDs and changed coordinates do not prove acceptance", () => {
    const pending = privateInputForEvents([event()]);
    const responses = mergeSessionLimitResponses(pending, []);
    const marker = internalSessionLimitResponseSchema.parse({
      adapterGeneration: 1,
      adapterSessionId: "native",
      batches: pending.pending,
      decision: "continue",
      responses: nativeResponses(responses),
    });
    expect(provesSessionLimitResponse(marker, privateInputForEvents([event(), resolved()]))).toBe(
      true,
    );
    expect(provesSessionLimitResponse(marker, privateInputForEvents([]))).toBe(false);
    expect(
      provesSessionLimitResponse(marker, privateInputForEvents([event(), resolved("stop")])),
    ).toBe(false);
    const changed = event();
    if (changed.type === "input.requested") {
      changed.data.sequence = 99;
    }
    expect(provesSessionLimitResponse(marker, privateInputForEvents([changed, resolved()]))).toBe(
      false,
    );
    expect(() =>
      mergeSessionLimitResponses(
        privateInputForEvents([event([request(), request("product", "question")])]),
        [],
      ),
    ).toThrow();
  });
  it("does not settle an unknown response from a stop choice or a replacement adapter generation", async () => {
    const fixture = await setup([event()], true);
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    const candidate = fixture.reservation.mock.calls.find(
      ([, entry]) => entry.kind === "respond",
    )?.[1];
    if (candidate === undefined) {
      throw new Error("Missing response reservation");
    }
    fixture.setCurrent([event(), ...stopEvents()]);
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    const unknownOperation = await fixture.store.getPrivateOperation(
      principal,
      candidate.operationId,
    );
    expect(unknownOperation?.state).toBe("submission_unknown");
    const current = await fixture.store.getSession(principal, fixture.sessionId);
    if (current === null) {
      throw new Error("Missing session");
    }
    const durable = toDurableHostedSessionRecord(current);
    if (durable.checkpoint === undefined) {
      throw new Error("Missing checkpoint");
    }
    await fixture.store.replaceSessionAdapter({
      adapterSessionId: "replacement",
      checkpoint: durable.checkpoint,
      expectedAdapterGeneration: durable.adapterGeneration,
      expectedCheckpointDigest: durable.checkpointDigest,
      nowEpochMs: Date.now(),
      principal,
      resumability: "live",
      sessionId: fixture.sessionId,
      stage: durable.stage,
    });
    await expect(
      fixture.store.settleSucceeded({
        nowEpochMs: Date.now(),
        operationId: candidate.operationId,
        principal,
        requestDigest: candidate.requestDigest,
        result: { cursor: 0, events: [], sessionId: fixture.sessionId, status: "waiting" },
        sessionLimitResolution: privateInputForEvents([event(), resolved()]),
      }),
    ).rejects.toThrow();
    await expect(
      fixture.store.settleSucceeded({
        nowEpochMs: Date.now(),
        operationId: candidate.operationId,
        principal: { ...principal, ownerUserId: "foreign" },
        requestDigest: candidate.requestDigest,
        result: { cursor: 0, events: [], sessionId: fixture.sessionId, status: "waiting" },
        sessionLimitResolution: privateInputForEvents([event(), resolved()]),
      }),
    ).rejects.toThrow();
    expect(fixture.respond).toHaveBeenCalledOnce();
  });
  it("rejects a changed native batch between controller observation and response admission", async () => {
    const fixture = await setup();
    const changed = event();
    if (changed.type === "input.requested") {
      changed.data.sequence = 88;
    }
    let reads = 0;
    // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
    fixture.adapter.get = vi.fn(async () => {
      reads += 1;
      return snapshot([reads === 1 ? event() : changed]);
    });
    const result = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).not.toHaveBeenCalled();
    expect(result.error).toBeDefined();
  });
  it("retains compact typed provenance through the actual incremental NDJSON observer and native cursor checkpoint", async () => {
    let events = [event()];
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
    const fetchImplementation = vi.fn(async (url: string | URL | Request) => {
      const parsed = new URL(url instanceof Request ? url.url : url);
      const startIndex = Number(parsed.searchParams.get("startIndex") ?? 0);
      return new Response(
        `${events
          .slice(startIndex)
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
        {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-session-id": "native",
            "x-eve-stream-format": "ndjson",
            "x-eve-stream-tail-index": String(events.length - 1),
            "x-eve-stream-version": "25",
          },
        },
      );
    });
    const common = {
      config: { baseUrl: "https://builder.example.test", timeoutMs: 1000 },
      fetchImplementation,
      onEvent: vi.fn(),
      sessionId: "native",
      // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
      workloadIdentity: { token: vi.fn(async () => "synthetic-oidc") },
    };
    const first = await observeSameOriginEveStream(common);
    expect(first.nativeObservationState.privateInputState?.pending[0]?.requests[0]?.kind).toBe(
      "session-limit",
    );
    const oldCheckpoint = { ...first.nativeObservationState };
    delete oldCheckpoint.privateInputState;
    expect(nativeObservationStateSchema.safeParse(oldCheckpoint).success).toBe(true);
    events = [event(), resolved()];
    const second = await observeSameOriginEveStream({
      ...common,
      nativeObservationState: first.nativeObservationState,
    });
    expect(second.pendingRequests).toEqual([]);
    expect(
      second.nativeObservationState.privateInputState?.resolved[0]?.resolutions[0]?.response
        ?.optionId,
    ).toBe("continue");
    expect(fetchImplementation.mock.calls[1]?.[0]).toEqual(expect.stringContaining("startIndex=1"));
    expect(JSON.stringify(second.nativeObservationState.privateInputState)).not.toContain(
      "Technical framework",
    );
  });
  it.each([false, true])(
    "uses a reserved local process receipt without retrying uncertain acceptance (unknown=%s)",
    async (unknown) => {
      let events: MessageStreamEvent[] = [event()];
      const response = {
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        cancel: vi.fn(async () => ({})),
        async *[Symbol.asyncIterator]() {
          yield resolved();
        },
      };
      const native = {
        cancel: vi.fn(),
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        respond: vi.fn(async () => {
          if (unknown) {
            throw new Error("Unknown local acceptance");
          }
          events = [event(), resolved()];
          return response;
        }),
        send: vi.fn(),
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous native transport contract in this provider-free fixture.
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        snapshot: vi.fn(async () => ({
          events,
          session: { sessionId: "native-local", streamIndex: events.length },
        })),
        state: { sessionId: "native-local" },
      };
      const client = { sessions: { attach: vi.fn(() => native), create: vi.fn() } };
      // SAFETY: This fixture implements every SDK client method used by the local service; it cannot contact a provider.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Use the bounded SDK double without unrelated client internals.
      const service = createLocalEveSessionService(client as never, {
        stateGeneration: `guard-local-${String(unknown)}`,
      });
      const first = await service.get({ cursor: 0, limit: 100, sessionId: "native-local" });
      expect(first.inputRequests).toEqual([]);
      await service.get({ cursor: 0, limit: 100, sessionId: "native-local" });
      expect(native.respond).toHaveBeenCalledOnce();
      if (unknown) {
        events = [event(), resolved()];
        const settled = await service.get({ cursor: 0, limit: 100, sessionId: "native-local" });
        expect(settled.inputRequests).toEqual([]);
        expect(native.respond).toHaveBeenCalledOnce();
      }
    },
  );
  it("owner Cancel submits STOP once and later GET cannot auto-continue that same parked guard", async () => {
    const fixture = await setup();
    await fixture.store.recordPrivateBuildDecision({
      decision: {
        adapterSessionId: "native",
        decision: "runnable",
        scope: {
          appId: "fixture",
          appSpecDigest: "a".repeat(64),
          proposalDigest: "b".repeat(64),
          sessionId: "native",
          workspaceId: "workspace",
        },
        turnId: "old-turn",
        turnSequence: 8,
        version: 1,
        workflowPhase: "applied",
      },
      principal,
      sessionId: fixture.sessionId,
    });
    // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
    fixture.adapter.sendAccepted = vi.fn(async () => {});
    await fixture.create().cancel({ sessionId: fixture.sessionId, turnId: "old-turn" });
    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        responses: [
          {
            requestId: request().requestId,
            response: { kind: "answer", optionId: "stop", value: "stop" },
          },
        ],
      }),
    );
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).toHaveBeenCalledOnce();
    expect(fixture.adapter.sendAccepted).not.toHaveBeenCalled();
  });
  it("unknown STOP is never replayed or replaced with Continue, and reconciles only exact stop evidence", async () => {
    const fixture = await setup([event()], true);
    await expect(fixture.create().cancel({ sessionId: fixture.sessionId })).rejects.toThrow();
    const pending = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(pending).toMatchObject({
      error: { code: "framework_stop_settling" },
      inputRequests: [],
      status: "working",
    });
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(fixture.respond).toHaveBeenCalledOnce();
    fixture.setCurrent([event(), ...stopEvents()]);
    await fixture.create().get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    const candidate = fixture.reservation.mock.calls.find(
      ([, operation]) => operation.internalSessionLimitResponse?.decision === "stop",
    )?.[1];
    if (candidate === undefined) {
      throw new Error("Missing STOP reservation");
    }
    const operation = await fixture.store.getPrivateOperation(principal, candidate.operationId);
    expect(operation?.state).toBe("succeeded");
    expect(fixture.respond).toHaveBeenCalledOnce();
  });
  it("stale Cancel does not select STOP or authorize a continuation", async () => {
    const fixture = await setup();
    await expect(
      fixture.create().cancel({ sessionId: fixture.sessionId, turnId: "unrelated-turn" }),
    ).rejects.toThrow();
    expect(fixture.respond).not.toHaveBeenCalled();
  });
  it("Cancel stops the exact guard without approving or denying an unrelated resource request", async () => {
    const approval = {
      ...request("resource", "tool-approval"),
      action: {
        callId: "resource",
        input: {},
        kind: "tool-call" as const,
        toolName: "resource_effect",
      },
      options: [
        { id: "approve", label: "Approve" },
        { id: "cancel", label: "Cancel" },
      ],
    };
    const productEvent = event([approval]);
    if (productEvent.type === "input.requested") {
      productEvent.data.sequence = 9;
    }
    const fixture = await setup([event(), productEvent]);
    await fixture.create().cancel({ sessionId: fixture.sessionId });
    expect(fixture.respond).toHaveBeenCalledWith(
      expect.objectContaining({
        responses: [
          {
            requestId: request().requestId,
            response: { kind: "answer", optionId: "stop", value: "stop" },
          },
        ],
      }),
    );
    const later = await fixture
      .create()
      .get({ cursor: 0, limit: 100, sessionId: fixture.sessionId });
    expect(later.inputRequests?.map((pending) => pending.requestId)).toEqual(["resource"]);
    expect(fixture.respond).toHaveBeenCalledOnce();
  });
  it("requires all three current platform session caps to be explicitly disabled", () => {
    expect(uncappedBuilderPolicy()).toBe(true);
    expect(uncappedBuilderPolicy({})).toBe(false);
    expect(
      uncappedBuilderPolicy({
        maxInputTokensPerSession: 0,
        maxOutputTokensPerSession: false,
        maxTokenCostUsdPerSession: false,
      }),
    ).toBe(false);
    expect(
      uncappedBuilderPolicy({ maxInputTokensPerSession: false, maxOutputTokensPerSession: false }),
    ).toBe(false);
  });
  it.each([false, true])(
    "local owner Cancel fences future GET even when STOP acceptance is unknown (%s)",
    async (unknown) => {
      let events: MessageStreamEvent[] = [event()];
      // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
      const response = {
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        cancel: vi.fn(async () => ({})),
        async *[Symbol.asyncIterator]() {
          for (const next of stopEvents()) {
            yield next;
          }
        },
      };
      // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
      const native = {
        cancel: vi.fn(),
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        respond: vi.fn(async () => {
          if (unknown) {
            throw new Error("Unknown acceptance");
          }
          events = [event(), ...stopEvents()];
          return response;
          // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
        }),
        send: vi.fn(),
        // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
        snapshot: vi.fn(async () => ({
          events,
          session: { sessionId: "native-local-stop", streamIndex: events.length },
        })),
        state: { sessionId: "native-local-stop" },
      };
      const client = { sessions: { attach: vi.fn(() => native), create: vi.fn() } };
      // SAFETY: Only the SDK methods used by this local controller are implemented, and no provider operation is possible.
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Bound this SDK fixture to the local service methods.
      const service = createLocalEveSessionService(client as never, {
        stateGeneration: `local-stop-${String(unknown)}`,
      });
      const cancel = service.cancel({ sessionId: "native-local-stop", turnId: "old-turn" });
      await (unknown ? expect(cancel).rejects.toThrow() : cancel);
      await service.get({ cursor: 0, limit: 100, sessionId: "native-local-stop" });
      await service.get({ cursor: 0, limit: 100, sessionId: "native-local-stop" });
      expect(native.respond).toHaveBeenCalledOnce();
      expect(native.respond).toHaveBeenCalledWith([
        { optionId: "stop", requestId: request().requestId },
      ]);
    },
  );
  it("the actual structured RESPOND transport accepts exact typed STOP while keeping a real approval pending", async () => {
    const approval = {
      ...request("resource", "tool-approval"),
      action: {
        callId: "resource",
        input: {},
        kind: "tool-call" as const,
        toolName: "resource_effect",
      },
    };
    const approvalEvent = event([approval]);
    if (approvalEvent.type === "input.requested") {
      approvalEvent.data.sequence = 9;
    }
    let events = [event(), approvalEvent];
    const posts: unknown[] = [];
    // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
    const fetchImplementation: typeof fetch = async (url, init) => {
      if (init?.method === "POST") {
        posts.push(JSON.parse(z.string().parse(init.body)));
        events = [event(), approvalEvent, ...stopEvents()];
        return Response.json(
          { deliveryId: "delivery", ok: true, sessionId: "native", status: "accepted" },
          { status: 202 },
        );
      }
      const parsed = new URL(url instanceof Request ? url.url : url);
      const startIndex = Number(parsed.searchParams.get("startIndex") ?? 0);
      return new Response(
        `${events
          .slice(startIndex)
          .map((entry) => JSON.stringify(entry))
          .join("\n")}\n`,
        {
          headers: {
            "content-type": "application/x-ndjson",
            "x-eve-session-id": "native",
            "x-eve-stream-format": "ndjson",
            "x-eve-stream-tail-index": String(events.length - 1),
            "x-eve-stream-version": "25",
          },
        },
      );
    };
    // oxlint-disable-next-line eslint/require-await -- This bounded fixture preserves the asynchronous native SDK contract.
    const common = {
      config: { baseUrl: "https://builder.example.test", timeoutMs: 1000 },
      fetchImplementation,
      // oxlint-disable-next-line eslint/require-await -- Preserve the asynchronous SDK contract in this bounded fixture.
      workloadIdentity: { token: async () => "synthetic-oidc" },
    };
    const initial = await observeSameOriginEveStream({
      ...common,
      onEvent: vi.fn(),
      sessionId: "native",
    });
    const state = initial.nativeObservationState.privateInputState;
    if (state === undefined) {
      throw new Error("Missing native provenance");
    }
    const responses = [
      {
        requestId: request().requestId,
        response: { kind: "answer" as const, optionId: "stop", value: "stop" },
      },
    ];
    const marker = internalSessionLimitResponseSchema.parse({
      adapterGeneration: 1,
      adapterSessionId: "native",
      batches: state.pending.slice(0, 1),
      decision: "stop",
      responses: nativeResponses(responses),
    });
    await createSameOriginEveTransport(common).respondAccepted?.({
      adapterSessionId: "native",
      internalSessionLimitResponse: marker,
      nativeObservationState: initial.nativeObservationState,
      operationId: "stop",
      principal,
      responses,
    });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({
      inputResponses: [{ optionId: "stop", requestId: request().requestId }],
    });
    const settled = await observeSameOriginEveStream({
      ...common,
      nativeObservationState: initial.nativeObservationState,
      onEvent: vi.fn(),
      sessionId: "native",
    });
    expect(settled.pendingRequests.map((pending) => pending.requestId)).toEqual(["resource"]);
  });
});
