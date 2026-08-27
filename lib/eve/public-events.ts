import type {
  EveSessionStatus,
  PublicEveEvent,
  PublicInputRequest,
} from "@/lib/mcp/contracts";
import type { MessageStreamEvent } from "eve/client";

export type InternalEveEvent = {
  type: string;
  index: number;
  turnId?: string;
  text?: string;
  label?: string;
  state?: string;
  request?: PublicInputRequest;
  code?: string;
  message?: string;
  status?: EveSessionStatus;
};

const progressStates = new Set(["started", "completed", "failed"]);

function inputRequest(request: {
  requestId: string;
  kind: "question" | "session-limit" | "tool-approval";
  prompt: string;
  options?: readonly { id: string; label: string }[];
  allowFreeform?: boolean;
}): PublicInputRequest {
  return {
    requestId: request.requestId,
    kind: request.kind === "tool-approval" ? "approval" : "question",
    title: request.prompt,
    ...(request.options === undefined
      ? {}
      : { options: request.options.map(({ id, label }) => ({ id, label })) }),
    allowFreeform: request.allowFreeform ?? false,
  };
}

/** Converts only the installed Eve 0.43 events that belong in the public MCP projection. */
export function projectInstalledEveEvent(
  event: MessageStreamEvent,
  index: number,
): InternalEveEvent[] {
  switch (event.type) {
    case "message.completed":
      return event.data.message === null
        ? []
        : [
            {
              type: "assistant.message",
              index,
              turnId: event.data.turnId,
              text: event.data.message,
            },
          ];
    case "step.started":
    case "step.completed":
    case "step.failed":
      return [
        {
          type: "progress",
          index,
          turnId: event.data.turnId,
          label: "Agent step",
          state:
            event.type === "step.started"
              ? "started"
              : event.type === "step.completed"
                ? "completed"
                : "failed",
        },
      ];
    case "input.requested":
      return event.data.requests.map((request) => ({
        type: "input.requested",
        index,
        request: inputRequest(request),
      }));
    case "authorization.required":
      return [
        {
          type: "input.requested",
          index,
          request: {
            requestId:
              event.data.attemptId ??
              event.data.candidateId ??
              `${event.data.turnId}:${event.data.name}`,
            kind: "authorization",
            title: event.data.name,
            description: event.data.description,
            allowFreeform: false,
          },
        },
      ];
    case "turn.cancelled":
      return [{ type: "status", index, status: "cancelled" }];
    case "session.waiting":
      return [{ type: "status", index, status: "waiting" }];
    case "session.completed":
      return [{ type: "status", index, status: "completed" }];
    case "session.failed":
      return [
        {
          type: "error.public",
          index,
          code: event.data.code,
          message: event.data.message,
        },
        { type: "status", index, status: "failed" },
      ];
    default:
      return [];
  }
}

export function deriveInstalledEveStatus(
  events: readonly MessageStreamEvent[],
): EveSessionStatus {
  const last = events.at(-1);
  if (last?.type === "session.failed") return "failed";
  if (last?.type === "session.completed") return "completed";
  const lastInput = events.findLastIndex(
    (event) => event.type === "input.requested",
  );
  const lastProgress = events.findLastIndex((event) =>
    [
      "approval.settled",
      "message.completed",
      "step.started",
      "turn.cancelled",
      "turn.completed",
    ].includes(event.type),
  );
  if (lastInput > lastProgress) return "input_required";
  if (last?.type === "session.waiting") return "waiting";
  if (last?.type === "turn.cancelled") return "cancelled";
  return "working";
}

/** Allowlist an internal event. Unknown, reasoning, and raw tool events are dropped. */
export function toPublicEvent(event: InternalEveEvent): PublicEveEvent | null {
  switch (event.type) {
    case "assistant.message":
      return event.turnId && event.text !== undefined
        ? {
            type: "assistant_message",
            index: event.index,
            turnId: event.turnId,
            text: event.text,
          }
        : null;
    case "progress":
      return event.label && event.state && progressStates.has(event.state)
        ? {
            type: "progress",
            index: event.index,
            turnId: event.turnId,
            label: event.label,
            state: event.state as "started" | "completed" | "failed",
          }
        : null;
    case "input.requested":
      return event.request
        ? { type: "input_required", index: event.index, request: event.request }
        : null;
    case "status":
      return event.status
        ? { type: "status", index: event.index, status: event.status }
        : null;
    case "error.public":
      return event.code && event.message
        ? {
            type: "error",
            index: event.index,
            code: event.code,
            message: event.message,
          }
        : null;
    default:
      return null;
  }
}
