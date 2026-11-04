import type { MessageStreamEvent } from "eve/client";
/** Actual runtime event shapes, with no application source or credential payloads. */
export const privateApplyDenialEvents = (
  callId = "denied-call",
  requestId = "denied-request",
  status: "denied" | "ignored" | "invalid" = "denied",
): MessageStreamEvent[] => [
  {
    type: "input.requested",
    meta: { id: "request-event", at: "2026-11-04T01:00:00.000Z" },
    data: {
      turnId: "request-turn",
      sequence: 1,
      stepIndex: 1,
      requests: [
        {
          kind: "tool-approval",
          requestId,
          prompt: "Build",
          action: { kind: "tool-call", callId, toolName: "apply_app_creation", input: {} },
        },
      ],
    },
  },
  {
    type: "input.resolved",
    meta: { id: "resolution-event", at: "2026-11-04T01:00:01.000Z" },
    data: {
      turnId: "response-turn",
      sequence: 2,
      stepIndex: 2,
      resolutions: [{ kind: "tool-approval", requestId, outcome: status }],
    },
  },
  {
    type: "action.result",
    meta: { id: "result-event", at: "2026-11-04T01:00:02.000Z" },
    data: {
      turnId: "response-turn",
      sequence: 2,
      stepIndex: 2,
      status: "rejected",
      result: {
        kind: "tool-result",
        callId,
        toolName: "apply_app_creation",
        isError: true,
        output: {
          code: "TOOL_EXECUTION_DENIED",
          approval: { requestId, status },
          tool: { result: "not_run" },
        },
      },
    },
  },
];
