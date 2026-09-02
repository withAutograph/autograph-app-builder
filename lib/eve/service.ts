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
  latestInstalledUiPreview,
  outstandingInstalledEveRequests,
  projectInstalledEveEvents,
} from "./public-events";
import { readLocalEveCycleBinding } from "./local-cycle-binding";
import { HostedCancellationUnsettledError } from "./hosted-errors";

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
  /** The Eve child that was serving when this state was last observed. */
  restartGeneration?: string;
  requests: Map<string, string>;
  sessionEvents: Map<string, MessageStreamEvent[]>;
  sessionHandles: Map<string, ClientSession>;
  activeResponses: Map<string, CancellableResponse>;
  /**
   * A model stream stopped making progress and its turn was cancelled. Keep a
   * product-facing interruption until the durable session confirms the cancel
   * boundary; callers must not race a fresh continuation into that turn.
   */
  modelInterruptions: Map<
    string,
    { response: CancellableResponse; message: string }
  >;
  /**
   * A local Eve child was replaced while this session still had an in-flight
   * response. The old transport cannot settle it, but the durable session can
   * accept the next continuation from its last buffered boundary.
   */
  restartInterrupted: Set<string>;
  recoveryRequired: Set<string>;
  recoveries: Map<string, Promise<void>>;
  /** One durable tail reader per locally active public session. */
  tailPumps: Map<string, Promise<void>>;
  metadata: Map<
    string,
    { title: string; createdAtEpochMs: number; updatedAtEpochMs: number }
  >;
};

const localCancellationTimeoutMs = 5_000;
const localModelTurnTimeoutMs = 120_000;
const localModelTurnInterruptedMessage =
  "Autograph paused because a response took too long. Your progress is saved; try again in a moment.";

async function settleLocalCancellation(operation: Promise<unknown>) {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timeout = setTimeout(
          () => reject(new HostedCancellationUnsettledError()),
          localCancellationTimeoutMs,
        );
      }),
    ]);
  } finally {
    if (timeout !== undefined) clearTimeout(timeout);
  }
}

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
    modelInterruptions: new Map(),
    restartInterrupted: new Set(),
    recoveryRequired: new Set(),
    recoveries: new Map(),
    tailPumps: new Map(),
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
  // The binding is rotated for each Eve child. Keep the in-memory public
  // session index for the whole `mise run dev` invocation instead of treating
  // a targeted child restart as a new application.
  readLocalEveCycleBinding(path);
  return `local:${path}`;
}

function localEveRestartGeneration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== "development" ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== "local-development"
  )
    return undefined;
  const path = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (path === undefined)
    throw new Error("The local Eve cycle binding was unavailable.");
  return readLocalEveCycleBinding(path);
}

function resultForEvents(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[],
  cursor = 0,
  limit = 100,
  options: {
    status?: EveSessionResult["status"];
    error?: EveSessionResult["error"];
  } = {},
): EveSessionResult {
  const projected = projectInstalledEveEvents(snapshotEvents);
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInstalledEveRequests(snapshotEvents);
  const prototype = latestInstalledPrototype(snapshotEvents);
  const uiPreview = latestInstalledUiPreview(snapshotEvents);
  const implementationPlan = latestInstalledImplementationPlan(snapshotEvents);
  return {
    sessionId,
    status: options.status ?? deriveInstalledEveStatus(snapshotEvents),
    cursor: Math.min(cursor + events.length, projected.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(prototype === undefined ? {} : { prototype }),
    ...(uiPreview === undefined ? {} : { uiPreview }),
    ...(implementationPlan === undefined ? {} : { implementationPlan }),
    ...(options.error === undefined ? {} : { error: options.error }),
  };
}

function acceptedResult(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[] = [],
): EveSessionResult {
  const prototype = latestInstalledPrototype(snapshotEvents);
  const uiPreview = latestInstalledUiPreview(snapshotEvents);
  const implementationPlan = latestInstalledImplementationPlan(snapshotEvents);
  return {
    sessionId,
    status: "working",
    cursor: 0,
    events: [],
    ...(prototype === undefined ? {} : { prototype }),
    ...(uiPreview === undefined ? {} : { uiPreview }),
    ...(implementationPlan === undefined ? {} : { implementationPlan }),
  };
}

function consumeResponse(
  state: LocalEveRuntimeState,
  sessionId: string,
  response: CancellableResponse,
  modelTurnTimeoutMs: number,
  options: {
    cancelTurn: (turnId: string | undefined) => Promise<unknown>;
    consumeDurableTail: (
      observeEvent: (event: MessageStreamEvent) => void,
    ) => void;
  },
): void {
  const events = state.sessionEvents.get(sessionId) ?? [];
  state.sessionEvents.set(sessionId, events);
  state.activeResponses.set(sessionId, response);
  let modelTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let modelTurnActive = false;
  let modelTurnId: string | undefined;
  let timedOut = false;

  const clearModelTurnTimer = () => {
    if (modelTurnTimer !== undefined) clearTimeout(modelTurnTimer);
    modelTurnTimer = undefined;
  };
  const settleResponseBoundary = () => {
    modelTurnActive = false;
    clearModelTurnTimer();
    if (state.activeResponses.get(sessionId) === response)
      state.activeResponses.delete(sessionId);
    if (state.modelInterruptions.get(sessionId)?.response === response)
      state.modelInterruptions.delete(sessionId);
    state.recoveryRequired.delete(sessionId);
  };
  const armModelTurnTimer = () => {
    clearModelTurnTimer();
    modelTurnTimer = setTimeout(() => {
      if (
        !modelTurnActive ||
        timedOut ||
        state.activeResponses.get(sessionId) !== response
      )
        return;
      timedOut = true;
      state.modelInterruptions.set(sessionId, {
        response,
        message: localModelTurnInterruptedMessage,
      });
      // A cancellation request is idempotent at Eve's durable session
      // boundary. We deliberately do not start another turn here: first wait
      // for the original turn's cancellation boundary to become observable.
      state.recoveryRequired.add(sessionId);
      void settleLocalCancellation(options.cancelTurn(modelTurnId)).catch(
        () => undefined,
      );
    }, modelTurnTimeoutMs);
    modelTurnTimer.unref?.();
  };
  const observeEvent = (event: MessageStreamEvent) => {
    switch (event.type) {
      case "step.started":
        modelTurnActive = true;
        modelTurnId = event.data.turnId;
        armModelTurnTimer();
        return;
      case "actions.requested":
      case "input.requested":
      case "session.waiting":
      case "session.completed":
      case "session.failed":
      case "turn.cancelled":
        settleResponseBoundary();
        return;
      default:
        if (modelTurnActive) armModelTurnTimer();
    }
  };
  void (async () => {
    try {
      for await (const event of response) {
        events.push(event);
        observeEvent(event);
      }
    } catch {
      state.recoveryRequired.add(sessionId);
    } finally {
      // Eve's response iterator can close after its transport reconnect budget
      // while the durable turn is still running. Keep the turn timer alive and
      // continue from the raw durable tail instead of treating that close as a
      // settled boundary.
      if (deriveInstalledEveStatus(events) === "working") {
        state.recoveryRequired.add(sessionId);
        options.consumeDurableTail(observeEvent);
      } else settleResponseBoundary();
    }
  })();
}

export function createLocalEveSessionService(
  client: Pick<Client, "sessions">,
  options: {
    stateGeneration?: string;
    restartGeneration?: string;
    modelTurnTimeoutMs?: number;
  } = {},
): EveSessionService {
  const state = localRuntimeState(options.stateGeneration ?? "process");
  const localRequests = state.requests;
  const localSessionEvents = state.sessionEvents;
  const localSessionHandles = state.sessionHandles;
  const localActiveResponses = state.activeResponses;
  const modelTurnTimeoutMs =
    options.modelTurnTimeoutMs ?? localModelTurnTimeoutMs;

  // A targeted local restart ends the old HTTP stream without giving it a
  // reliable terminal Eve event. Preserve its buffered product progress, but
  // fence the dead response so a subsequent send can attach to the new child.
  // This is deliberately local-only: hosted sessions use their durable lease
  // and adapter-generation recovery path.
  if (
    options.restartGeneration !== undefined &&
    state.restartGeneration !== undefined &&
    state.restartGeneration !== options.restartGeneration
  ) {
    for (const sessionId of localActiveResponses.keys()) {
      localActiveResponses.delete(sessionId);
      // This handle belongs to the child being replaced. The next operation
      // must attach from a fresh durable snapshot, not its buffered tail.
      localSessionHandles.delete(sessionId);
      state.restartInterrupted.add(sessionId);
      state.recoveryRequired.add(sessionId);
    }
  }
  if (options.restartGeneration !== undefined)
    state.restartGeneration = options.restartGeneration;

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
      const interruption = state.modelInterruptions.get(sessionId);
      if (
        interruption === undefined ||
        deriveInstalledEveStatus(snapshot.events) !== "working"
      ) {
        state.modelInterruptions.delete(sessionId);
        state.recoveryRequired.delete(sessionId);
      }
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

  function consumeDurableTail(
    sessionId: string,
    observeEvent: (event: MessageStreamEvent) => void,
  ) {
    if (state.tailPumps.has(sessionId)) return;
    const pump = (async () => {
      // MessageResponse has a bounded reconnect policy. A durable session may
      // outlive that HTTP response, so continue from the raw event cursor until
      // it reports a real boundary.
      while (
        deriveInstalledEveStatus(localSessionEvents.get(sessionId) ?? []) ===
        "working"
      ) {
        try {
          const events = localSessionEvents.get(sessionId) ?? [];
          const session = client.sessions.attach(sessionId, {
            streamIndex: events.length,
          });
          localSessionHandles.set(sessionId, session);
          for await (const event of session.stream()) {
            events.push(event);
            observeEvent(event);
            if (deriveInstalledEveStatus(events) !== "working") return;
          }
        } catch {
          // HMR can briefly interrupt the local child. Buffered public events
          // remain readable while the durable tail is retried.
        }
        if (
          deriveInstalledEveStatus(localSessionEvents.get(sessionId) ?? []) !==
          "working"
        )
          return;
        await new Promise<void>((resolve) => setTimeout(resolve, 250));
      }
    })().finally(() => state.tailPumps.delete(sessionId));
    state.tailPumps.set(sessionId, pump);
  }

  function consumeSessionResponse(
    sessionId: string,
    response: CancellableResponse,
  ) {
    consumeResponse(state, sessionId, response, modelTurnTimeoutMs, {
      cancelTurn: async (turnId) =>
        await sessionFor(sessionId).cancel(
          turnId === undefined ? undefined : { turnId },
        ),
      consumeDurableTail: (observeEvent) =>
        consumeDurableTail(sessionId, observeEvent),
    });
  }

  function touchSession(sessionId: string) {
    const metadata = state.metadata.get(sessionId);
    if (metadata !== undefined)
      state.metadata.set(sessionId, {
        ...metadata,
        updatedAtEpochMs: Date.now(),
      });
  }

  function localResultOptions(sessionId: string) {
    const interruption = state.modelInterruptions.get(sessionId);
    return {
      status:
        interruption !== undefined || state.restartInterrupted.has(sessionId)
          ? ("waiting" as const)
          : undefined,
      ...(interruption === undefined
        ? {}
        : {
            error: {
              code: "model_turn_interrupted",
              message: interruption.message,
            },
          }),
    };
  }

  async function requireSettledModelTurn(sessionId: string) {
    if (state.restartInterrupted.has(sessionId))
      await recoverDurableTail(sessionId);
    if (state.modelInterruptions.has(sessionId))
      throw new Error(
        "The previous Autograph response is still settling. Try again in a moment.",
      );
  }

  return {
    async start({ prompt, resumeSessionId, clientRequestId }) {
      if (resumeSessionId !== undefined) {
        const snapshot = await sessionFor(resumeSessionId).snapshot();
        if (snapshot.session.sessionId !== resumeSessionId)
          throw new Error("Eve changed the local session during resume.");
        localSessionEvents.set(resumeSessionId, [...snapshot.events]);
        touchSession(resumeSessionId);
        return resultForEvents(resumeSessionId, snapshot.events, 0, 100, {
          status: state.restartInterrupted.has(resumeSessionId)
            ? "waiting"
            : undefined,
        });
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
      consumeSessionResponse(sessionId, response);
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
      if (state.restartInterrupted.has(sessionId))
        await recoverDurableTail(sessionId);
      if (!localSessionEvents.has(sessionId)) {
        try {
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
        } catch {
          // A fresh development invocation intentionally cannot recover an
          // older application's local Eve session. Keep that lookup empty.
        }
      }
      touchSession(sessionId);
      return resultForEvents(
        sessionId,
        localSessionEvents.get(sessionId) ?? [],
        cursor,
        limit,
        localResultOptions(sessionId),
      );
    },
    async send({ sessionId, message, clientRequestId }) {
      const key = `send:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        await requireSettledModelTurn(sessionId);
        const response = await sessionAtBufferedTail(sessionId).send(message);
        state.restartInterrupted.delete(sessionId);
        consumeSessionResponse(sessionId, response);
        localRequests.set(key, sessionId);
      }
      touchSession(sessionId);
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
    },
    async respond({ sessionId, responses, clientRequestId }) {
      const key = `respond:${sessionId}:${clientRequestId}`;
      if (!localRequests.has(key)) {
        await requireSettledModelTurn(sessionId);
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
        state.restartInterrupted.delete(sessionId);
        consumeSessionResponse(sessionId, result);
        localRequests.set(key, sessionId);
      }
      touchSession(sessionId);
      return acceptedResult(sessionId, localSessionEvents.get(sessionId));
    },
    async cancel({ sessionId, turnId }) {
      if (state.restartInterrupted.has(sessionId)) {
        touchSession(sessionId);
        return resultForEvents(
          sessionId,
          localSessionEvents.get(sessionId) ?? [],
          0,
          100,
          { status: "waiting" },
        );
      }
      const active = localActiveResponses.get(sessionId);
      if (turnId === undefined && active !== undefined) {
        try {
          await settleLocalCancellation(active.cancel());
        } catch (error) {
          if (error instanceof HostedCancellationUnsettledError) {
            localActiveResponses.delete(sessionId);
            state.recoveryRequired.add(sessionId);
          }
          throw error;
        }
      } else {
        try {
          await settleLocalCancellation(
            sessionFor(sessionId).cancel(
              turnId === undefined ? undefined : { turnId },
            ),
          );
        } catch (error) {
          if (error instanceof HostedCancellationUnsettledError)
            state.recoveryRequired.add(sessionId);
          throw error;
        }
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
      {
        stateGeneration: localCycleGeneration(environment),
        restartGeneration: localEveRestartGeneration(environment),
      },
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
