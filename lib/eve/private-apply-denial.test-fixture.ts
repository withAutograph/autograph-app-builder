import type { MessageStreamEvent } from "eve/client";
/** Actual runtime event shapes, with no application source or credential payloads. */
export const privateApplyDenialEvents = (
  callId = "denied-call",
  requestId = "denied-request",
  status: "denied" | "ignored" | "invalid" = "denied",
): MessageStreamEvent[] => [
  {
    data: {
      requests: [
        {
          action: { callId, input: {}, kind: "tool-call", toolName: "apply_app_creation" },
          kind: "tool-approval",
          prompt: "Build",
          requestId,
        },
      ],
      sequence: 1,
      stepIndex: 1,
      turnId: "request-turn",
    },
    meta: { at: "2026-11-04T01:00:00.000Z", id: "request-event" },
    type: "input.requested",
  },
  {
    data: {
      resolutions: [{ kind: "tool-approval", outcome: status, requestId }],
      sequence: 2,
      stepIndex: 2,
      turnId: "response-turn",
    },
    meta: { at: "2026-11-04T01:00:01.000Z", id: "resolution-event" },
    type: "input.resolved",
  },
  {
    data: {
      result: {
        callId,
        isError: true,
        kind: "tool-result",
        output: {
          approval: { requestId, status },
          code: "TOOL_EXECUTION_DENIED",
          tool: { result: "not_run" },
        },
        toolName: "apply_app_creation",
      },
      sequence: 2,
      status: "rejected",
      stepIndex: 2,
      turnId: "response-turn",
    },
    meta: { at: "2026-11-04T01:00:02.000Z", id: "result-event" },
    type: "action.result",
  },
];
