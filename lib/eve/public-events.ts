import type {
  EveSessionStatus,
  PublicEveEvent,
  PublicInputRequest,
} from "@/lib/mcp/contracts";
import type { MessageStreamEvent } from "eve/client";
import { publicApprovalDescription } from "../agent/approval-receipt";

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
  requestIds?: string[];
};

const progressStates = new Set(["started", "completed", "failed"]);
const invalidApprovalReceiptMessage =
  "A required approval receipt was missing or invalid; the request was not exposed.";

function inputRequest(request: {
  requestId: string;
  kind: "question" | "session-limit" | "tool-approval";
  prompt: string;
  options?: readonly { id: string; label: string }[];
  allowFreeform?: boolean;
  action?: {
    kind: "tool-call";
    toolName: string;
    input: unknown;
  };
}): PublicInputRequest | undefined {
  const approvalTitles = {
    accept_app_spec: "Approve AppSpec",
    accept_change_set: "Approve change set",
    publish_github_draft_pr: "Approve draft PR publication",
  } as const;
  const toolName = request.action?.toolName;
  const title =
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles
      ? approvalTitles[toolName as keyof typeof approvalTitles]
      : request.prompt;
  const description =
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles
      ? publicApprovalDescription(request.action?.input, toolName)
      : undefined;
  if (
    request.kind === "tool-approval" &&
    toolName !== undefined &&
    toolName in approvalTitles &&
    description === undefined
  )
    return undefined;
  return {
    requestId: request.requestId,
    kind: request.kind === "tool-approval" ? "approval" : "question",
    title,
    ...(description === undefined ? {} : { description }),
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
      const projectedRequests = event.data.requests.map(inputRequest);
      return projectedRequests.some((request) => request === undefined)
        ? [
            {
              type: "error.public",
              index,
              code: "approval_receipt_invalid",
              message: invalidApprovalReceiptMessage,
            },
            { type: "status", index, status: "failed" },
          ]
        : projectedRequests.map((request) => ({
            type: "input.requested" as const,
            index,
            request,
          }));
    case "input.resolved":
      return [
        {
          type: "input.resolved",
          index,
          requestIds: event.data.resolutions.map(({ requestId }) => requestId),
        },
      ];
    case "approval.settled":
      return [
        {
          type: "input.resolved",
          index,
          requestIds: [event.data.requestId],
        },
      ];
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

export function outstandingInstalledEveRequests(
  events: readonly MessageStreamEvent[],
): PublicInputRequest[] {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) return [];
      for (const request of event.data.requests) {
        const publicRequest = inputRequest(request);
        if (publicRequest !== undefined)
          outstanding.set(request.requestId, publicRequest);
      }
    }
    if (event.type === "input.resolved")
      for (const resolution of event.data.resolutions)
        outstanding.delete(resolution.requestId);
    if (event.type === "approval.settled")
      outstanding.delete(event.data.requestId);
  }
  return [...outstanding.values()];
}

export function outstandingInternalEveRequests(
  events: readonly InternalEveEvent[],
): PublicInputRequest[] {
  const outstanding = new Map<string, PublicInputRequest>();
  for (const event of events) {
    if (event.type === "input.requested" && event.request !== undefined)
      outstanding.set(event.request.requestId, event.request);
    if (event.type === "input.resolved")
      for (const requestId of event.requestIds ?? [])
        outstanding.delete(requestId);
  }
  return [...outstanding.values()];
}

export function deriveInstalledEveStatus(
  events: readonly MessageStreamEvent[],
): EveSessionStatus {
  const outstanding = new Set<string>();
  let boundary: EveSessionStatus = "working";
  for (const event of events) {
    if (event.type === "input.requested") {
      const projected = event.data.requests.map(inputRequest);
      if (projected.some((request) => request === undefined)) return "failed";
      for (const request of projected)
        if (request !== undefined) outstanding.add(request.requestId);
    }
    if (event.type === "input.resolved")
      for (const resolution of event.data.resolutions)
        outstanding.delete(resolution.requestId);
    if (event.type === "approval.settled")
      outstanding.delete(event.data.requestId);
    if (event.type === "turn.cancelled") boundary = "cancelled";
    if (event.type === "session.waiting") boundary = "waiting";
    if (event.type === "session.completed") boundary = "completed";
    if (event.type === "session.failed") boundary = "failed";
    if (event.type === "step.started") boundary = "working";
  }
  if (boundary === "completed" || boundary === "failed") return boundary;
  if (outstanding.size > 0) return "input_required";
  return boundary;
}

/** Project one durable Eve stream into a dense, cursor-addressable public stream. */
export function projectInstalledEveEvents(
  events: readonly MessageStreamEvent[],
): PublicEveEvent[] {
  return events
    .flatMap((event) => projectInstalledEveEvent(event, 0))
    .flatMap((event) => {
      const projected = toPublicEvent(event);
      return projected === null ? [] : [projected];
    })
    .map((event, index) => ({ ...event, index }));
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
