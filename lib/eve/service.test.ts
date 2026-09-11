import { createHash } from "node:crypto";

import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";

import { createLocalEveSessionService, toEveInputResponse } from "./service";

describe("Eve input response mapping", () => {
  it("maps the public denial to Eve's cancel approval option", () => {
    expect(toEveInputResponse("request-1", { kind: "deny" })).toEqual({
      optionId: "cancel",
      requestId: "request-1",
    });
  });

  it("preserves approval and question answer shapes", () => {
    expect(toEveInputResponse("request-2", { kind: "approve" })).toEqual({
      optionId: "approve",
      requestId: "request-2",
    });
    expect(
      toEveInputResponse("request-3", {
        kind: "answer",
        value: "Freeform",
      })
    ).toEqual({ requestId: "request-3", text: "Freeform" });
    expect(
      toEveInputResponse("request-4", {
        kind: "answer",
        optionId: "choice-1",
        value: "ignored label",
      })
    ).toEqual({ optionId: "choice-1", requestId: "request-4" });
  });
});

describe("local Eve acceptance", () => {
  it("lists recent work and resumes the selected local session", async () => {
    const events = [
      { data: {}, type: "session.waiting" },
    ] as MessageStreamEvent[];
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      snapshot: vi.fn(async () => ({
        events,
        session: { sessionId: "wrun_recent", streamIndex: events.length },
      })),
      state: { sessionId: "wrun_recent" },
    };
    const service = createLocalEveSessionService(
      {
        sessions: {
          attach: vi.fn(() => session),
          create: vi.fn(async () => ({ session, response })),
        } as never,
      },
      { stateGeneration: "recent-list" }
    );
    const started = await service.start({
      clientRequestId: "recent-start",
      prompt: "Build a vendor workspace",
    });
    await vi.waitFor(async () => {
      await expect(
        service.list({ cursor: 0, limit: 10 })
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
        clientRequestId: "recent-resume",
        resumeSessionId: started.sessionId,
      })
    ).resolves.toMatchObject({ sessionId: started.sessionId });
  });

  it("continues at the durable tail after the response stream disconnects", async () => {
    const durableEvents = [
      {
        data: { turnId: "turn-recovery" },
        type: "step.completed",
      },
      { data: {}, type: "session.waiting" },
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
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      snapshot,
      state: { sessionId: "wrun_stream_recovery", streamIndex: 0 },
      stream: vi.fn(async function* () {
        yield durableEvents[1]!;
      }),
    };
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService(
      {
        sessions: {
          attach,
          create: vi.fn(async () => ({ session, response })),
        } as never,
      },
      { stateGeneration: "stream-recovery" }
    );
    const started = await service.start({
      clientRequestId: "stream-recovery-start",
      prompt: "Build",
    });

    await vi.waitFor(async () => {
      await expect(
        service.get({
          cursor: 0,
          limit: 100,
          sessionId: started.sessionId,
        })
      ).resolves.toMatchObject({ cursor: 2, status: "waiting" });
    });
    await expect(
      service.get({ cursor: 2, limit: 100, sessionId: started.sessionId })
    ).resolves.toMatchObject({ cursor: 2, events: [], status: "waiting" });
    expect(snapshot).not.toHaveBeenCalled();
    expect(attach).toHaveBeenLastCalledWith(started.sessionId, {
      streamIndex: 1,
    });
  });

  it("keeps buffered progress readable while a clean response close tails a live turn", async () => {
    let releaseTail!: () => void;
    const tailReady = new Promise<void>((resolve) => {
      releaseTail = resolve;
    });
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        yield {
          data: { turnId: "turn-clean-close" },
          type: "step.started",
        } as MessageStreamEvent;
      },
    };
    const snapshot = vi.fn(async () => {
      throw new Error("snapshot must not run for a live tail");
    });
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      snapshot,
      state: { sessionId: "wrun_clean_close", streamIndex: 0 },
      stream: vi.fn(async function* () {
        await tailReady;
        yield { type: "session.waiting", data: {} } as MessageStreamEvent;
      }),
    };
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService(
      {
        sessions: {
          attach,
          create: vi.fn(async () => ({ session, response })),
        } as never,
      },
      { stateGeneration: "clean-response-tail" }
    );
    const started = await service.start({
      clientRequestId: "clean-response-tail-start",
      prompt: "Build",
    });

    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({ cursor: 1, status: "working" });
    });
    expect(snapshot).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(started.sessionId, { streamIndex: 1 });

    releaseTail();
    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({ cursor: 2, status: "waiting" });
    });
    expect(snapshot).not.toHaveBeenCalled();
  });

  it("still bounds a model turn after its response iterator closes", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => {});
      const response = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        async *[Symbol.asyncIterator]() {
          yield {
            data: { turnId: "turn-closed-response" },
            type: "step.started",
          } as MessageStreamEvent;
        },
      };
      const session = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        respond: vi.fn(async () => response),
        send: vi.fn(async () => response),
        state: { sessionId: "wrun_closed_response", streamIndex: 0 },
        stream: vi.fn(async function* () {
          await never;
        }),
      };
      const service = createLocalEveSessionService(
        {
          sessions: {
            attach: vi.fn(() => session),
            create: vi.fn(async () => ({ session, response })),
          } as never,
        },
        { modelTurnTimeoutMs: 10, stateGeneration: "closed-response-timeout" }
      );
      const started = await service.start({
        clientRequestId: "closed-response-timeout-start",
        prompt: "Build",
      });

      await vi.advanceTimersByTimeAsync(10);
      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({
        error: { code: "model_turn_interrupted" },
        status: "waiting",
      });
      expect(session.cancel).toHaveBeenCalledWith({
        turnId: "turn-closed-response",
      });
      expect(response.cancel).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("preserves buffered settlement across a Next development module reload", async () => {
    const settledEvents = [
      {
        data: { message: "Your plan is ready.", turnId: "turn-reload" },
        type: "message.completed",
      },
      { data: {}, type: "session.waiting" },
    ] as unknown as MessageStreamEvent[];
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of settledEvents) {
          yield event;
        }
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      state: { sessionId: "wrun_module_reload" },
    };
    const stateGeneration = "one-development-invocation";
    const firstService = createLocalEveSessionService(
      {
        sessions: {
          attach: vi.fn(() => session),
          create: vi.fn(async () => ({ session, response })),
        } as never,
      },
      { stateGeneration }
    );
    const started = await firstService.start({
      clientRequestId: "module-reload-start",
      prompt: "Build",
    });
    await vi.waitFor(async () => {
      await expect(
        firstService.get({
          cursor: 0,
          limit: 100,
          sessionId: started.sessionId,
        })
      ).resolves.toMatchObject({ cursor: 2, status: "waiting" });
    });

    vi.resetModules();
    const reloaded = await import("./service");
    const reloadedService = reloaded.createLocalEveSessionService(
      {
        sessions: {
          attach: vi.fn(() => session),
          create: vi.fn(),
        } as never,
      },
      { stateGeneration }
    );

    await expect(
      reloadedService.get({
        cursor: 0,
        limit: 100,
        sessionId: started.sessionId,
      })
    ).resolves.toMatchObject({
      cursor: 2,
      events: expect.arrayContaining([
        expect.objectContaining({
          type: "assistant_message",
          text: "Your plan is ready.",
        }),
        expect.objectContaining({ type: "status", status: "waiting" }),
      ]),
      status: "waiting",
    });
    await expect(
      reloadedService.list({ cursor: 0, limit: 10 })
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
        yield { data: {}, type: "session.waiting" } as MessageStreamEvent;
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      state: { sessionId: "wrun_previous_cycle" },
    };
    const client = {
      sessions: {
        attach: vi.fn(() => session),
        create: vi.fn(async () => ({ session, response })),
      } as never,
    };
    const firstCycle = createLocalEveSessionService(client, {
      stateGeneration: "cycle-one",
    });
    const started = await firstCycle.start({
      clientRequestId: "previous-cycle-start",
      prompt: "Build",
    });
    await vi.waitFor(async () => {
      await expect(
        firstCycle.get({
          cursor: 0,
          limit: 100,
          sessionId: started.sessionId,
        })
      ).resolves.toMatchObject({ cursor: 1, status: "waiting" });
    });

    const nextCycle = createLocalEveSessionService(client, {
      stateGeneration: "cycle-two",
    });
    await expect(
      nextCycle.get({
        cursor: 0,
        limit: 100,
        sessionId: started.sessionId,
      })
    ).resolves.toEqual({
      cursor: 0,
      events: [],
      sessionId: started.sessionId,
      status: "working",
    });
  });

  it("makes an active local turn resumable after its Eve child restarts", async () => {
    let keepOldResponseOpen!: () => void;
    const oldResponse = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        yield {
          data: { turnId: "turn-before-restart" },
          type: "step.started",
        } as MessageStreamEvent;
        await new Promise<void>((resolve) => (keepOldResponseOpen = resolve));
      },
    };
    const resumedEvents = [
      { data: {}, type: "session.waiting" },
    ] as MessageStreamEvent[];
    const resumedResponse = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of resumedEvents) {
          yield event;
        }
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => resumedResponse),
      send: vi.fn(async () => resumedResponse),
      snapshot: vi.fn(async () => ({
        events: [
          {
            type: "step.started",
            data: { turnId: "turn-before-restart" },
          },
        ] as MessageStreamEvent[],
        session: { sessionId: "wrun_restart_interrupted", streamIndex: 1 },
      })),
      state: { sessionId: "wrun_restart_interrupted" },
    };
    const attach = vi.fn(() => session);
    const client = {
      sessions: {
        attach,
        create: vi.fn(async () => ({ session, response: oldResponse })),
      } as never,
    };
    const first = createLocalEveSessionService(client, {
      restartGeneration: "eve-child-one",
      stateGeneration: "one-local-invocation",
    });
    const started = await first.start({
      clientRequestId: "restart-interrupted-start",
      prompt: "Build",
    });
    await vi.waitFor(async () => {
      await expect(
        first.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({ cursor: 1, status: "working" });
    });

    const restarted = createLocalEveSessionService(client, {
      restartGeneration: "eve-child-two",
      stateGeneration: "one-local-invocation",
    });
    await expect(
      restarted.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
    ).resolves.toMatchObject({ cursor: 1, status: "waiting" });
    await expect(
      restarted.cancel({ sessionId: started.sessionId })
    ).resolves.toMatchObject({
      status: "waiting",
    });
    expect(session.cancel).not.toHaveBeenCalled();

    await restarted.send({
      clientRequestId: "restart-interrupted-send",
      message: "Continue from the last product decision.",
      sessionId: started.sessionId,
    });
    await vi.waitFor(async () => {
      await expect(
        restarted.get({
          cursor: 0,
          limit: 100,
          sessionId: started.sessionId,
        })
      ).resolves.toMatchObject({ cursor: 2, status: "waiting" });
    });
    expect(attach).toHaveBeenCalledWith(started.sessionId, {
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
      .update(JSON.stringify({ digest, mediaType, path }))
      .digest("hex");
    const events = [
      {
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
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "call_prototype",
            kind: "tool-result",
            output: {
              appId: "vendor-onboarding",
              digest,
              mediaType,
              path,
              recordedByCallId: "call_prototype",
              reused: false,
              revision,
              sessionId: "wrun_prototype",
              size: Buffer.byteLength(content),
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
      { data: {}, type: "session.waiting" },
    ] as unknown as MessageStreamEvent[];
    const response = (entries: MessageStreamEvent[]) => ({
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of entries) {
          yield event;
        }
      },
    });
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response([])),
      send: vi.fn(async () => response([])),
      state: { sessionId: "wrun_prototype" },
    };
    const service = createLocalEveSessionService({
      sessions: {
        attach: vi.fn(() => session),
        create: vi.fn(async () => ({ session, response: response(events) })),
      } as never,
    });
    const started = await service.start({
      clientRequestId: "prototype-start",
      prompt: "Build",
    });

    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 1, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({
        cursor: 1,
        events: [],
        prototype: { content, digest, mediaType, path, revision },
      });
    });
    await expect(
      service.send({
        clientRequestId: "prototype-send",
        message: "Continue",
        sessionId: started.sessionId,
      })
    ).resolves.toMatchObject({
      prototype: { content, digest, mediaType, path, revision },
      status: "working",
    });
  });

  it("hydrates a route-local preview from the durable Eve session", async () => {
    const content = "<!doctype html><html><body>Stock exceptions</body></html>";
    const path = "prototype/stock-exceptions/index.html";
    const mediaType = "text/html";
    const digest = createHash("sha256").update(content).digest("hex");
    const revision = createHash("sha256")
      .update(JSON.stringify({ digest, mediaType, path }))
      .digest("hex");
    const events = [
      {
        data: {
          actions: [
            {
              kind: "tool-call",
              callId: "call_route_prototype",
              toolName: "record_prototype_artifact",
              input: { path, mediaType, content },
            },
          ],
        },
        type: "actions.requested",
      },
      {
        data: {
          result: {
            callId: "call_route_prototype",
            kind: "tool-result",
            output: {
              appId: "stock-exceptions",
              digest,
              mediaType,
              path,
              recordedByCallId: "call_route_prototype",
              reused: false,
              revision,
              sessionId: "wrun_route_prototype",
              size: Buffer.byteLength(content),
            },
            toolName: "record_prototype_artifact",
          },
          status: "completed",
        },
        type: "action.result",
      },
      { data: {}, type: "session.waiting" },
    ] as unknown as MessageStreamEvent[];
    const snapshot = vi.fn(async () => ({
      events,
      session: {
        sessionId: "wrun_route_prototype",
        streamIndex: events.length,
      },
    }));
    const session = {
      snapshot,
      state: { sessionId: "wrun_route_prototype" },
    };
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService(
      { sessions: { attach } as never },
      { stateGeneration: "route-local-preview" }
    );

    await expect(
      service.get({
        cursor: 0,
        limit: 1,
        sessionId: "wrun_route_prototype",
      })
    ).resolves.toMatchObject({
      prototype: { content, digest, mediaType, path, revision },
      status: "waiting",
    });
    expect(snapshot).toHaveBeenCalledTimes(1);
    expect(attach).toHaveBeenLastCalledWith("wrun_route_prototype", {
      streamIndex: events.length,
    });
  });

  it("returns one stable public handle without waiting for the active turn", async () => {
    const never = new Promise<void>(() => {});
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        await never;
        yield {} as MessageStreamEvent;
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      state: { sessionId: "wrun_prompt_return" },
    };
    const create = vi.fn(async () => ({ response, session }));
    const attach = vi.fn(() => session);
    const service = createLocalEveSessionService({
      sessions: { attach, create } as never,
    });

    const first = await Promise.race([
      service.start({ clientRequestId: "prompt-return-1", prompt: "Build" }),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("start blocked")), 100)
      ),
    ]);
    const retry = await service.start({
      clientRequestId: "prompt-return-1",
      prompt: "Build",
    });

    expect(first).toEqual({
      cursor: 0,
      events: [],
      sessionId: "wrun_prompt_return",
      status: "working",
    });
    expect(retry).toEqual(first);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("cancels one stalled model turn and exposes a retryable paused result", async () => {
    vi.useFakeTimers();
    try {
      const never = new Promise<void>(() => {});
      const response = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        async *[Symbol.asyncIterator]() {
          yield {
            data: { turnId: "turn-model-stalled" },
            type: "step.started",
          } as MessageStreamEvent;
          await never;
        },
      };
      const durableEvents = [
        {
          data: { turnId: "turn-model-stalled" },
          type: "step.started",
        },
      ] as MessageStreamEvent[];
      const session = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        respond: vi.fn(async () => response),
        send: vi.fn(async () => response),
        snapshot: vi.fn(async () => ({
          events: durableEvents,
          session: {
            sessionId: "wrun_model_stalled",
            streamIndex: durableEvents.length,
          },
        })),
        state: { sessionId: "wrun_model_stalled" },
      };
      const service = createLocalEveSessionService(
        {
          sessions: {
            attach: vi.fn(() => session),
            create: vi.fn(async () => ({ session, response })),
          } as never,
        },
        { modelTurnTimeoutMs: 10, stateGeneration: "model-turn-timeout" }
      );

      const started = await service.start({
        clientRequestId: "model-turn-timeout-start",
        prompt: "Build",
      });
      await vi.advanceTimersByTimeAsync(10);
      await Promise.resolve();

      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({
        error: {
          code: "model_turn_interrupted",
          message:
            "Autograph paused because a response took too long. Your progress is saved; try again in a moment.",
        },
        status: "waiting",
      });
      await expect(
        service.send({
          clientRequestId: "model-turn-timeout-retry",
          message: "Continue",
          sessionId: started.sessionId,
        })
      ).rejects.toThrow("previous Autograph response is still settling");
      expect(session.cancel).toHaveBeenCalledWith({
        turnId: "turn-model-stalled",
      });
      expect(response.cancel).not.toHaveBeenCalled();
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
            data: { turnId: "turn-model-healthy" },
            type: "step.started",
          } as MessageStreamEvent;
          yield { data: {}, type: "session.waiting" } as MessageStreamEvent;
        },
      };
      const session = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        respond: vi.fn(async () => response),
        send: vi.fn(async () => response),
        state: { sessionId: "wrun_model_healthy" },
      };
      const service = createLocalEveSessionService(
        {
          sessions: {
            attach: vi.fn(() => session),
            create: vi.fn(async () => ({ session, response })),
          } as never,
        },
        { modelTurnTimeoutMs: 10, stateGeneration: "model-turn-healthy" }
      );
      const started = await service.start({
        clientRequestId: "model-turn-healthy-start",
        prompt: "Build",
      });
      await vi.advanceTimersByTimeAsync(10);

      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
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
          data: { turnId: "turn-1" },
          type: "step.started",
        } as MessageStreamEvent;
        await cancelled;
        yield {
          data: { turnId: "turn-1" },
          type: "turn.cancelled",
        } as MessageStreamEvent;
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      state: { sessionId: "wrun_lifecycle" },
    };
    const service = createLocalEveSessionService({
      sessions: {
        attach: vi.fn(() => session),
        create: vi.fn(async () => ({ session, response })),
      } as never,
    });
    const start = await service.start({
      clientRequestId: "prompt-lifecycle-1",
      prompt: "Build",
    });
    await expect(
      service.get({ cursor: 0, limit: 100, sessionId: start.sessionId })
    ).resolves.toMatchObject({ sessionId: start.sessionId });
    await expect(
      service.send({
        clientRequestId: "prompt-lifecycle-2",
        message: "Continue",
        sessionId: start.sessionId,
      })
    ).resolves.toMatchObject({ status: "working" });
    await expect(
      service.respond({
        clientRequestId: "prompt-lifecycle-3",
        responses: [{ requestId: "request-1", response: { kind: "approve" } }],
        sessionId: start.sessionId,
      })
    ).rejects.toThrow("complete outstanding Eve input batch");
    await expect(
      service.cancel({ sessionId: start.sessionId })
    ).resolves.toMatchObject({ sessionId: start.sessionId });
    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: start.sessionId })
      ).resolves.toMatchObject({
        events: expect.arrayContaining([
          expect.objectContaining({ type: "status", status: "cancelled" }),
        ]),
        status: "cancelled",
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
      const never = new Promise<void>(() => {});
      const response = {
        cancel: vi.fn(() => never),
        async *[Symbol.asyncIterator]() {
          yield {
            data: { turnId: "turn-cancel-timeout" },
            type: "step.started",
          } as MessageStreamEvent;
          await never;
        },
      };
      const session = {
        cancel: vi.fn(async () => ({ status: "accepted" })),
        respond: vi.fn(async () => response),
        send: vi.fn(async () => response),
        state: { sessionId: "wrun_cancel_timeout" },
      };
      const service = createLocalEveSessionService({
        sessions: {
          attach: vi.fn(() => session),
          create: vi.fn(async () => ({ session, response })),
        } as never,
      });
      const started = await service.start({
        clientRequestId: "cancel-timeout-start",
        prompt: "Build",
      });

      const cancellation = service.cancel({ sessionId: started.sessionId });
      const expectedCancellation = expect(cancellation).rejects.toThrow(
        "Cancellation was accepted"
      );
      await vi.advanceTimersByTimeAsync(5000);
      await expectedCancellation;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the retained session for an explicit turn cancellation", async () => {
    const response = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => {});
        yield {} as MessageStreamEvent;
      },
    };
    const session = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => response),
      send: vi.fn(async () => response),
      state: { sessionId: "wrun_exact_turn" },
    };
    const service = createLocalEveSessionService({
      sessions: {
        attach: vi.fn(() => session),
        create: vi.fn(async () => ({ session, response })),
      } as never,
    });
    const start = await service.start({
      clientRequestId: "prompt-turn-cancel",
      prompt: "Build",
    });
    await service.cancel({ sessionId: start.sessionId, turnId: "turn-7" });
    expect(session.cancel).toHaveBeenCalledWith({ turnId: "turn-7" });
    expect(response.cancel).not.toHaveBeenCalled();
  });

  it("rebinds follow-up and response streams at the exact buffered raw tail", async () => {
    const stream = (events: MessageStreamEvent[]) => ({
      cancel: vi.fn(async () => ({ status: "accepted" })),
      async *[Symbol.asyncIterator]() {
        for (const event of events) {
          yield event;
        }
      },
    });
    const initial = stream([
      { data: {}, type: "session.waiting" } as MessageStreamEvent,
    ]);
    const followUp = stream([
      {
        data: {
          requests: ["request-source", "request-plan", "request-preview"].map(
            (requestId) => ({
              requestId,
              kind: "tool-approval",
              prompt: requestId,
            })
          ),
          turnId: "turn-follow-up",
        },
        type: "input.requested",
      } as unknown as MessageStreamEvent,
    ]);
    const responded = stream([
      {
        data: {
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
          turnId: "turn-follow-up",
        },
        type: "input.resolved",
      } as unknown as MessageStreamEvent,
      {
        data: { turnId: "turn-follow-up" },
        type: "step.completed",
      } as MessageStreamEvent,
      { data: {}, type: "session.waiting" } as MessageStreamEvent,
    ]);
    const rebound = {
      cancel: vi.fn(async () => ({ status: "accepted" })),
      respond: vi.fn(async () => responded),
      send: vi.fn(async () => followUp),
      state: { sessionId: "wrun_rebound" },
    };
    const created = { ...rebound };
    const attach = vi.fn(() => rebound);
    const service = createLocalEveSessionService({
      sessions: {
        attach,
        create: vi.fn(async () => ({ session: created, response: initial })),
      } as never,
    });
    const started = await service.start({
      clientRequestId: "rebind-start",
      prompt: "Build",
    });
    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 0, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({ cursor: 1, status: "waiting" });
    });

    await service.send({
      clientRequestId: "rebind-send",
      message: "Use the source",
      sessionId: started.sessionId,
    });
    expect(attach).toHaveBeenNthCalledWith(1, started.sessionId, {
      streamIndex: 1,
    });
    await vi.waitFor(async () => {
      await expect(
        service.get({ cursor: 1, limit: 100, sessionId: started.sessionId })
      ).resolves.toMatchObject({
        cursor: 4,
        inputRequests: expect.arrayContaining([
          expect.objectContaining({ requestId: "request-source" }),
          expect.objectContaining({ requestId: "request-plan" }),
          expect.objectContaining({ requestId: "request-preview" }),
        ]),
        status: "input_required",
      });
    });

    await service.respond({
      clientRequestId: "rebind-respond",
      responses: [
        { requestId: "request-source", response: { kind: "approve" } },
        { requestId: "request-plan", response: { kind: "approve" } },
        { requestId: "request-preview", response: { kind: "approve" } },
      ],
      sessionId: started.sessionId,
    });
    expect(attach).toHaveBeenNthCalledWith(2, started.sessionId, {
      streamIndex: 2,
    });
    await vi.waitFor(async () => {
      const result = await service.get({
        cursor: 0,
        limit: 100,
        sessionId: started.sessionId,
      });
      expect(result.cursor).toBe(6);
      expect(result.status).toBe("waiting");
      expect(result.inputRequests).toBeUndefined();
      expect(
        result.events.filter(
          (event) => event.type === "status" && event.status === "waiting"
        )
      ).toHaveLength(2);
      expect(result.events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            request: expect.objectContaining({ requestId: "request-source" }),
            type: "input_required",
          }),
        ])
      );
    });
    expect(rebound.respond).toHaveBeenCalledWith([
      { optionId: "approve", requestId: "request-source" },
      { optionId: "approve", requestId: "request-plan" },
      { optionId: "approve", requestId: "request-preview" },
    ]);
  });
});
