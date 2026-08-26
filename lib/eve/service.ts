import {
  Client,
  type ClientSession,
  type MessageStreamEvent,
} from "eve/client";

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

export function toEveInputResponse(
  requestId: string,
  response:
    | { kind: "approve" }
    | { kind: "deny" }
    | { kind: "answer"; value: string; optionId?: string },
): { requestId: string; optionId?: string; text?: string } {
  return response.kind === "approve"
    ? { requestId, optionId: "approve" }
    : response.kind === "deny"
      ? { requestId, optionId: "cancel" }
      : {
          requestId,
          ...(response.optionId === undefined
            ? { text: response.value }
            : { optionId: response.optionId }),
        };
}

const localRequests = new Map<string, string>();
const localSessionEvents = new Map<string, MessageStreamEvent[]>();
const localSessionHandles = new Map<string, ClientSession>();
type CancellableResponse = AsyncIterable<MessageStreamEvent> & {
  cancel(): Promise<unknown>;
};
const localActiveResponses = new Map<string, CancellableResponse>();

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

function resultForEvents(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[],
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const bounded = snapshotEvents.slice(cursor, cursor + limit);
  const events = bounded.flatMap((event, offset) =>
    projectEvent(event, cursor + offset),
  );
  const inputRequests = events.flatMap((event) =>
    event.type === "input_required" ? [event.request] : [],
  );
  return {
    sessionId,
    status: deriveStatus(snapshotEvents),
    cursor: Math.min(cursor + bounded.length, snapshotEvents.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
  };
}

function acceptedResult(sessionId: string): EveSessionResult {
  return { sessionId, status: "working", cursor: 0, events: [] };
}

function consumeResponse(
  sessionId: string,
  response: CancellableResponse,
): void {
  const events = localSessionEvents.get(sessionId) ?? [];
  localSessionEvents.set(sessionId, events);
  localActiveResponses.set(sessionId, response);
  void (async () => {
    try {
      for await (const event of response) events.push(event);
    } catch {
      // Acceptance is already durable in Eve. A later read or follow-up remains
      // authoritative; a stream failure must never delay the public handle.
    } finally {
      if (localActiveResponses.get(sessionId) === response) {
        localActiveResponses.delete(sessionId);
      }
    }
  })();
}

export function createLocalEveSessionService(
  client: Pick<Client, "sessions">,
): EveSessionService {
  function sessionFor(sessionId: string): ClientSession {
    const existing = localSessionHandles.get(sessionId);
    if (existing !== undefined) return existing;
    const attached = client.sessions.attach(sessionId);
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  function sessionAtBufferedTail(sessionId: string): ClientSession {
    const attached = client.sessions.attach(sessionId, {
      streamIndex: localSessionEvents.get(sessionId)?.length ?? 0,
    });
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  return {
    async start({ prompt, clientRequestId }) {
      const key = `start:${clientRequestId}`;
      const existing = localRequests.get(key);
      if (existing !== undefined) return acceptedResult(existing);
      const { session, response } = await client.sessions.create({
        message: prompt,
      });
      const sessionId = session.state.sessionId;
      localRequests.set(key, sessionId);
      localSessionHandles.set(sessionId, session);
      consumeResponse(sessionId, response);
      return acceptedResult(sessionId);
    },
    async get({ sessionId, cursor, limit }) {
      return resultForEvents(
        sessionId,
        localSessionEvents.get(sessionId) ?? [],
        cursor,
        limit,
      );
    },
    async send({ sessionId, message, clientRequestId }) {
      const key = `send:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        const response = await sessionAtBufferedTail(sessionId).send(message);
        consumeResponse(sessionId, response);
        localRequests.set(key, sessionId);
      }
      return acceptedResult(sessionId);
    },
    async respond({ sessionId, requestId, response, clientRequestId }) {
      const key = `respond:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        const input = toEveInputResponse(requestId, response);
        const result = await sessionAtBufferedTail(sessionId).respond([input]);
        consumeResponse(sessionId, result);
        localRequests.set(key, sessionId);
      }
      return acceptedResult(sessionId);
    },
    async cancel({ sessionId, turnId }) {
      const active = localActiveResponses.get(sessionId);
      if (turnId === undefined && active !== undefined) {
        await active.cancel();
      } else {
        await sessionFor(sessionId).cancel(
          turnId === undefined ? undefined : { turnId },
        );
      }
      return resultForEvents(
        sessionId,
        localSessionEvents.get(sessionId) ?? [],
      );
    },
  };
}

const notConfigured = async (): Promise<never> => {
  throw new AdapterNotConfiguredError();
};

/** Hosted use stays fail-closed until the authenticated durable adapter is wired. */
export function createEveSessionService(
  environment:
    NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): EveSessionService {
  const host = environment.EVE_AGENT_HOST;
  if (environment.APP_BUILDER_LOCAL_ADAPTER === "1" && host !== undefined) {
    const url = new URL(host);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error(
        "The local Eve adapter requires a loopback EVE_AGENT_HOST.",
      );
    }
    return createLocalEveSessionService(
      new Client({ host: url.origin, redirect: "error" }),
    );
  }
  return {
    start: notConfigured,
    get: notConfigured,
    send: notConfigured,
    respond: notConfigured,
    cancel: notConfigured,
  };
}
