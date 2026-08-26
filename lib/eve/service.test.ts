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
    const response = {
      async *[Symbol.asyncIterator]() {
        await new Promise<void>(() => undefined);
        yield {} as MessageStreamEvent;
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
    expect(session.send).toHaveBeenCalledTimes(1);
    expect(session.respond).toHaveBeenCalledTimes(1);
    expect(session.cancel).toHaveBeenCalledTimes(1);
  });
});
