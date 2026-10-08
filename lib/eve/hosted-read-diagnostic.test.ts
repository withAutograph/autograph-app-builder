import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createHostedReadTrace } from "./hosted-read-diagnostic";
import type { HostedReadDiagnosticSink } from "./hosted-read-diagnostic";

const secret = "private-session https://provider.example/?token=private password=private";

describe("safe hosted read trace", () => {
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
      async () => Promise.reject(new Error(secret)),
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
      privateCallbacks: 0,
      publicSpoolEvents: 0,
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
