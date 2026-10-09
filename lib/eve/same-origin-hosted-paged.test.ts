import { createHash, randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";
import { z } from "zod";
import { createSameOriginEveTransport } from "./same-origin-http";
import { createHostedEveSessionService } from "./hosted-service";
import { hostedEveOperationScopes, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import { durableHostedSessionRecordSchema, InMemoryHostedEveStore } from "./hosted-store";
import type {
  HostedEveStore,
  HostedPagedCheckpointMetadata,
  HostedSessionRecord,
} from "./hosted-store";
import type { PublicEveEvent } from "../mcp/contracts";
import { projectInstalledEveEvent } from "./public-events";
import type { MessageStreamEvent } from "eve/client";
import { nativeObservationStateSchema } from "./native-observation-state";

const question = (requestId: string) => ({
  data: {
    requests: [
      { allowFreeform: true, display: "text", kind: "question", prompt: "Choose", requestId },
    ],
  },
  type: "input.requested",
});
const resolved = (requestId: string) => ({
  data: { resolutions: [{ requestId }] },
  type: "input.resolved",
});

const authorizationRequired = (
  attemptId: string,
): Extract<MessageStreamEvent, { type: "authorization.required" }> => ({
  data: {
    attemptId,
    authorization: { url: "https://consent.example/private-link" },
    description: "Connect",
    name: "hosted-neon",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_auth",
  },
  meta: { at: "2026-10-09T00:00:00.000Z", id: `required-${attemptId}` },
  type: "authorization.required",
});
const authorizationCompleted = (
  attemptId: string,
): Extract<MessageStreamEvent, { type: "authorization.completed" }> => ({
  data: {
    attemptId,
    name: "hosted-neon",
    outcome: "authorized",
    sequence: 0,
    stepIndex: 0,
    turnId: "turn_auth",
  },
  meta: { at: "2026-10-09T00:00:01.000Z", id: `completed-${attemptId}` },
  type: "authorization.completed",
});
const authorizationFixture = async () => {
  const owner: HostedPrincipal = {
    audience: "fixture",
    issuer: "https://identity.example",
    ownerUserId: "owner",
    scopes: Object.values(hostedEveOperationScopes),
    workspaceId: "workspace",
  };
  const native: unknown[] = [
    authorizationRequired("old-auth"),
    authorizationCompleted("old-auth"),
    { data: {}, type: "session.waiting" },
  ];
  const starts: number[] = [];
  let prefixFailure: "none" | "short" | "unavailable" = "none";
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const start = Number(url.searchParams.get("startIndex"));
    starts.push(start);
    if (start === 0 && prefixFailure === "unavailable") {
      return await Promise.resolve(new Response(null, { status: 404 }));
    }
    const events = start === 0 && prefixFailure === "short" ? native.slice(1) : native.slice(start);
    return new Response(events.map((event) => JSON.stringify(event)).join("\n"), {
      headers: {
        "content-type": "application/x-ndjson",
        "x-eve-session-id": "wrun_auth",
        "x-eve-stream-format": "ndjson",
        "x-eve-stream-tail-index": String(native.length - 1),
        "x-eve-stream-version": "25",
      },
    });
  });
  const verifyReadAuthority = vi.fn<
    NonNullable<Parameters<typeof createSameOriginEveTransport>[0]["verifyReadAuthority"]>
  >(
    async (input) =>
      await Promise.resolve(
        input.adapterSessionId === "wrun_auth" &&
          tenantKeyFor(input.principal) === tenantKeyFor(owner),
      ),
  );
  const transport = createSameOriginEveTransport({
    config: { baseUrl: "https://builder.example" },
    fetchImplementation: fetcher,
    verifyReadAuthority,
    workloadIdentity: { token: async () => await Promise.resolve("fixture-workload") },
  });
  if (transport.observe === undefined) {
    throw new Error("Expected authenticated observation transport");
  }
  const { observe } = transport;
  const onEvent = vi.fn(async () => {
    await Promise.resolve();
  });
  const onPrivateEvent = vi.fn(async () => {
    await Promise.resolve();
  });
  const input = {
    adapterSessionId: "wrun_auth",
    onEvent,
    onPrivateEvent,
    principal: owner,
    sessionId: "public_auth",
  };
  const initial = await observe(input);
  const state = initial.nativeObservationState;
  const request = projectInstalledEveEvent(authorizationRequired("old-auth"), 0)[0]?.request;
  if (state === undefined || request === undefined) {
    throw new Error("Expected a native checkpoint and original authorization");
  }
  state.pendingRequests = [request];
  onEvent.mockClear();
  onPrivateEvent.mockClear();
  starts.length = 0;
  return {
    fetcher,
    input,
    native,
    observe,
    onEvent,
    onPrivateEvent,
    owner,
    setPrefixFailure(value: typeof prefixFailure) {
      prefixFailure = value;
    },
    starts,
    state,
    verifyReadAuthority,
  };
};

it("reconciles old completion without replaying public history or private callbacks", async () => {
  const f = await authorizationFixture();
  f.state.currentTurnId = "retained-current-turn";
  const diagnostics = vi.spyOn(console, "info").mockImplementation(() => {});
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  const recorded = JSON.stringify(diagnostics.mock.calls);
  diagnostics.mockRestore();
  expect(recorded).not.toContain("https://consent.example/private-link");
  expect(recorded).not.toContain("retained-current-turn");
  expect(result.pendingRequests).toEqual([]);
  expect(result.status).toBe("waiting");
  expect(result.nativeObservationState).toMatchObject({
    boundary: f.state.boundary,
    nextNativeIndex: f.state.nextNativeIndex,
    publicEventCount: f.state.publicEventCount,
  });
  expect(result.nativeObservationState).toEqual({
    ...f.state,
    pendingRequests: [],
  });
  expect(f.starts).toEqual([0, 3]);
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.onPrivateEvent).not.toHaveBeenCalled();
  const persistedCheckpoint = JSON.stringify(result.nativeObservationState);
  expect(nativeObservationStateSchema.parse(JSON.parse(persistedCheckpoint))).toEqual(
    result.nativeObservationState,
  );
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  f.starts.length = 0;
  await f.observe({ ...f.input, nativeObservationState: result.nativeObservationState });
  expect(f.starts).toEqual([3]);
});

it.each(["short", "unavailable"] as const)(
  "retains the card and no marker after %s prefix",
  async (failure) => {
    const f = await authorizationFixture();
    f.setPrefixFailure(failure);
    const result = await f.observe({ ...f.input, nativeObservationState: f.state });
    expect(result.pendingRequests).toEqual(f.state.pendingRequests);
    expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
    expect(f.onPrivateEvent).not.toHaveBeenCalled();
    expect(f.onEvent).not.toHaveBeenCalled();
  },
);

it("validates the full pinned tail when a missing prefix is filled by newer events", async () => {
  const f = await authorizationFixture();
  f.native.push({ data: {}, type: "step.started" });
  f.setPrefixFailure("short");
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests).toEqual(f.state.pendingRequests);
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  expect(f.onPrivateEvent).toHaveBeenCalledTimes(1);
});

it.each(["wrong-attempt", "changed-request"])(
  "retains unmatched historical authorization for %s",
  async (mismatch) => {
    const f = await authorizationFixture();
    if (mismatch === "changed-request") {
      f.state.pendingRequests[0].title = "Different original request";
    } else {
      f.native[1] = authorizationCompleted("another");
    }
    const result = await f.observe({ ...f.input, nativeObservationState: f.state });
    expect(result.pendingRequests).toEqual(f.state.pendingRequests);
    expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  },
);

it("reconciles a stable attempt completed during a resumed turn", async () => {
  const f = await authorizationFixture();
  const completion = authorizationCompleted("old-auth");
  completion.data.turnId = "resumed-turn";
  f.native[1] = completion;
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests).toEqual([]);
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
});

it("ignores unrelated unmatched completion while settling the exact retained attempt", async () => {
  const f = await authorizationFixture();
  f.native[2] = authorizationCompleted("unrelated-attempt");
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests).toEqual([]);
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  expect(f.onEvent).not.toHaveBeenCalled();
  expect(f.onPrivateEvent).not.toHaveBeenCalled();
});

it("reconciles matching targets independently while retaining an ambiguous sibling", async () => {
  const f = await authorizationFixture();
  f.state.pendingRequests.push({
    allowFreeform: false,
    kind: "authorization",
    requestId: "unknown-sibling",
    title: "Keep this authorization",
  });
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests.map(({ requestId }) => requestId)).toEqual(["unknown-sibling"]);
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
});

it("rechecks original history while an authorization remains pending without persisting a marker", async () => {
  const f = await authorizationFixture();
  f.native[1] = authorizationCompleted("another-attempt");
  const first = await f.observe({ ...f.input, nativeObservationState: f.state });
  const second = await f.observe({
    ...f.input,
    nativeObservationState: first.nativeObservationState,
  });
  expect(second.pendingRequests).toEqual(f.state.pendingRequests);
  expect(f.starts).toEqual([0, 3, 0, 3]);
  expect(nativeObservationStateSchema.parse(second.nativeObservationState)).toEqual(
    second.nativeObservationState,
  );
  expect(second.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  expect(f.onPrivateEvent).not.toHaveBeenCalled();
  expect(f.onEvent).not.toHaveBeenCalled();
});

it("resumes new attempts and questions at the old native cursor", async () => {
  const f = await authorizationFixture();
  f.native.push(authorizationRequired("new-auth"), question("product-question"));
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests.map(({ requestId }) => requestId)).toEqual([
    "new-auth",
    "product-question",
  ]);
  expect(f.starts).toEqual([0, 3]);
  expect(result.publicEventCount).toBe(f.state.publicEventCount + 2);
  expect(f.onPrivateEvent).toHaveBeenCalledTimes(2);
  expect(f.onEvent).toHaveBeenCalledTimes(2);
});

it.each(["question", "approval"] as const)(
  "does not clear a %s whose ID matches an authorization completion",
  async (kind) => {
    const f = await authorizationFixture();
    f.state.pendingRequests = [
      { allowFreeform: kind === "question", kind, requestId: "old-auth", title: "Choose" },
    ];
    f.native.push(authorizationCompleted("old-auth"));
    const result = await f.observe({ ...f.input, nativeObservationState: f.state });
    expect(result.pendingRequests).toEqual(f.state.pendingRequests);
    expect(f.starts).toEqual([3]);
  },
);

it("keeps product questions and resource approvals while reconciling only old authorization", async () => {
  const f = await authorizationFixture();
  const questionRequest = {
    allowFreeform: true,
    kind: "question" as const,
    requestId: "product-question",
    title: "Choose",
  };
  const approvalRequest = {
    allowFreeform: false,
    kind: "approval" as const,
    requestId: "resource-approval",
    title: "Prepare Preview",
  };
  f.state.pendingRequests.push(questionRequest, approvalRequest);
  const result = await f.observe({ ...f.input, nativeObservationState: f.state });
  expect(result.pendingRequests).toEqual([questionRequest, approvalRequest]);
  expect(result.status).toBe("input_required");
  expect(result.nativeObservationState).not.toHaveProperty("authorizationCompletionsReconciled");
  expect(f.onPrivateEvent).not.toHaveBeenCalled();
  expect(f.onEvent).not.toHaveBeenCalled();
});

it("does not read native history for a different current owner", async () => {
  const f = await authorizationFixture();
  const count = f.fetcher.mock.calls.length;
  await expect(
    f.observe({
      ...f.input,
      nativeObservationState: f.state,
      principal: { ...f.owner, ownerUserId: "other" },
    }),
  ).rejects.toMatchObject({ code: "session_access_denied" });
  expect(f.fetcher).toHaveBeenCalledTimes(count);
});
/** Actual native transport/service; provider HTTP and paged storage are faithful local fixture ports. */
it.each([false, true])(
  "keeps native/public history correct with cold catch-up=%s",
  async (catchup) => {
    const principal: HostedPrincipal = {
      audience: "fixture",
      issuer: "https://identity.example",
      ownerUserId: "owner",
      scopes: Object.values(hostedEveOperationScopes),
      workspaceId: "workspace",
    };
    const native: unknown[] = [
      { data: {}, type: "session.started" },
      { data: {}, type: "session.waiting" },
    ];
    const starts: number[] = [];
    let stall = false;
    let deadlineController: AbortController | undefined;
    const transport = createSameOriginEveTransport({
      config: { baseUrl: "https://builder.example" },
      fetchImplementation: async (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        if (init?.method === "POST") {
          const requestText = z.string().parse(init.body);
          const body = z
            .looseObject({
              inputResponses: z.array(z.object({ requestId: z.string() })).optional(),
            })
            .parse(JSON.parse(requestText));
          if (body.inputResponses !== undefined) {
            expect(body).not.toHaveProperty("nativeObservationState");
            for (const answer of body.inputResponses) {
              native.push(resolved(answer.requestId));
            }
            native.push({ data: {}, type: "session.waiting" });
          }
          return Response.json(
            {
              deliveryId: "delivery_response",
              ok: true,
              sessionId: "wrun_fixture",
              status: "accepted",
            },
            { status: 202 },
          );
        }
        const start = Number(url.searchParams.get("startIndex"));
        starts.push(start);
        if (stall) {
          const bytes = new TextEncoder().encode(`${JSON.stringify(native[start])}\n`);
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(bytes);
              deadlineController?.signal.addEventListener(
                "abort",
                () => {
                  controller.error(deadlineController?.signal.reason);
                },
                { once: true },
              );
              setTimeout(
                () => deadlineController?.abort(new DOMException("deadline", "TimeoutError")),
                5,
              );
            },
          });
          return new Response(body, {
            headers: {
              "content-type": "application/x-ndjson",
              "x-eve-session-id": "wrun_fixture",
              "x-eve-stream-format": "ndjson",
              "x-eve-stream-tail-index": String(native.length - 1),
              "x-eve-stream-version": "25",
            },
          });
        }
        return await Promise.resolve(
          new Response(
            `${native
              .slice(start)
              .map((event) => JSON.stringify(event))
              .join("\n")}\n`,
            {
              headers: {
                "content-type": "application/x-ndjson",
                "x-eve-session-id": "wrun_fixture",
                "x-eve-stream-format": "ndjson",
                "x-eve-stream-tail-index": String(native.length - 1),
                "x-eve-stream-version": "25",
              },
            },
          ),
        );
      },
      verifyReadAuthority: async (input) =>
        await Promise.resolve(
          input.adapterSessionId === "wrun_fixture" &&
            tenantKeyFor(input.principal) === tenantKeyFor(principal),
        ),
      workloadIdentity: { token: async () => await Promise.resolve("local-fixture-token") },
    });
    const base = new InMemoryHostedEveStore();
    const initial = createHostedEveSessionService({ principal, store: base, transport });
    const started = await initial.start({ clientRequestId: randomUUID(), prompt: "Fixture" });
    let saved: HostedSessionRecord | null = null;
    let metadata: HostedPagedCheckpointMetadata | null = null;
    let events: PublicEveEvent[] = [];
    const store: HostedEveStore = {
      getSession: async (owner, sessionId) =>
        await Promise.resolve(
          tenantKeyFor(owner) === tenantKeyFor(principal)
            ? (saved ?? (await base.getSession(owner, sessionId)))
            : null,
        ),
      listSessions: base.listSessions.bind(base),
      observeSessionPaged: async (input) => {
        const previous = saved ?? (await base.getSession(principal, started.sessionId));
        if (
          previous?.version !== 2 ||
          previous.checkpointDigest !== input.expectedCheckpointDigest
        ) {
          throw new Error("checkpoint CAS mismatch");
        }
        const staged: PublicEveEvent[] = [];
        for await (const event of input.events) {
          expect(event.index).toBe(staged.length);
          staged.push(event);
        }
        if (input.metadata.nativeObservationState !== undefined) {
          expect(input.metadata.nativeObservationState.publicEventCount).toBe(staged.length);
        }
        events = staged;
        ({ metadata } = input);
        const { checkpoint: oldInline, ...rest } = previous;
        void oldInline;
        const digest = `sha256:${createHash("sha256").update(JSON.stringify({ events, metadata })).digest("hex")}`;
        saved = durableHostedSessionRecordSchema.parse({
          ...rest,
          checkpointDigest: digest,
          checkpointProgressDigest: digest,
          checkpointRef: { digest, eventCount: events.length, id: randomUUID() },
          resumability: input.resumability,
          stage: input.stage,
          status: input.metadata.status,
          updatedAtEpochMs: input.nowEpochMs,
        });
        return saved;
      },
      readCheckpointPage: async (input) => {
        if (
          saved?.version !== 2 ||
          saved.checkpointRef?.digest !== input.checkpointRef.digest ||
          metadata === null
        ) {
          throw new Error("checkpoint mismatch");
        }
        const page = events.slice(input.cursor, input.cursor + input.limit);
        return await Promise.resolve({
          checkpointDigest: input.checkpointRef.digest,
          cursor: input.cursor + page.length,
          events: page,
          metadata,
          totalEvents: events.length,
        });
      },
      reserveOperation: base.reserveOperation.bind(base),
      settleSucceeded: base.settleSucceeded.bind(base),
      settleUnsuccessful: base.settleUnsuccessful.bind(base),
    };
    const service = createHostedEveSessionService({ principal, store, transport });
    native.push(question("first"), resolved("first"), { data: {}, type: "session.waiting" });
    const cold = await service.get({ cursor: 0, limit: 100, sessionId: started.sessionId });
    expect(cold.error).toBeUndefined();
    expect(cold.status).toBe("waiting");
    expect(cold.inputRequests ?? []).toEqual([]);
    expect(cold.events.map((event) => event.index)).toEqual(cold.events.map((_, index) => index));
    const getMetadata = (): HostedPagedCheckpointMetadata | null => metadata;
    if (catchup) {
      const current = await store.getSession(principal, started.sessionId);
      const currentMetadata = getMetadata();
      if (current?.version !== 2 || currentMetadata === null) {
        throw new Error("Expected checkpoint");
      }
      const { nativeObservationState: oldNative, ...legacyMetadata } = currentMetadata;
      void oldNative;
      const oldEvents = [...events];
      const oldEventStream = async function* oldEventStream() {
        yield* oldEvents;
      };
      await store.observeSessionPaged?.({
        events: oldEventStream(),
        expectedCheckpointDigest: current.checkpointDigest,
        metadata: legacyMetadata,
        nowEpochMs: Date.now(),
        principal,
        resumability: current.resumability,
        sessionId: started.sessionId,
        stage: current.stage,
      });
      stall = true;
      deadlineController = new AbortController();
      const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(deadlineController.signal);
      try {
        const partial = await service.get({
          cursor: cold.cursor,
          limit: 100,
          sessionId: started.sessionId,
        });
        expect(partial.error?.code).toBe("session_read_delayed");
        expect(partial.inputRequests).toEqual([]);
        expect(events).toEqual(oldEvents);
        expect(getMetadata()?.coldReadProgress?.nativeObservationState.nextNativeIndex).toBe(1);
      } finally {
        timeout.mockRestore();
        stall = false;
      }
      const resumed = await service.get({
        cursor: cold.cursor,
        limit: 100,
        sessionId: started.sessionId,
      });
      expect(resumed.error).toBeUndefined();
      expect(events).toEqual(oldEvents);
      expect(getMetadata()?.coldReadProgress).toBeUndefined();
      expect(starts.slice(-2)).toEqual([0, 1]);
    }
    native.push(question("second"));
    const pending = await service.get({
      cursor: cold.cursor,
      limit: 100,
      sessionId: started.sessionId,
    });
    expect(pending.status).toBe("input_required");
    expect(pending.inputRequests?.map((request) => request.requestId)).toEqual(["second"]);
    const settlementStart = starts.length;
    const settled = await service.respond({
      clientRequestId: randomUUID(),
      responses: [{ requestId: "second", response: { kind: "answer", value: "isolated Preview" } }],
      sessionId: started.sessionId,
    });
    expect(settled.error).toBeUndefined();
    expect(settled.status).toBe("waiting");
    expect(settled.inputRequests ?? []).toEqual([]);
    expect(events.map((event) => event.index)).toEqual(events.map((_, index) => index));
    expect(events.some((event) => event.type === "input_required")).toBe(true);
    expect(starts.slice(settlementStart)).toEqual([6, 6, 6]);
  },
);
