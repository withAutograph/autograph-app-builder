/* oxlint-disable eslint/require-await -- Typed native event fixtures exercise the read-only summarizer. */
import { describe, expect, it, vi } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { summarizeNativeTurnExecution } from "./turn-execution-evidence";

let id = 0;
const meta = (deliveryIds: string[] = []) => {
  id += 1;
  return {
    id: `event_${id}`,
    at: "2026-11-04T00:03:22.986Z",
    deliveryIds,
  };
};
const start = (turnId: string, sequence: number): MessageStreamEvent => ({
  type: "turn.started",
  data: { turnId, sequence },
  meta: meta(),
});
const message = (turnId: string, sequence: number, deliveryId: string): MessageStreamEvent => ({
  type: "message.received",
  data: { turnId, sequence, message: "private user message", parts: [] },
  meta: meta([deliveryId]),
});
const request = (turnId: string, callId: string, toolName: string): MessageStreamEvent => ({
  type: "actions.requested",
  data: {
    turnId,
    sequence: 1,
    stepIndex: 1,
    actions: [{ kind: "tool-call", callId, toolName, input: { secret: "never retained" } }],
  },
  meta: meta(),
});
const result = (
  turnId: string,
  callId: string,
  toolName: string,
  status: "completed" | "failed" | "rejected",
  commandId?: string,
): MessageStreamEvent => ({
  type: "action.result",
  data: {
    turnId,
    sequence: 1,
    stepIndex: 1,
    status,
    result: {
      kind: "tool-result",
      callId,
      toolName,
      output: { ...(commandId === undefined ? {} : { commandId }), password: "never retained" },
    },
  },
  meta: meta(),
});
const complete = (turnId: string, sequence: number): MessageStreamEvent => ({
  type: "turn.completed",
  data: { turnId, sequence },
  meta: meta(),
});
const summarize = (
  events: MessageStreamEvent[],
  selector?: Parameters<typeof summarizeNativeTurnExecution>[0]["selector"],
) =>
  summarizeNativeTurnExecution({
    events,
    nativeCursor: events.length,
    ownerLineage: ["wrun_original", "wrun_recovered"],
    selector,
    sessionId: "wrun_original",
  });
const statusOnly = () => [
  start("turn_16", 16),
  request("turn_16", "call_old", "prepare-app-creation"),
  result("turn_16", "call_old", "prepare-app-creation", "failed", "cmd_old"),
  complete("turn_16", 16),
  start("turn_17", 17),
  message("turn_17", 17, "delivery_current"),
  request("turn_17", "call_status", "artifact_workflow_status"),
  result("turn_17", "call_status", "artifact_workflow_status", "completed"),
  complete("turn_17", 17),
];

describe("per-turn native execution evidence", () => {
  it("separates an accepted continuation's status read from a historical planning failure", () => {
    const events = statusOnly();
    const before = JSON.stringify(events);
    const evidence = summarize(events, { deliveryId: "delivery_current" });
    expect(evidence).toMatchObject({
      lastHistoricalFailedExecution: {
        callId: "call_old",
        commandReferences: [{ commandId: "cmd_old", nativeIndex: 2 }],
        requested: { nativeIndex: 1 },
        result: { nativeIndex: 2, status: "failed" },
        turnId: "turn_16",
      },
      nativeCursor: events.length,
      ownerLineage: ["wrun_original", "wrun_recovered"],
      selectedBy: "delivery-id",
      selectedTurn: {
        acceptedMessages: [{ deliveryIds: ["delivery_current"], nativeIndex: 5 }],
        attempts: [
          { callId: "call_status", category: "status-read", result: { status: "completed" } },
        ],
        execution: "unexercised",
        sequence: 17,
        turnId: "turn_17",
      },
    });
    expect(evidence.selectedTurn.attempts).toHaveLength(1);
    expect(JSON.stringify(evidence)).not.toContain("private user message");
    expect(JSON.stringify(evidence)).not.toContain("never retained");
    expect(JSON.stringify(events)).toBe(before);
  });
  it("uses explicit message index and turn selection without falling back to a different turn", () => {
    const events = statusOnly();
    expect(summarize(events, { messageIndex: 5 }).selectedTurn.turnId).toBe("turn_17");
    expect(summarize(events, { turnId: "turn_16" }).selectedTurn.execution).toBe("result-observed");
    expect(() => summarize(events, { deliveryId: "not-yet-delivered" })).toThrow(
      "native_turn_evidence_unavailable",
    );
    expect(() => summarize(events, { messageIndex: 4 })).toThrow(
      "native_turn_evidence_unavailable",
    );
  });
  it("does not convert a pending request or rejected approval into provider completion", () => {
    const events = [
      start("turn_1", 1),
      message("turn_1", 1, "delivery"),
      request("turn_1", "call_pending", "apply_app_creation"),
    ];
    expect(summarize(events).selectedTurn).toMatchObject({
      attempts: [{ callId: "call_pending" }],
      execution: "requested",
    });
    expect(summarize(events).selectedTurn.attempts[0].result).toBeUndefined();
    events.push(result("turn_1", "call_pending", "apply_app_creation", "rejected"));
    expect(summarize(events).selectedTurn).toMatchObject({
      attempts: [{ result: { status: "rejected" } }],
      execution: "result-observed",
    });
  });
  it("keeps an unclassified dynamic tool unassessed and a result without request unproven", () => {
    expect(
      summarize([start("turn_1", 1), request("turn_1", "call_dynamic", "custom-user-tool")])
        .selectedTurn.execution,
    ).toBe("unassessed");
    expect(
      summarize([
        start("turn_1", 1),
        result("turn_1", "call_orphan", "prepare_workspace", "failed"),
      ]).selectedTurn.execution,
    ).toBe("unassessed");
  });
  it("keeps late historical settlements attached to their original turn", () => {
    const events = [
      start("turn_old", 1),
      request("turn_old", "call_old", "prepare_workspace"),
      start("turn_new", 2),
      message("turn_new", 2, "new"),
      result("turn_old", "call_old", "prepare_workspace", "failed"),
    ];
    expect(summarize(events, { deliveryId: "new" })).toMatchObject({
      lastHistoricalFailedExecution: { callId: "call_old", turnId: "turn_old" },
      selectedTurn: { attempts: [], execution: "unexercised", turnId: "turn_new" },
    });
  });
  it("does not inspect private inputs, outputs, errors or assistant wording", () => {
    const events = statusOnly();
    const getter = vi.fn(() => {
      throw new Error("private");
    });
    for (const event of events) {
      if (event.type === "actions.requested") {
        Object.defineProperty(event.data.actions[0], "input", { get: getter });
      }
      if (event.type === "action.result") {
        Object.defineProperty(event.data.result, "output", { get: getter });
        Object.defineProperty(event.data, "error", { get: getter });
      }
    }
    expect(summarize(events).selectedTurn.execution).toBe("unexercised");
    expect(getter).not.toHaveBeenCalled();
  });
  it("refuses an incomplete prefix or unrelated owner lineage instead of declaring unexercised", () => {
    const events = statusOnly();
    expect(() =>
      summarizeNativeTurnExecution({
        events,
        nativeCursor: events.length + 1,
        ownerLineage: ["wrun_original"],
        sessionId: "wrun_original",
      }),
    ).toThrow();
    expect(() =>
      summarizeNativeTurnExecution({
        events,
        nativeCursor: events.length,
        ownerLineage: ["wrun_foreign"],
        sessionId: "wrun_original",
      }),
    ).toThrow();
  });
  it("keeps repeated opaque call IDs scoped to their native turns", () => {
    const events = [
      start("turn_old", 1),
      request("turn_old", "call_same", "prepare-app-creation"),
      result("turn_old", "call_same", "prepare-app-creation", "failed"),
      complete("turn_old", 1),
      start("turn_new", 2),
      request("turn_new", "call_same", "prepare-app-creation"),
      result("turn_new", "call_same", "prepare-app-creation", "completed"),
    ];
    const evidence = summarize(events);
    expect(evidence.selectedTurn.attempts[0]?.result?.status).toBe("completed");
    expect(evidence.lastHistoricalFailedExecution?.turnId).toBe("turn_old");
  });
  it("reports a terminal turn that failed before tools as unexercised", () => {
    const events: MessageStreamEvent[] = [
      start("turn_failed", 18),
      message("turn_failed", 18, "delivery_failed"),
      {
        type: "turn.failed",
        data: {
          turnId: "turn_failed",
          sequence: 18,
          code: "model_failed",
          message: "private model failure",
        },
        meta: meta(),
      },
    ];
    const evidence = summarize(events);
    expect(evidence.selectedTurn.execution).toBe("unexercised");
    expect(evidence.selectedTurn.boundary?.kind).toBe("failed");
    expect(JSON.stringify(evidence)).not.toContain("private model failure");
  });
  it("retains orphan recovered-history actions as unassessed without rejecting a later observed turn", () => {
    const events = [
      request("", "call_unknown", "prepare-app-creation"),
      result("", "call_unknown", "prepare-app-creation", "failed"),
      ...statusOnly(),
    ];
    const evidence = summarize(events, { turnId: "turn_17" });
    expect(evidence.selectedTurn.execution).toBe("unexercised");
    expect(evidence.unassociatedEvents.map((event) => event.assessment)).toEqual([
      "unassessed",
      "unassessed",
    ]);
    expect(evidence.unassociatedEvents.map((event) => event.turnId)).toEqual([null, null]);
    expect(evidence.lastHistoricalFailedExecution?.turnId).toBe("turn_16");
    expect(() => summarize(events, { turnId: "turn_missing" })).toThrow();
  });
});
