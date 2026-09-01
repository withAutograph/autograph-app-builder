import {
  Client,
  type ClientSession,
  type MessageStreamEvent,
} from "eve/client";

import type {
  EveSessionListResult,
  EveSessionResult,
} from "@/lib/mcp/contracts";
import {
  deriveInstalledEveStatus,
  latestInstalledImplementationPlan,
  latestInstalledPrototype,
  outstandingInstalledEveRequests,
  projectInstalledEveEvents,
} from "./public-events";
import { readLocalEveCycleBinding } from "./local-cycle-binding";

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
    prompt?: string;
    handoffId?: string;
    resumeSessionId?: string;
    clientRequestId: string;
  }): Promise<EveSessionResult>;
  /** Internal lost-response recovery for an already-bound start operation. */
  recoverStart?(input: {
    sessionId: string;
    cursor: number;
    limit: number;
  }): Promise<EveSessionResult>;
  list(input: { cursor: number; limit: number }): Promise<EveSessionListResult>;
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

type CancellableResponse = AsyncIterable<MessageStreamEvent> & {
  cancel(): Promise<unknown>;
};

type LocalEveRuntimeState = {
  generation: string;
  requests: Map<string, string>;
  sessionEvents: Map<string, MessageStreamEvent[]>;
  sessionHandles: Map<string, ClientSession>;
  activeResponses: Map<string, CancellableResponse>;
  recoveryRequired: Set<string>;
  recoveries: Map<string, Promise<void>>;
  metadata: Map<
    string,
    { title: string; createdAtEpochMs: number; updatedAtEpochMs: number }
  >;
};

const localEveRuntimeStateKey =
  "__AUTOGRAPH_APP_BUILDER_LOCAL_EVE_RUNTIME_STATE_V1__" as const;
const localRuntimeGlobal = globalThis as typeof globalThis & {
  [localEveRuntimeStateKey]?: LocalEveRuntimeState;
};

function localRuntimeState(generation: string): LocalEveRuntimeState {
  const existing = localRuntimeGlobal[localEveRuntimeStateKey];
  if (existing !== undefined && existing.generation === generation)
    return existing;
  return (localRuntimeGlobal[localEveRuntimeStateKey] = {
    generation,
    requests: new Map(),
    sessionEvents: new Map(),
    sessionHandles: new Map(),
    activeResponses: new Map(),
    recoveryRequired: new Set(),
    recoveries: new Map(),
    metadata: new Map(),
  });
}

function localSessionTitle(prompt: string): string {
  const title = prompt.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return title.slice(0, 200) || "Untitled app";
}

function localCycleGeneration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development"
  )
    return `unbound:${environment.EVE_AGENT_HOST ?? "unknown"}`;
  const path = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (path === undefined)
    throw new Error("The local Eve cycle binding was unavailable.");
  return `cycle:${readLocalEveCycleBinding(path)}`;
}

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
  state: LocalEveRuntimeState,
  sessionId: string,
  response: CancellableResponse,
): void {
  const events = state.sessionEvents.get(sessionId) ?? [];
  state.sessionEvents.set(sessionId, events);
  state.activeResponses.set(sessionId, response);
  void (async () => {
    try {
      for await (const event of response) events.push(event);
    } catch {
      state.recoveryRequired.add(sessionId);
    } finally {
      if (deriveInstalledEveStatus(events) === "working")
        state.recoveryRequired.add(sessionId);
      if (state.activeResponses.get(sessionId) === response) {
        state.activeResponses.delete(sessionId);
      }
    }
  })();
}

export function createLocalEveSessionService(
  client: Pick<Client, "sessions">,
  options: { stateGeneration?: string } = {},
): EveSessionService {
  const state = localRuntimeState(options.stateGeneration ?? "process");
  const localRequests = state.requests;
  const localSessionEvents = state.sessionEvents;
  const localSessionHandles = state.sessionHandles;
  const localActiveResponses = state.activeResponses;

  function sessionFor(sessionId: string): ClientSession {
    const existing = localSessionHandles.get(sessionId);
    if (existing !== undefined) return existing;
    const attached = client.sessions.attach(sessionId);
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  async function recoverDurableTail(sessionId: string) {
    if (!state.recoveryRequired.has(sessionId)) return;
    const existing = state.recoveries.get(sessionId);
    if (existing !== undefined) return existing;
    const recovery = (async () => {
      const snapshot = await sessionFor(sessionId).snapshot();
      if (snapshot.session.sessionId !== sessionId)
        throw new Error("Eve changed the local session during recovery.");
      localSessionEvents.set(sessionId, [...snapshot.events]);
      localSessionHandles.set(
        sessionId,
        client.sessions.attach(sessionId, {
          streamIndex: snapshot.session.streamIndex,
        }),
      );
      state.recoveryRequired.delete(sessionId);
    })().finally(() => state.recoveries.delete(sessionId));
    state.recoveries.set(sessionId, recovery);
    return recovery;
  }

  function sessionAtBufferedTail(sessionId: string): ClientSession {
    const attached = client.sessions.attach(sessionId, {
      streamIndex: localSessionEvents.get(sessionId)?.length ?? 0,
    });
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  function touchSession(sessionId: string) {
    const metadata = state.metadata.get(sessionId);
    if (metadata !== undefined)
      state.metadata.set(sessionId, {
        ...metadata,
        updatedAtEpochMs: Date.now(),
      });
  }

  return {
    async start({ prompt, resumeSessionId, clientRequestId }) {
      if (resumeSessionId !== undefined) {
        const snapshot = await sessionFor(resumeSessionId).snapshot();
        if (snapshot.session.sessionId !== resumeSessionId)
          throw new Error("Eve changed the local session during resume.");
        localSessionEvents.set(resumeSessionId, [...snapshot.events]);
        touchSession(resumeSessionId);
        return resultForEvents(resumeSessionId, snapshot.events);
      }
      if (prompt === undefined)
        throw new Error("A new App Builder session requires a prompt.");
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
      const timestamp = Date.now();
      state.metadata.set(sessionId, {
        title: localSessionTitle(prompt),
        createdAtEpochMs: timestamp,
        updatedAtEpochMs: timestamp,
      });
      consumeResponse(state, sessionId, response);
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
    },
    async list({ cursor, limit }) {
      const sessions = [...state.metadata.entries()]
        .toSorted(
          ([leftId, left], [rightId, right]) =>
            right.updatedAtEpochMs - left.updatedAtEpochMs ||
            rightId.localeCompare(leftId),
        )
        .slice(cursor, cursor + limit)
        .map(([sessionId, metadata]) => {
          const result = resultForEvents(
            sessionId,
            localSessionEvents.get(sessionId) ?? [],
          );
          return {
            sessionId,
            title: metadata.title,
            ...(result.implementationPlan?.appId === undefined
              ? {}
              : { appId: result.implementationPlan.appId }),
            stage:
              result.status === "completed"
                ? ("complete" as const)
                : result.implementationPlan !== undefined
                  ? ("ready" as const)
                  : result.prototype !== undefined
                    ? ("prototype" as const)
                    : ("designing" as const),
            status: result.status,
            resumability: ["completed", "failed", "cancelled"].includes(
              result.status,
            )
              ? ("terminal" as const)
              : ("live" as const),
            updatedAt: new Date(metadata.updatedAtEpochMs).toISOString(),
          };
        });
      return {
        kind: "session_list",
        sessions,
        cursor: cursor + sessions.length,
      };
    },
    async get({ sessionId, cursor, limit }) {
      await recoverDurableTail(sessionId);
      touchSession(sessionId);
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
        consumeResponse(state, sessionId, response);
        localRequests.set(key, sessionId);
      }
      touchSession(sessionId);
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
        consumeResponse(state, sessionId, result);
        localRequests.set(key, sessionId);
      }
      touchSession(sessionId);
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
      touchSession(sessionId);
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
      { stateGeneration: localCycleGeneration(environment) },
    );
  }
  return {
    start: notConfigured,
    list: notConfigured,
    get: notConfigured,
    send: notConfigured,
    respond: notConfigured,
    cancel: notConfigured,
  };
}
