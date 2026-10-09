import type { MessageStreamEvent } from "eve/client";
import { describe, expect, it, vi } from "vitest";
import { createHostedReadTrace } from "./hosted-read-diagnostic";
import type { HostedReadDiagnosticSink } from "./hosted-read-diagnostic";
import { observeSameOriginEveStream } from "./same-origin-http";
import type { NativeObservationState } from "./native-observation-state";

const secret = "private-owner/repository bearer-secret postgres://private:password@host/db";
const requested = (toolName: string): MessageStreamEvent => ({
  data: {
    actions: [{ callId: secret, input: { secret }, kind: "tool-call", toolName }],
    sequence: 1,
    stepIndex: 1,
    turnId: secret,
  },
  type: "actions.requested",
});
const result = (
  toolName: string,
  status: "completed" | "failed" | "rejected",
): MessageStreamEvent => ({
  data: {
    error: { code: secret, message: secret },
    result: { callId: secret, kind: "tool-result", output: secret, toolName },
    sequence: 2,
    status,
    stepIndex: 1,
    turnId: secret,
  },
  type: "action.result",
});

describe("allowlisted native action diagnostics", () => {
  it("counts only native request/result metadata and never accesses private payloads", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ sessionId: secret, sink });
    const events = [
      requested("prepare_workspace"),
      requested("resolve_github_source"),
      requested(secret),
      result("prepare_workspace", "completed"),
      result("prepare_workspace", "failed"),
      result("resolve_github_source", "completed"),
      result("resolve_github_source", "failed"),
      result("resolve_github_source", "rejected"),
      result(secret, "failed"),
    ];
    for (const event of events) {
      if (event.type === "actions.requested") {
        Object.defineProperty(event.data.actions[0], "input", {
          get() {
            throw new Error(secret);
          },
        });
      } else if (event.type === "action.result") {
        Object.defineProperty(event.data.result, "output", {
          get() {
            throw new Error(secret);
          },
        });
      }
      expect(() => {
        trace.observeNativeAction(event);
      }).not.toThrow();
    }
    trace.completed();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      prepareWorkspaceCompleted: 1,
      prepareWorkspaceFailed: 1,
      prepareWorkspaceRequested: 1,
      resolveGithubSourceCompleted: 1,
      resolveGithubSourceFailed: 1,
      resolveGithubSourceRequested: 1,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("logs only closed numeric counters and the session hash through the default sink", () => {
    const log = vi.spyOn(console, "info").mockImplementation(() => {});
    try {
      const trace = createHostedReadTrace({ sessionId: secret });
      trace.observeNativeAction(requested("prepare_workspace"));
      trace.observeNativeAction(result("resolve_github_source", "failed"));
      trace.completed();
      expect(log).toHaveBeenCalledOnce();
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(log.mock.calls[0]?.[1]).toMatchObject({
        prepareWorkspaceRequested: 1,
        resolveGithubSourceFailed: 1,
      });
    } finally {
      log.mockRestore();
    }
  });

  it("does not gate malformed metadata or inspect output for inferred failures", () => {
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const trace = createHostedReadTrace({ sessionId: secret, sink });
    const malformed = requested("prepare_workspace");
    Object.defineProperty(malformed.data, "actions", {
      get() {
        throw new Error(secret);
      },
    });
    expect(() => {
      trace.observeNativeAction(malformed);
    }).not.toThrow();
    trace.observeNativeAction(result("prepare_workspace", "completed"));
    trace.completed();
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      prepareWorkspaceCompleted: 1,
      prepareWorkspaceFailed: 0,
      prepareWorkspaceRequested: 0,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });

  it("counts each consumed tail event once, resets per observation and preserves private delivery", async () => {
    const events = [requested("prepare_workspace"), result("prepare_workspace", "completed")];
    const sink = vi.fn<HostedReadDiagnosticSink>();
    const privateEvents: MessageStreamEvent[] = [];
    const observe = async (nativeObservationState?: NativeObservationState) =>
      await observeSameOriginEveStream({
        config: { baseUrl: "https://builder.example", timeoutMs: 10_000 },
        fetchImplementation: async () =>
          await Promise.resolve(
            new Response(
              `${events
                .slice(nativeObservationState?.nextNativeIndex ?? 0)
                .map((event) => JSON.stringify(event))
                .join("\n")}\n`,
              {
                headers: {
                  "content-type": "application/x-ndjson",
                  "x-eve-session-id": secret,
                  "x-eve-stream-format": "ndjson",
                  "x-eve-stream-tail-index": String(events.length - 1),
                  "x-eve-stream-version": "25",
                },
              },
            ),
          ),
        nativeObservationState,
        onEvent() {},
        onPrivateEvent(event) {
          privateEvents.push(event);
        },
        readTrace: createHostedReadTrace({ sessionId: secret, sink }),
        sessionId: secret,
        workloadIdentity: { token: async () => await Promise.resolve("fixture-token") },
      });
    const first = await observe();
    events.push(requested("resolve_github_source"), result("resolve_github_source", "failed"));
    await observe(first.nativeObservationState);
    expect(privateEvents).toEqual(events);
    expect(sink.mock.calls[0]?.[0]).toMatchObject({
      decodedEvents: 2,
      nativeNextIndex: 2,
      nativeStartIndex: 0,
      prepareWorkspaceRequested: 1,
      resolveGithubSourceFailed: 0,
    });
    expect(sink.mock.calls[1]?.[0]).toMatchObject({
      decodedEvents: 2,
      nativeNextIndex: 4,
      nativeStartIndex: 2,
      prepareWorkspaceCompleted: 0,
      prepareWorkspaceRequested: 0,
      resolveGithubSourceFailed: 1,
      resolveGithubSourceRequested: 1,
    });
    expect(JSON.stringify(sink.mock.calls)).not.toContain(secret);
  });
});
