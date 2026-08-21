import { Client, type MessageStreamEvent } from "eve/client";

import type {
  EveSessionResult,
  EveSessionStatus,
  PublicEveEvent,
  PublicInputRequest,
} from "@/lib/mcp/contracts";

export class AdapterNotConfiguredError extends Error {
  constructor() {
    super(
      "Set APP_BUILDER_LOCAL_ADAPTER=1 and EVE_AGENT_HOST for the local adapter, or configure the authenticated durable production adapter.",
    );
    this.name = "AdapterNotConfiguredError";
  }
}

export interface EveSessionService {
  start(input: {
    prompt: string;
    clientRequestId: string;
  }): Promise<EveSessionResult>;
  get(input: {
    sessionId: string;
    cursor: number;
    limit: number;
  }): Promise<EveSessionResult>;
  send(input: {
    sessionId: string;
    message: string;
    clientRequestId: string;
  }): Promise<EveSessionResult>;
  respond(input: {
    sessionId: string;
    requestId: string;
    response:
      | { kind: "approve" }
      | { kind: "deny" }
      | { kind: "answer"; value: string; optionId?: string };
    clientRequestId: string;
  }): Promise<EveSessionResult>;
  cancel(input: {
    sessionId: string;
    turnId?: string;
  }): Promise<EveSessionResult>;
}

const localRequests = new Map<string, string>();

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

function projectEvent(
  event: MessageStreamEvent,
  index: number,
): PublicEveEvent[] {
  switch (event.type) {
    case "message.completed":
      return event.data.message === null
        ? []
        : [
            {
              type: "assistant_message",
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
        type: "input_required" as const,
        index,
        request: inputRequest(request),
      }));
    case "authorization.required":
      return [
        {
          type: "input_required",
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
          type: "error",
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

function deriveStatus(events: readonly MessageStreamEvent[]): EveSessionStatus {
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

async function resultFor(
  client: Client,
  sessionId: string,
  cursor = 0,
  limit = 100,
): Promise<EveSessionResult> {
  const snapshot = await client.sessions.attach(sessionId).snapshot();
  const bounded = snapshot.events.slice(cursor, cursor + limit);
  const events = bounded.flatMap((event, offset) =>
    projectEvent(event, cursor + offset),
  );
  const inputRequests = events.flatMap((event) =>
    event.type === "input_required" ? [event.request] : [],
  );
  return {
    sessionId,
    status: deriveStatus(snapshot.events),
    cursor: Math.min(cursor + bounded.length, snapshot.events.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
  };
}

function localService(host: string): EveSessionService {
  const client = new Client({ host, redirect: "error" });
  return {
    async start({ prompt, clientRequestId }) {
      const key = `start:${clientRequestId}`;
      const existing = localRequests.get(key);
      if (existing !== undefined) return resultFor(client, existing);
      const { session } = await client.sessions.create({ message: prompt });
      localRequests.set(key, session.state.sessionId);
      return resultFor(client, session.state.sessionId);
    },
    async get({ sessionId, cursor, limit }) {
      return resultFor(client, sessionId, cursor, limit);
    },
    async send({ sessionId, message, clientRequestId }) {
      const key = `send:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        await client.sessions.attach(sessionId).send(message);
        localRequests.set(key, sessionId);
      }
      return resultFor(client, sessionId);
    },
    async respond({ sessionId, requestId, response, clientRequestId }) {
      const key = `respond:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        const input =
          response.kind === "approve"
            ? { requestId, optionId: "approve" }
            : response.kind === "deny"
              ? { requestId, optionId: "deny" }
              : {
                  requestId,
                  ...(response.optionId === undefined
                    ? { text: response.value }
                    : { optionId: response.optionId }),
                };
        await client.sessions.attach(sessionId).respond([input]);
        localRequests.set(key, sessionId);
      }
      return resultFor(client, sessionId);
    },
    async cancel({ sessionId, turnId }) {
      await client.sessions
        .attach(sessionId)
        .cancel(turnId === undefined ? undefined : { turnId });
      return resultFor(client, sessionId);
    },
  };
}

const notConfigured = async (): Promise<never> => {
  throw new AdapterNotConfiguredError();
};

/** Hosted use stays fail-closed until the authenticated durable adapter is wired. */
export function createEveSessionService(): EveSessionService {
  const host = process.env.EVE_AGENT_HOST;
  if (process.env.APP_BUILDER_LOCAL_ADAPTER === "1" && host !== undefined) {
    const url = new URL(host);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(
        "The local Eve adapter requires a loopback EVE_AGENT_HOST.",
      );
    }
    return localService(url.origin);
  }
  return {
    start: notConfigured,
    get: notConfigured,
    send: notConfigured,
    respond: notConfigured,
    cancel: notConfigured,
  };
}
