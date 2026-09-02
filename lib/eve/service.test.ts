import { createHash } from "node:crypto";

import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";

import { createLocalEveSessionService, toEveInputResponse } from "./service";

describe("Eve input response mapping", () => {
  it("maps the public denial to Eve's cancel approval option", () => {
    expect(toEveInputResponse("request-1", { kind: "deny" })).toEqual({
      requestId: "request-1",
      optionId: "cancel",
    });
  });

  it("preserves approval and question answer shapes", () => {
    expect(toEveInputResponse("request-2", { kind: "approve" })).toEqual({
      requestId: "request-2",
      optionId: "approve",
    });
    expect(
      toEveInputResponse("request-3", {
        kind: "answer",
        value: "Freeform",
      }),
    ).toEqual({ requestId: "request-3", text: "Freeform" });
    expect(
      toEveInputResponse("request-4", {
        kind: "answer",
        value: "ignored label",
        optionId: "choice-1",
      }),
    ).toEqual({ requestId: "request-4", optionId: "choice-1" });
  });
});

describe("local Eve acceptance", () => {
  it("lists recent work and resumes the selected local session", async () => {
    const events = [
      { type: "session.waiting", data: {} },
    ] as MessageStreamEvent[];
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    };
    const session = {
      state: { sessionId: "wrun_recent" },
      snapshot: vi.fn(async () => ({
        events,
        session: { sessionId: "wrun_recent", streamIndex: events.length },
      })),
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: vi.fn(async () => ({ session, response })),
          attach: vi.fn(() => session),
        } as never,
      },
      { stateGeneration: "recent-list" },
    );
    const started = await service.start({
      prompt: "Build a vendor workspace",
      clientRequestId: "recent-start",
    });
    await vi.waitFor(async () => {
      await expect(
        service.list({ cursor: 0, limit: 10 }),
      ).resolves.toMatchObject({
        sessions: [
          {
            sessionId: started.sessionId,
            title: "Build a vendor workspace",
          },
        ],
      });
    });
    await expect(
      service.start({
        resumeSessionId: started.sessionId,
        clientRequestId: "recent-resume",
      }),
    ).resolves.toMatchObject({ sessionId: started.sessionId });
  });

  it("recovers a durable waiting boundary after the response stream disconnects", async () => {
    const durableEvents = [
      {
        type: "step.completed",
        data: { turnId: "turn-recovery" },
      },
      { type: "session.waiting", data: {} },
    ] as MessageStreamEvent[];
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        yield durableEvents[0]!;
        throw new Error("connection lost before the durable tail");
      },
    };
    const snapshot = vi.fn(async () => ({
      events: durableEvents,
      session: { sessionId: "wrun_stream_recovery", streamIndex: 2 },
    }));
    const session = {
      state: { sessionId: "wrun_stream_recovery", streamIndex: 0 },
      snapshot,
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService(
      {
        sessions: {
          create: vi.fn(async () => ({ session, response })),
          attach,
        } as never,
      },
      { stateGeneration: "stream-recovery" },
    );
    const started = await service.start({
      prompt: "Build",
      clientRequestId: "stream-recovery-start",
    });

    await vi.waitFor(async () => {
      await expect(
        service.get({
          sessionId: started.sessionId,
          cursor: 0,
          limit: 100,
        }),
      ).resolves.toMatchObject({ status: "waiting", cursor: 2 });
    });
    await expect(
      service.get({ sessionId: started.sessionId, cursor: 2, limit: 100 }),
    ).resolves.toMatchObject({ status: "waiting", cursor: 2, events: [] });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenLastCalledWith(started.sessionId, {
      streamIndex: 2,
    });
  });

  it("preserves buffered settlement across a Next development module reload", async () => {
    const settledEvents = [
      {
        type: "message.completed",
        data: { turnId: "turn-reload", message: "Your plan is ready." },
      },
      { type: "session.waiting", data: {} },
    ] as unknown as MessageStreamEvent[];
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of settledEvents) yield event;
      },
    };
    const session = {
      state: { sessionId: "wrun_module_reload" },
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const stateGeneration = "one-development-invocation";
    const firstService = createLocalEveSessionService(
      {
        sessions: {
          create: vi.fn(async () => ({ session, response })),
          attach: vi.fn(() => session),
        } as never,
      },
      { stateGeneration },
    );
    const started = await firstService.start({
      prompt: "Build",
      clientRequestId: "module-reload-start",
    });
    await vi.waitFor(async () => {
      await expect(
        firstService.get({
          sessionId: started.sessionId,
          cursor: 0,
          limit: 100,
        }),
      ).resolves.toMatchObject({ status: "waiting", cursor: 2 });
    });

    vi.resetModules();
    const reloaded = await import("./service");
    const reloadedService = reloaded.createLocalEveSessionService(
      {
        sessions: {
          create: vi.fn(),
          attach: vi.fn(() => session),
        } as never,
      },
      { stateGeneration },
    );

    await expect(
      reloadedService.get({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toMatchObject({
      status: "waiting",
      cursor: 2,
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_message",
          text: "Your plan is ready.",
        }),
        expect.objectContaining({ type: "status", status: "waiting" }),
      ]),
    });
    await expect(
      reloadedService.list({ cursor: 0, limit: 10 }),
    ).resolves.toMatchObject({
      sessions: [
        expect.objectContaining({
          sessionId: started.sessionId,
          title: "Build",
        }),
      ],
    });
  });

  it("does not preserve sessions across fresh Eve cycle generations", async () => {
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        yield { type: "session.waiting", data: {} } as MessageStreamEvent;
      },
    };
    const session = {
      state: { sessionId: "wrun_previous_cycle" },
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const client = {
      sessions: {
        create: vi.fn(async () => ({ session, response })),
        attach: vi.fn(() => session),
      } as never,
    };
    const firstCycle = createLocalEveSessionService(client, {
      stateGeneration: "cycle-one",
    });
    const started = await firstCycle.start({
      prompt: "Build",
      clientRequestId: "previous-cycle-start",
    });
    await vi.waitFor(async () => {
      await expect(
        firstCycle.get({
          sessionId: started.sessionId,
          cursor: 0,
          limit: 100,
        }),
      ).resolves.toMatchObject({ status: "waiting", cursor: 1 });
    });

    const nextCycle = createLocalEveSessionService(client, {
      stateGeneration: "cycle-two",
    });
    await expect(
      nextCycle.get({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 100,
      }),
    ).resolves.toEqual({
      sessionId: started.sessionId,
      status: "working",
      cursor: 0,
      events: [],
    });
  });

  it("makes an active local turn resumable after its Eve child restarts", async () => {
    let keepOldResponseOpen!: () => void;
    const oldResponse = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        yield {
          type: "step.started",
          data: { turnId: "turn-before-restart" },
        } as MessageStreamEvent;
        await new Promise<void>((resolve) => (keepOldResponseOpen = resolve));
      },
    };
    const resumedEvents = [
      { type: "session.waiting", data: {} },
    ] as MessageStreamEvent[];
    const resumedResponse = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of resumedEvents) yield event;
      },
    };
    const session = {
      state: { sessionId: "wrun_restart_interrupted" },
      snapshot: vi.fn(async () => ({
        events: [
          {
            type: "step.started",
            data: { turnId: "turn-before-restart" },
          },
        ] as MessageStreamEvent[],
        session: { sessionId: "wrun_restart_interrupted", streamIndex: 1 },
      })),
      send: vi.fn(async () => resumedResponse),
      respond: vi.fn(async () => resumedResponse),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const client = {
      sessions: {
        create: vi.fn(async () => ({ session, response: oldResponse })),
        attach: vi.fn(() => session),
      } as never,
    };
    const first = createLocalEveSessionService(client, {
      stateGeneration: "one-local-invocation",
      restartGeneration: "eve-child-one",
    });
    const started = await first.start({
      prompt: "Build",
      clientRequestId: "restart-interrupted-start",
    });
    await vi.waitFor(async () => {
      await expect(
        first.get({ sessionId: started.sessionId, cursor: 0, limit: 100 }),
      ).resolves.toMatchObject({ status: "working", cursor: 1 });
    });

    const restarted = createLocalEveSessionService(client, {
      stateGeneration: "one-local-invocation",
      restartGeneration: "eve-child-two",
    });
    await expect(
      restarted.get({ sessionId: started.sessionId, cursor: 0, limit: 100 }),
    ).resolves.toMatchObject({ status: "waiting", cursor: 1 });
    await expect(restarted.cancel({ sessionId: started.sessionId })).resolves.toMatchObject({
      status: "waiting",
    });
    expect(session.cancel).not.toHaveBeenCalled();

    await restarted.send({
      sessionId: started.sessionId,
      message: "Continue from the last product decision.",
      clientRequestId: "restart-interrupted-send",
    });
    await vi.waitFor(async () => {
      await expect(
        restarted.get({
          sessionId: started.sessionId,
          cursor: 0,
          limit: 100,
        }),
      ).resolves.toMatchObject({ status: "waiting", cursor: 2 });
    });
    expect(client.sessions.attach).toHaveBeenCalledWith(started.sessionId, {
      streamIndex: 1,
    });
    expect(session.snapshot).toHaveBeenCalledTimes(1);
    keepOldResponseOpen();
  });

  it("keeps a verified prototype on cursor-at-tail and accepted follow-ups", async () => {
    const content = "<!doctype html><html><body>Vendor queue</body></html>";
    const path = "prototype/vendor-onboarding/index.html";
    const mediaType = "text/html";
    const digest = createHash("sha256").update(content).digest("hex");
    const revision = createHash("sha256")
      .update(JSON.stringify({ path, mediaType, digest }))
      .digest("hex");
    const events = [
      {
        type: "actions.requested",
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "call_prototype",
              toolName: "record_prototype_artifact",
              input: { path, mediaType, content },
            },
          ],
        },
      },
      {
        type: "action.result",
        data: {
          status: "completed",
          result: {
            kind: "tool-result",
            callId: "call_prototype",
            toolName: "record_prototype_artifact",
            output: {
              appId: "vendor-onboarding",
              path,
              mediaType,
              digest,
              revision,
              sessionId: "wrun_prototype",
              recordedByCallId: "call_prototype",
              size: Buffer.byteLength(content),
              reused: false,
            },
          },
        },
      },
      { type: "session.waiting", data: {} },
    ] as unknown as MessageStreamEvent[];
    const response = (entries: MessageStreamEvent[]) => ({
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of entries) yield event;
      },
    });
    const session = {
      state: { sessionId: "wrun_prototype" },
      send: vi.fn(async () => response([])),
      respond: vi.fn(async () => response([])),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const service = createLocalEveSessionService({
      sessions: {
        create: vi.fn(async () => ({ session, response: response(events) })),
        attach: vi.fn(() => session),
      } as never,
    });
    const started = await service.start({
      prompt: "Build",
      clientRequestId: "prototype-start",
    });

    await vi.waitFor(async () => {
      await expect(
        service.get({ sessionId: started.sessionId, cursor: 1, limit: 100 }),
      ).resolves.toMatchObject({
        cursor: 1,
        events: [],
        prototype: { path, mediaType, content, digest, revision },
      });
    });
    await expect(
      service.send({
        sessionId: started.sessionId,
        message: "Continue",
        clientRequestId: "prototype-send",
      }),
    ).resolves.toMatchObject({
      status: "working",
      prototype: { path, mediaType, content, digest, revision },
    });
  });

  it("returns one stable public handle without waiting for the active turn", async () => {
    const never = new Promise<void>(() => undefined);
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        await never;
        yield {} as MessageStreamEvent;
      },
    };
    const session = {
      state: { sessionId: "wrun_prompt_return" },
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const create = vi.fn(async () => ({ session, response }));
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService({
      sessions: { create, attach } as never,
    });

    const first = await Promise.race([
      service.start({ prompt: "Build", clientRequestId: "prompt-return-1" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("start blocked")), 100),
      ),
    ]);
    const retry = await service.start({
      prompt: "Build",
      clientRequestId: "prompt-return-1",
    });

    expect(first).toEqual({
      sessionId: "wrun_prompt_return",
      status: "working",
      cursor: 0,
      events: [],
    });
    expect(retry).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("cancels one stalled model turn and exposes a retryable paused result", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const response = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        async *[Symbol.asyncIterator]() {
          yield {
            type: "step.started",
            data: { turnId: "turn-model-stalled" },
          } as MessageStreamEvent;
          await never;
        },
      };
      const durableEvents = [
        {
          type: "step.started",
          data: { turnId: "turn-model-stalled" },
        },
      ] as MessageStreamEvent[];
      const session = {
        state: { sessionId: "wrun_model_stalled" },
        snapshot: vi.fn(async () => ({
          events: durableEvents,
          session: {
            sessionId: "wrun_model_stalled",
            streamIndex: durableEvents.length,
          },
        })),
        send: vi.fn(async () => response),
        respond: vi.fn(async () => response),
        cancel: vi.fn(async () => ({ status: "accepted" })),
      };
      const service = createLocalEveSessionService(
        {
          sessions: {
            create: vi.fn(async () => ({ session, response })),
            attach: vi.fn(() => session),
          } as never,
        },
        { stateGeneration: "model-turn-timeout", modelTurnTimeoutMs: 10 },
      );

      const started = await service.start({
        prompt: "Build",
        clientRequestId: "model-turn-timeout-start",
      });
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      await expect(
        service.get({ sessionId: started.sessionId, cursor: 0, limit: 100 }),
      ).resolves.toMatchObject({
        status: "waiting",
        error: {
          code: "model_turn_interrupted",
          message:
            "Autograph paused because a response took too long. Your progress is saved; try again in a moment.",
        },
      });
      await expect(
        service.send({
          sessionId: started.sessionId,
          message: "Continue",
          clientRequestId: "model-turn-timeout-retry",
        }),
      ).rejects.toThrow("previous Autograph response is still settling");
      expect(response.cancel).toHaveBeenCalledTimes(1);
      expect(session.send).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not cancel a model turn that reaches its normal waiting boundary", async () => {
    vi.useFakeTimers();
    try {
      const response = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        async *[Symbol.asyncIterator]() {
          yield {
            type: "step.started",
            data: { turnId: "turn-model-healthy" },
          } as MessageStreamEvent;
          yield { type: "session.waiting", data: {} } as MessageStreamEvent;
        },
      };
      const session = {
        state: { sessionId: "wrun_model_healthy" },
        send: vi.fn(async () => response),
        respond: vi.fn(async () => response),
        cancel: vi.fn(async () => ({ status: "accepted" })),
      };
      const service = createLocalEveSessionService(
        {
          sessions: {
            create: vi.fn(async () => ({ session, response })),
            attach: vi.fn(() => session),
          } as never,
        },
        { stateGeneration: "model-turn-healthy", modelTurnTimeoutMs: 10 },
      );
      const started = await service.start({
        prompt: "Build",
        clientRequestId: "model-turn-healthy-start",
      });
      await vi.advanceTimersByTimeAsync(10);

      await expect(
        service.get({ sessionId: started.sessionId, cursor: 0, limit: 100 }),
      ).resolves.toMatchObject({ status: "waiting" });
      expect(response.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps get, send, and cancel independent while rejecting a non-outstanding response", async () => {
    let publishCancellation!: () => void;
    const cancelled = new Promise<void>((resolve) => {
      publishCancellation = resolve;
    });
    const response = {
      cancel: vi.fn(async () => {
        publishCancellation();
        return { status: "accepted" };
      }),
      async *[Symbol.asyncIterator]() {
        yield {
          type: "step.started",
          data: { turnId: "turn-1" },
        } as MessageStreamEvent;
        await cancelled;
        yield {
          type: "turn.cancelled",
          data: { turnId: "turn-1" },
        } as MessageStreamEvent;
      },
    };
    const session = {
      state: { sessionId: "wrun_lifecycle" },
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const service = createLocalEveSessionService({
      sessions: {
        create: vi.fn(async () => ({ session, response })),
        attach: vi.fn(() => session),
      } as never,
    });
    const start = await service.start({
      prompt: "Build",
      clientRequestId: "prompt-lifecycle-1",
    });
    await expect(
      service.get({ sessionId: start.sessionId, cursor: 0, limit: 100 }),
    ).resolves.toMatchObject({ sessionId: start.sessionId });
    await expect(
      service.send({
        sessionId: start.sessionId,
        message: "Continue",
        clientRequestId: "prompt-lifecycle-2",
      }),
    ).resolves.toMatchObject({ status: "working" });
    await expect(
      service.respond({
        sessionId: start.sessionId,
        responses: [{ requestId: "request-1", response: { kind: "approve" } }],
        clientRequestId: "prompt-lifecycle-3",
      }),
    ).rejects.toThrow("complete outstanding Eve input batch");
    await expect(
      service.cancel({ sessionId: start.sessionId }),
    ).resolves.toMatchObject({ sessionId: start.sessionId });
    await vi.waitFor(async () => {
      await expect(
        service.get({ sessionId: start.sessionId, cursor: 0, limit: 100 }),
      ).resolves.toMatchObject({
        status: "cancelled",
        events: expect.arrayContaining([
          expect.objectContaining({ type: "status", status: "cancelled" }),
        ]),
      });
    });
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.respond).not.toHaveBeenCalled();
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(session.cancel).not.toHaveBeenCalled();
  });

  it("bounds a local cancel when the current Eve response cannot settle", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => undefined);
      const response = {
        cancel: vi.fn(() => never),
        async *[Symbol.asyncIterator]() {
          yield {
            type: "step.started",
            data: { turnId: "turn-cancel-timeout" },
          } as MessageStreamEvent;
          await never;
        },
      };
      const session = {
        state: { sessionId: "wrun_cancel_timeout" },
        send: vi.fn(async () => response),
        respond: vi.fn(async () => response),
        cancel: vi.fn(async () => ({ status: "accepted" })),
      };
      const service = createLocalEveSessionService({
        sessions: {
          create: vi.fn(async () => ({ session, response })),
          attach: vi.fn(() => session),
        } as never,
      });
      const started = await service.start({
        prompt: "Build",
        clientRequestId: "cancel-timeout-start",
      });

      const cancellation = service.cancel({ sessionId: started.sessionId });
      const expectedCancellation = expect(cancellation).rejects.toThrow(
        "Cancellation was accepted",
      );
      await vi.advanceTimersByTimeAsync(5_000);
      await expectedCancellation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the retained session for an explicit turn cancellation", async () => {
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => undefined);
        yield {} as MessageStreamEvent;
      },
    };
    const session = {
      state: { sessionId: "wrun_exact_turn" },
      send: vi.fn(async () => response),
      respond: vi.fn(async () => response),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const service = createLocalEveSessionService({
      sessions: {
        create: vi.fn(async () => ({ session, response })),
        attach: vi.fn(() => session),
      } as never,
    });
    const start = await service.start({
      prompt: "Build",
      clientRequestId: "prompt-turn-cancel",
    });
    await service.cancel({ sessionId: start.sessionId, turnId: "turn-7" });
    expect(session.cancel).toHaveBeenCalledWith({ turnId: "turn-7" });
    expect(response.cancel).not.toHaveBeenCalled();
  });

  it("rebinds follow-up and response streams at the exact buffered raw tail", async () => {
    const stream = (events: MessageStreamEvent[]) => ({
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of events) yield event;
      },
    });
    const initial = stream([
      { type: "session.waiting", data: {} } as MessageStreamEvent,
    ]);
    const followUp = stream([
      {
        type: "input.requested",
        data: {
          turnId: "turn-follow-up",
          requests: ["request-source", "request-plan", "request-preview"].map(
            (requestId) => ({
              requestId,
              kind: "tool-approval",
              prompt: requestId,
            }),
          ),
        },
      } as unknown as MessageStreamEvent,
    ]);
    const responded = stream([
      {
        type: "input.resolved",
        data: {
          turnId: "turn-follow-up",
          resolutions: [
            "request-source",
            "request-plan",
            "request-preview",
          ].map((requestId) => ({
            requestId,
            kind: "tool-approval",
            outcome: "approved",
            response: { requestId, optionId: "approve" },
          })),
        },
      } as unknown as MessageStreamEvent,
      {
        type: "step.completed",
        data: { turnId: "turn-follow-up" },
      } as MessageStreamEvent,
      { type: "session.waiting", data: {} } as MessageStreamEvent,
    ]);
    const rebound = {
      state: { sessionId: "wrun_rebound" },
      send: vi.fn(async () => followUp),
      respond: vi.fn(async () => responded),
      cancel: vi.fn(async () => ({ status: "accepted" })),
    };
    const created = { ...rebound };
    const attach = vi.fn(() => rebound);
    const service = createLocalEveSessionService({
      sessions: {
        create: vi.fn(async () => ({ session: created, response: initial })),
        attach,
      } as never,
    });
    const started = await service.start({
      prompt: "Build",
      clientRequestId: "rebind-start",
    });
    await vi.waitFor(async () => {
      await expect(
        service.get({ sessionId: started.sessionId, cursor: 0, limit: 100 }),
      ).resolves.toMatchObject({ cursor: 1, status: "waiting" });
    });

    await service.send({
      sessionId: started.sessionId,
      message: "Use the source",
      clientRequestId: "rebind-send",
    });
    expect(attach).toHaveBeenNthCalledWith(1, started.sessionId, {
      streamIndex: 1,
    });
    await vi.waitFor(async () => {
      await expect(
        service.get({ sessionId: started.sessionId, cursor: 1, limit: 100 }),
      ).resolves.toMatchObject({
        cursor: 4,
        status: "input_required",
        inputRequests: expect.arrayContaining([
          expect.objectContaining({ requestId: "request-source" }),
          expect.objectContaining({ requestId: "request-plan" }),
          expect.objectContaining({ requestId: "request-preview" }),
        ]),
      });
    });

    await service.respond({
      sessionId: started.sessionId,
      responses: [
        { requestId: "request-source", response: { kind: "approve" } },
        { requestId: "request-plan", response: { kind: "approve" } },
        { requestId: "request-preview", response: { kind: "approve" } },
      ],
      clientRequestId: "rebind-respond",
    });
    expect(attach).toHaveBeenNthCalledWith(2, started.sessionId, {
      streamIndex: 2,
    });
    await vi.waitFor(async () => {
      const result = await service.get({
        sessionId: started.sessionId,
        cursor: 0,
        limit: 100,
      });
      expect(result.cursor).toBe(6);
      expect(result.status).toBe("waiting");
      expect(result.inputRequests).toBeUndefined();
      expect(
        result.events.filter(
          (event) => event.type === "status" && event.status === "waiting",
        ),
      ).toHaveLength(2);
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: "input_required",
            request: expect.objectContaining({ requestId: "request-source" }),
          }),
        ]),
      );
    });
    expect(rebound.respond).toHaveBeenCalledWith([
      { requestId: "request-source", optionId: "approve" },
      { requestId: "request-plan", optionId: "approve" },
      { requestId: "request-preview", optionId: "approve" },
    ]);
  });
});
