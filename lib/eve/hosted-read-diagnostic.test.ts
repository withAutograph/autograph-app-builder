import type { MessageStreamEvent } from "eve/client";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostedReadTrace } from "./hosted-read-diagnostic";
import type { HostedReadDiagnosticSink } from "./hosted-read-diagnostic";

const secret = "private-session https://provider.example/?token=private password=private";

type RequestedEvent = Extract<MessageStreamEvent, { type: "actions.requested" }>;
type ResultEvent = Extract<MessageStreamEvent, { type: "action.result" }>;
const requested = (toolName: string, workflow = false): RequestedEvent => ({
  data: {
    actions: [
      workflow
        ? {
            callId: secret,
            input: { secret },
            kind: "workflow-tool-call",
            toolName,
            workflowId: secret,
          }
        : { callId: secret, input: { secret }, kind: "tool-call", toolName },
    ],
    sequence: 1,
    stepIndex: 1,
    turnId: secret,
  },
  meta: { at: "2026-10-19T18:00:00.000Z", id: secret },
  type: "actions.requested",
});
const result = (toolName: string, status: "completed" | "failed" | "rejected"): ResultEvent => ({
  data: {
    error: { code: secret, message: secret },
    result: { callId: secret, kind: "tool-result", output: { code: "blocked", secret }, toolName },
    sequence: 2,
    status,
    stepIndex: 1,
    turnId: secret,
  },
  meta: { at: "2026-10-19T18:00:01.000Z", id: secret },
  type: "action.result",
});

describe("safe hosted read trace", () => {
  it("counts actual tool and workflow action metadata without reading private fields", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ sessionId: secret, sink });
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const events = [
      requested("prepare_workspace"),
      requested(secret, true),
      result("resolve_github_source", "completed"),
      result(secret, "failed"),
      result(secret, "rejected"),
    ];
    for (const event of events) {
      if (event.type === "actions.requested") {
        Object.defineProperty(event.data.actions[0], "input", { get: getter });
        Object.defineProperty(event.data.actions[0], "workflowId", { get: getter });
      } else {
        for (const key of ["output", "isError", "callId"]) {
          Object.defineProperty(event.data.result, key, { get: getter });
        }
        Object.defineProperty(event.data, "error", { get: getter });
      }
      trace.observeNativeAction(event);
    }
    trace.completed();
    expect(getter).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      toolRequested: 2,
      toolCompleted: 1,
      toolFailed: 1,
      prepareWorkspaceRequested: 1,
      resolveGithubSourceCompleted: 1,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("blocked");
    const fresh = createHostedReadTrace({ sessionId: secret, sink });
    fresh.completed();
    expect(sink.mock.calls[1]?.[0]).toMatchObject({
      toolRequested: 0,
      toolCompleted: 0,
      toolFailed: 0,
    });
  });

  it("projects unknown and hostile tool names only into numeric aggregates at the existing log sink", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const trace = createHostedReadTrace({ sessionId: secret });
      for (const name of [secret, "__proto__", "constructor", "unknown future tool"]) {
        trace.observeNativeAction(requested(name));
        trace.observeNativeAction(result(name, "completed"));
        trace.observeNativeAction(result(name, "failed"));
      }
      trace.completed();
      expect(log.mock.calls[0]?.[1]).toMatchObject({
        toolRequested: 4,
        toolCompleted: 4,
        toolFailed: 4,
        prepareWorkspaceRequested: 0,
        resolveGithubSourceRequested: 0,
      });
      const serialized = JSON.stringify(log.mock.calls);
      for (const name of [secret, "__proto__", "constructor", "unknown future tool"]) {
        expect(serialized).not.toContain(name);
      }
    } finally {
      log.mockRestore();
    }
  });

  it("ignores accessor or proxy metadata without invoking it and continues counting valid events", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ sessionId: secret, sink });
    const getter = vi.fn(() => {
      throw new Error(secret);
    });
    const event = requested("prepare_workspace");
    Object.defineProperty(event, "data", { get: getter });
    const badKind = requested("prepare_workspace");
    Object.defineProperty(badKind.data.actions[0], "kind", { get: getter });
    const badName = requested("prepare_workspace");
    Object.defineProperty(badName.data.actions[0], "toolName", { get: getter });
    const badStatus = result("prepare_workspace", "completed");
    Object.defineProperty(badStatus.data, "status", { get: getter });
    const revoked = Proxy.revocable(requested("prepare_workspace"), {});
    revoked.revoke();
    for (const value of [event, badKind, badName, badStatus, revoked.proxy]) {
      expect(() => {
        trace.observeNativeAction(value);
      }).not.toThrow();
    }
    trace.observeNativeAction(result("resolve_github_source", "completed"));
    trace.completed();
    expect(getter).not.toHaveBeenCalled();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      toolRequested: 1,
      toolCompleted: 1,
      toolFailed: 0,
      prepareWorkspaceRequested: 0,
      resolveGithubSourceCompleted: 1,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("reports an existing signal timeout while a private callback remains held", async () => {
    let now = 0;
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ now: () => now, sessionId: secret, sink });
    const controller = new AbortController();
    const cleanup = trace.watch(controller.signal);
    trace.set("nativeStartIndex", 12);
    trace.set("nativeNextIndex", 15);
    trace.increment("bodyBytes", 512);
    trace.increment("decodedEvents", 3);
    now = 20;
    trace.enter("private_callback");
    const held = Promise.withResolvers<null>();
    let completed = false;
    const runCallback = async () => {
      await held.promise;
      completed = true;
    };
    const callback = runCallback();
    now = 30_000;
    controller.abort();
    expect(completed).toBe(false);
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      bodyBytes: 512,
      category: "deadline",
      decodedEvents: 3,
      elapsedMs: 30_000,
      nativeNextIndex: 15,
      nativeStartIndex: 12,
      outcome: "timeout",
      phase: "private_callback",
      phaseElapsedMs: 29_980,
      privateCallbacks: 0,
    });
    held.resolve(null);
    await callback;
    trace.failed();
    trace.completed();
    cleanup();
    expect(sink).toHaveBeenCalledOnce();
  });

  it.each(["completed", "failed"] as const)(
    "reports %s once and detaches the abort listener",
    (outcome) => {
      const sink = vi.fn<HostedReadDiagnosticSink>();
      const trace = createHostedReadTrace({ sessionId: secret, sink });
      const controller = new AbortController();
      const remove = vi.spyOn(controller.signal, "removeEventListener");
      const cleanup = trace.watch(controller.signal);
      trace.enter("checkpoint");
      trace[outcome]();
      cleanup();
      controller.abort();
      trace.completed();
      trace.failed();
      expect(remove).toHaveBeenCalledOnce();
      expect(sink).toHaveBeenCalledOnce();
      expect(sink.mock.calls[0]?.[0].outcome).toBe(outcome);
      expect(sink.mock.calls[0]?.[0].category).toBe(
        outcome === "completed" ? "none" : "checkpoint_failure",
      );
    },
  );

  it("cleanup prevents a late abort report even without a terminal outcome", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ sessionId: secret, sink });
    const controller = new AbortController();
    trace.watch(controller.signal)();
    controller.abort();
    expect(sink).not.toHaveBeenCalled();
    trace.enter("decode");
    trace.completed();
    expect(sink.mock.calls[0]?.[0].outcome).toBe("completed");
  });

  it("ignores throwing and rejecting sinks without waiting or changing outcomes", async () => {
    const sinks: HostedReadDiagnosticSink[] = [
      () => {
        throw new Error(secret);
      },
      async () => {
        await Promise.resolve();
        throw new Error(secret);
      },
    ];
    for (const sink of sinks) {
      const trace = createHostedReadTrace({ sessionId: secret, sink });
      expect(() => {
        trace.failed();
      }).not.toThrow();
      expect(() => {
        trace.completed();
      }).not.toThrow();
    }
    await Promise.resolve();
    await Promise.resolve();
  });

  it("emits only closed fields, numeric progress and a hash, ignoring invalid counters", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ now: () => 42, sessionId: secret, sink });
    trace.set("bodyBytes", 10);
    for (const value of [Number.NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1]) {
      trace.set("bodyBytes", value);
      trace.increment("bodyBytes", value);
    }
    trace.set("decodedEvents", Number.MAX_SAFE_INTEGER);
    trace.increment("decodedEvents");
    trace.enter("headers");
    trace.failed();
    expect(sink.mock.calls[0]?.[0]).toEqual({
      bodyBytes: 10,
      category: "invalid_stream_contract",
      decodedEvents: Number.MAX_SAFE_INTEGER,
      elapsedMs: 0,
      event: "builder.hosted_read",
      nativeNextIndex: 0,
      nativeStartIndex: 0,
      outcome: "failed",
      phase: "headers",
      phaseElapsedMs: 0,
      prepareWorkspaceCompleted: 0,
      prepareWorkspaceFailed: 0,
      prepareWorkspaceRequested: 0,
      privateCallbacks: 0,
      publicSpoolEvents: 0,
      toolRequested: 0,
      toolCompleted: 0,
      toolFailed: 0,
      resolveGithubSourceCompleted: 0,
      resolveGithubSourceFailed: 0,
      resolveGithubSourceRequested: 0,
      sessionIdHash: `sha256:${createHash("sha256").update(secret).digest("hex")}`,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
    expect(JSON.stringify(sink.mock.calls)).not.toContain("provider.example");
    expect(JSON.stringify(sink.mock.calls)).not.toContain("password");
  });

  it("handles an already aborted signal and a failing clock without throwing", () => {
    const controller = new AbortController();
    controller.abort();
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({
      now: () => {
        throw new Error(secret);
      },
      sessionId: secret,
      sink,
    });
    const cleanup = trace.watch(controller.signal);
    cleanup();
    trace.failed();
    expect(sink).toHaveBeenCalledOnce();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      category: "deadline",
      elapsedMs: 0,
      outcome: "timeout",
      phaseElapsedMs: 0,
    });
  });
});
