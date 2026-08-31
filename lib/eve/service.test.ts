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
    const firstService = createLocalEveSessionService({
      sessions: {
        create: vi.fn(async () => ({ session, response })),
        attach: vi.fn(() => session),
      } as never,
    });
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
    const reloadedService = reloaded.createLocalEveSessionService({
      sessions: {
        create: vi.fn(),
        attach: vi.fn(() => session),
      } as never,
    });

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
