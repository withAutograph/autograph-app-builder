import {
  Client,
  type ClientSession,
  type MessageStreamEvent,
} from "eve/client";

import type { EveSessionResult } from "@/lib/mcp/contracts";
import {
  deriveInstalledEveStatus,
  latestInstalledImplementationPlan,
  latestInstalledPrototype,
  outstandingInstalledEveRequests,
  projectInstalledEveEvents,
} from "./public-events";

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
    responses: Array<{
      requestId: string;
      response:
        | { kind: "approve" }
        | { kind: "deny" }
        | { kind: "answer"; value: string; optionId?: string };
    }>;
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

export function toEveInputResponses(
  responses: Parameters<EveSessionService["respond"]>[0]["responses"],
) {
  return responses.map(({ requestId, response }) =>
    toEveInputResponse(requestId, response),
  );
}

const localRequests = new Map<string, string>();
const localSessionEvents = new Map<string, MessageStreamEvent[]>();
const localSessionHandles = new Map<string, ClientSession>();
type CancellableResponse = AsyncIterable<MessageStreamEvent> & {
  cancel(): Promise<unknown>;
};
const localActiveResponses = new Map<string, CancellableResponse>();

function resultForEvents(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[],
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const projected = projectInstalledEveEvents(snapshotEvents);
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInstalledEveRequests(snapshotEvents);
  const prototype = latestInstalledPrototype(snapshotEvents);
  const implementationPlan = latestInstalledImplementationPlan(snapshotEvents);
  return {
    sessionId,
    status: deriveInstalledEveStatus(snapshotEvents),
    cursor: Math.min(cursor + events.length, projected.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(prototype === undefined ? {} : { prototype }),
    ...(implementationPlan === undefined ? {} : { implementationPlan }),
  };
}

function acceptedResult(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[] = [],
): EveSessionResult {
  const prototype = latestInstalledPrototype(snapshotEvents);
  const implementationPlan = latestInstalledImplementationPlan(snapshotEvents);
  return {
    sessionId,
    status: "working",
    cursor: 0,
    events: [],
    ...(prototype === undefined ? {} : { prototype }),
    ...(implementationPlan === undefined ? {} : { implementationPlan }),
  };
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
      if (existing !== undefined)
        return acceptedResult(existing, localSessionEvents.get(existing));
      const { session, response } = await client.sessions.create({
        message: prompt,
      });
      const sessionId = session.state.sessionId;
      localRequests.set(key, sessionId);
      localSessionHandles.set(sessionId, session);
      consumeResponse(sessionId, response);
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
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
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
    },
    async respond({ sessionId, responses, clientRequestId }) {
      const key = `respond:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        const expected = outstandingInstalledEveRequests(
          localSessionEvents.get(sessionId) ?? [],
        ).map(({ requestId }) => requestId);
        if (
          expected.length !== responses.length ||
          expected.some(
            (requestId, index) => responses[index]?.requestId !== requestId,
          )
        )
          throw new Error(
            "The complete outstanding Eve input batch is required.",
          );
        const result = await sessionAtBufferedTail(sessionId).respond(
          toEveInputResponses(responses),
        );
        consumeResponse(sessionId, result);
        localRequests.set(key, sessionId);
      }
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
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
