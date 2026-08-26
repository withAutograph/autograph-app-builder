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

  it("keeps get and the remaining lifecycle calls independent of an unsettled stream", async () => {
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
    ).resolves.toMatchObject({ sessionId: start.sessionId, events: [] });
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
        requestId: "request-1",
        response: { kind: "approve" },
        clientRequestId: "prompt-lifecycle-3",
      }),
    ).resolves.toMatchObject({ status: "working" });
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
    expect(session.respond).toHaveBeenCalledTimes(1);
    expect(response.cancel).toHaveBeenCalledTimes(1);
    expect(session.cancel).not.toHaveBeenCalled();
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
          requests: [
            {
              requestId: "request-source",
              kind: "tool-approval",
              prompt: "Allow source inspection?",
            },
          ],
        },
      } as unknown as MessageStreamEvent,
    ]);
    const responded = stream([
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
        cursor: 2,
        status: "input_required",
        inputRequests: [
          expect.objectContaining({ requestId: "request-source" }),
        ],
      });
    });

    await service.respond({
      sessionId: started.sessionId,
      requestId: "request-source",
      response: { kind: "approve" },
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
      expect(result.cursor).toBe(4);
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
    ]);
  });
});
