import {
  continueLocalPreapprovalAuthoring,
  readLocalAuthoringDecision,
  blockLocalAuthoringContinuation,
  localAuthoringConfigured,
  readLocalAuthoringDispatchState,
} from "../agent/local-preapproval-authoring";
import { latestInstalledApplicationSource } from "./public-application-source";
import { appendCurrentLocalSnapshot, appendImmutableLocalEvent } from "./immutable-local-events";
import {
  guardRequestIds,
  pendingFrameworkGuardIds,
  presentSessionLimitState,
  sessionLimitCancelledTurns,
  matchesPendingGuardStop,
  frameworkGuardBatches,
  resolvedGuardRequestIds,
  isLegacySessionLimitRequest,
  mergeSessionLimitResponses,
  omitControlledGuardQuestions,
  privateInputForEvents,
  provesSessionLimitResponse,
  nativeResponses,
} from "./session-limit-input";
import type { InternalSessionLimitResponse, PrivateInputState } from "./session-limit-input";
import { z } from "zod";
import { digest, stableId } from "./hosted-operation-identifiers";
import {
  continueApprovedLocalBuild,
  readLocalBuildDecision,
} from "../agent/local-build-continuation";
import { reportApprovedBuildNoProgress } from "../agent/approved-build-continuation";
import { Client, ClientError, parseInputResponses } from "eve/client";
import type { ClientSession, MessageStreamEvent } from "eve/client";
import { setTimeout as delay } from "node:timers/promises";
import { isDeepStrictEqual } from "node:util";

import type { EveSessionListResult, EveSessionResult } from "@/lib/mcp/contracts";
import {
  deriveInstalledEveStatus,
  latestInstalledPrototype,
  latestInstalledUiPreview,
  latestInstalledWorkingPreview,
  outstandingInstalledEveRequests,
  projectInstalledEveEvents,
} from "./public-events";
import { readLocalEveCycleBinding } from "./local-cycle-binding";
import {
  createLocalNativeRecovery,
  withLocalRecoveredSessions,
  localRecoveryResponseSchema,
  localRecoveredControlReceiptSchema,
} from "./local-native-recovery";
import { HostedCancellationUnsettledError } from "./hosted-errors";
import {
  isUnavailableLocalSession,
  localSessionRecoveryError,
  LocalSessionRecoveryUnavailableError,
} from "./local-session-recovery";

const CONTINUATION_ALREADY_ACTIVE_MESSAGE =
  "Another continuation is already active for this session.";

const DEVELOPMENT_BUNDLE = "local-development";
const DEVELOPMENT_MODE = "development";

const localContinuationFailure = async (
  sessionId: string,
  result: EveSessionResult,
): Promise<EveSessionResult> => {
  const build = await readLocalBuildDecision(sessionId);
  if (build?.decision === "blocked" && build.reason === "build_no_progress") {
    return reportApprovedBuildNoProgress(result);
  }
  if ((await readLocalAuthoringDispatchState(sessionId)) === "blocked") {
    return {
      ...result,
      error: {
        code: "preapproval_authoring_continuation_blocked",
        message:
          "Current ownership, input or source blocks the drafting continuation. Preserve this session and continue through ordinary controls.",
      },
    };
  }
  const decision = await readLocalAuthoringDecision(sessionId);
  if (decision?.decision === "blocked" && decision.reason === "authoring_no_progress") {
    return {
      ...result,
      error: {
        code: "preapproval_authoring_no_progress",
        message:
          "Builder completed the drafting continuation without producing a proposal. The accepted app is unfinished; continue through an ordinary user turn to revise the plan.",
      },
    };
  }
  return result;
};

export class AdapterNotConfiguredError extends Error {
  constructor() {
    super(
      "Set APP_BUILDER_LOCAL_ADAPTER=1 and EVE_AGENT_HOST for the local adapter, or configure the authenticated durable production adapter.",
    );
    this.name = "AdapterNotConfiguredError";
  }
}

export interface EveSessionService {
  start: (input: {
    prompt?: string;
    handoffId?: string;
    /** Internal only: set after authenticated handoff resolution, never by MCP input. */
    sourceHandoffId?: string;
    resumeSessionId?: string;
    resumeMode?: "recover" | "recover-idle";
    clientRequestId: string;
  }) => Promise<EveSessionResult>;
  /** Internal lost-response recovery for an already-bound start operation. */
  recoverStart?: (input: {
    sessionId: string;
    cursor: number;
    limit: number;
  }) => Promise<EveSessionResult>;
  list: (input: { cursor: number; limit: number }) => Promise<EveSessionListResult>;
  /** Read the result of this caller's original start without submitting it again. */
  getStart?: (input: {
    clientRequestId: string;
    cursor: number;
    limit: number;
  }) => Promise<EveSessionResult>;
  /** Internal only: bind the caller's opaque handoff request before canonical start dispatch. */
  bindStartAlias?: (input: {
    clientRequestId: string;
    canonicalClientRequestId: string;
    sourceHandoffId: string;
  }) => Promise<void>;
  settleStartAlias?: (input: {
    clientRequestId: string;
    canonicalClientRequestId: string;
  }) => Promise<void>;
  get: (input: { sessionId: string; cursor: number; limit: number }) => Promise<EveSessionResult>;
  send: (input: {
    sessionId: string;
    message: string;
    clientRequestId: string;
    observationCursor?: number;
  }) => Promise<EveSessionResult>;
  respond: (input: {
    sessionId: string;
    responses: {
      requestId: string;
      response:
        | {
            kind: "approve";
          }
        | {
            kind: "deny";
          }
        | {
            kind: "answer";
            value: string;
            optionId?: string;
          };
    }[];
    clientRequestId: string;
  }) => Promise<EveSessionResult>;
  /** Read-only recovery for an exact already-settled hosted approval response. */
  recoverAppliedApprovalResponse?: (input: {
    sessionId: string;
    responses: {
      requestId: string;
      response: { kind: "approve" | "deny" };
    }[];
  }) => Promise<EveSessionResult | undefined>;
  cancel: (input: { sessionId: string; turnId?: string }) => Promise<EveSessionResult>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function toEveInputResponse(
  requestId: string,
  response:
    | { kind: "approve" }
    | { kind: "deny" }
    | { kind: "answer"; value: string; optionId?: string },
): { requestId: string; optionId?: string; text?: string } {
  if (response.kind === "approve") {
    return { optionId: "approve", requestId };
  }
  if (response.kind === "deny") {
    return { optionId: "cancel", requestId };
  }
  if (response.optionId === undefined) {
    return { requestId, text: response.value };
  }
  return { optionId: response.optionId, requestId };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function toEveInputResponses(
  responses: Parameters<EveSessionService["respond"]>[0]["responses"],
) {
  return parseInputResponses(
    responses.map(({ requestId, response }) => toEveInputResponse(requestId, response)),
  );
}

type CancellableResponse = AsyncIterable<MessageStreamEvent> & {
  cancel: () => Promise<unknown>;
};

export type LocalSessionHandle = Pick<ClientSession, "state" | "snapshot" | "cancel" | "stream"> & {
  send: (message: string, options?: { turnPolicy?: "queue" }) => Promise<CancellableResponse>;
  respond: (input: Parameters<ClientSession["respond"]>[0]) => Promise<CancellableResponse>;
};
export interface LocalSessionClient {
  sessions: {
    create: Client["sessions"]["create"];
    attach: (sessionId: string, options?: { streamIndex?: number }) => LocalSessionHandle;
  };
}

interface LocalEveRuntimeState {
  generation: string;
  /** The Eve child that was serving when this state was last observed. */
  restartGeneration?: string;
  requests: Map<string, string>;
  guardOperations: Map<
    string,
    {
      marker: InternalSessionLimitResponse;
      requestDigest: string;
      sessionId: string;
      state: "reserved" | "succeeded";
    }
  >;
  sessionEvents: Map<string, MessageStreamEvent[]>;
  sessionHandles: Map<string, LocalSessionHandle>;
  activeResponses: Map<string, CancellableResponse>;
  /** Iterator ownership outlives an interim waiting boundary during webhook authorization. */
  responsePumps: Map<string, Set<CancellableResponse>>;
  responseObservers: Map<CancellableResponse, (event: MessageStreamEvent) => void>;
  continuationPumps: Map<string, Promise<boolean>>;
  /**
   * A model stream stopped making progress and its turn was cancelled. Keep a
   * product-facing interruption until the durable session confirms the cancel
   * boundary; callers must not race a fresh continuation into that turn.
   */
  modelInterruptions: Map<string, { response: CancellableResponse; message: string }>;
  /**
   * A local Eve child was replaced while this session still had an in-flight
   * response. The old transport cannot settle it, but the durable session can
   * accept the next continuation from its last buffered boundary.
   */
  restartInterrupted: Set<string>;
  recoveryRequired: Set<string>;
  /** No recoverable stream or a confirmed inactive worker; never replace its public identity. */
  unavailableSessions: Set<string>;
  recoveries: Map<string, Promise<void>>;
  /** One durable tail reader per locally active public session. */
  tailPumps: Map<string, Promise<void>>;
  tailControllers: Map<string, AbortController>;
  metadata: Map<string, { title: string; createdAtEpochMs: number; updatedAtEpochMs: number }>;
}

const localCancellationTimeoutMs = 5000;
// Repository apply and validation run inside the Vercel Sandbox.  Their
// provider command budget is five minutes, so the local Eve watchdog must not
// interrupt the model turn before that operation can settle.  The previous
// two-minute watchdog converted a still-running apply into
// `model_turn_interrupted`, after which continuation could only see the stale
// recovery boundary.  Keep the watchdog as a genuine upper bound while
// allowing one full sandbox command to complete.
const localModelTurnTimeoutMs = 360_000;
const localModelTurnInterruptedMessage =
  "Autograph paused because a response took too long. Your progress is saved; try again in a moment.";

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function settleLocalCancellation(operation: Promise<unknown>) {
  const timeoutController = new AbortController();
  try {
    await Promise.race([
      operation,
      delay(localCancellationTimeoutMs, null, {
        ref: false,
        signal: timeoutController.signal,
      }).then(() => {
        throw new HostedCancellationUnsettledError();
      }),
    ]);
  } finally {
    timeoutController.abort();
  }
}

const localEveRuntimeStateKey = "__AUTOGRAPH_APP_BUILDER_LOCAL_EVE_RUNTIME_STATE_V1__" as const;
const localRuntimeGlobal = globalThis as typeof globalThis & {
  [localEveRuntimeStateKey]?: LocalEveRuntimeState;
};

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function localRuntimeState(generation: string): LocalEveRuntimeState {
  const existing = localRuntimeGlobal[localEveRuntimeStateKey];
  if (existing !== undefined && existing.generation === generation) {
    existing.continuationPumps ??= new Map();
    existing.guardOperations ??= new Map();
    existing.tailControllers ??= new Map();
    existing.unavailableSessions ??= new Set();
    existing.responsePumps ??= new Map();
    existing.responseObservers ??= new Map();
    return existing;
  }
  return (localRuntimeGlobal[localEveRuntimeStateKey] = {
    activeResponses: new Map(),
    responsePumps: new Map(),
    responseObservers: new Map(),
    continuationPumps: new Map(),
    generation,
    guardOperations: new Map(),
    metadata: new Map(),
    modelInterruptions: new Map(),
    recoveries: new Map(),
    recoveryRequired: new Set(),
    requests: new Map(),
    restartInterrupted: new Set(),
    sessionEvents: new Map(),
    sessionHandles: new Map(),
    tailControllers: new Map(),
    tailPumps: new Map(),
    unavailableSessions: new Set(),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function localSessionTitle(prompt: string): string {
  const title = prompt.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return title.slice(0, 200) || "Untitled app";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function localCycleGeneration(environment: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== DEVELOPMENT_MODE ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== DEVELOPMENT_BUNDLE
  ) {
    return `unbound:${environment.EVE_AGENT_HOST ?? "unknown"}`;
  }
  const path = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (path === undefined) {
    throw new Error("The local Eve cycle binding was unavailable.");
  }
  // The binding is rotated for each Eve child. Keep the in-memory public
  // session index for the whole `mise run dev` invocation instead of treating
  // a targeted child restart as a new application.
  readLocalEveCycleBinding(path);
  return `local:${path}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function localEveRestartGeneration(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (
    environment.APP_BUILDER_EXECUTION_MODE !== DEVELOPMENT_MODE ||
    environment.APP_BUILDER_EXECUTION_BUNDLE !== DEVELOPMENT_BUNDLE
  ) {
    return;
  }
  const path = environment.APP_BUILDER_LOCAL_EVE_CYCLE_FILE;
  if (path === undefined) {
    throw new Error("The local Eve cycle binding was unavailable.");
  }
  return readLocalEveCycleBinding(path);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function resultForEvents(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[],
  cursor = 0,
  limit = 100,
  options: {
    status?: EveSessionResult["status"];
    error?: EveSessionResult["error"];
    suppressInputRequests?: boolean;
  } = {},
): EveSessionResult {
  const projected = projectInstalledEveEvents(snapshotEvents);
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInstalledEveRequests(snapshotEvents);
  const applicationSource = latestInstalledApplicationSource(snapshotEvents);
  const prototype = latestInstalledPrototype(snapshotEvents);
  const uiPreview = latestInstalledUiPreview(snapshotEvents);
  const workingPreview = latestInstalledWorkingPreview(snapshotEvents);
  const result: EveSessionResult = {
    cursor: Math.min(cursor + events.length, projected.length),
    events,
    sessionId,
    status: options.status ?? deriveInstalledEveStatus(snapshotEvents),
  };
  if (inputRequests.length !== 0 && options.suppressInputRequests !== true) {
    result.inputRequests = inputRequests;
  }
  if (applicationSource !== undefined) result.applicationSource = applicationSource;
  if (prototype !== undefined) result.prototype = prototype;
  if (uiPreview !== undefined) result.uiPreview = uiPreview;
  if (workingPreview !== undefined) result.workingPreview = workingPreview;
  if (options.error !== undefined) result.error = options.error;
  return result;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function acceptedResult(
  sessionId: string,
  snapshotEvents: readonly MessageStreamEvent[] = [],
): EveSessionResult {
  const applicationSource = latestInstalledApplicationSource(snapshotEvents);
  const prototype = latestInstalledPrototype(snapshotEvents);
  const uiPreview = latestInstalledUiPreview(snapshotEvents);
  const workingPreview = latestInstalledWorkingPreview(snapshotEvents);
  const result: EveSessionResult = {
    cursor: 0,
    events: [],
    sessionId,
    status: "working",
  };
  if (applicationSource !== undefined) result.applicationSource = applicationSource;
  if (prototype !== undefined) result.prototype = prototype;
  if (uiPreview !== undefined) result.uiPreview = uiPreview;
  if (workingPreview !== undefined) result.workingPreview = workingPreview;
  return result;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function consumeResponse(
  state: LocalEveRuntimeState,
  sessionId: string,
  response: CancellableResponse,
  modelTurnTimeoutMs: number,
  options: {
    cancelTurn: (turnId: string | undefined) => Promise<unknown>;
    consumeDurableTail: (observeEvent: (event: MessageStreamEvent) => void) => void;
    appendEvent: (events: MessageStreamEvent[], event: MessageStreamEvent) => boolean;
  },
): void {
  const events = state.sessionEvents.get(sessionId) ?? [];
  const responseGeneration = state.restartGeneration;
  state.sessionEvents.set(sessionId, events);
  state.activeResponses.set(sessionId, response);
  const readers = state.responsePumps.get(sessionId) ?? new Set<CancellableResponse>();
  readers.add(response);
  state.responsePumps.set(sessionId, readers);
  let modelTurnTimer: ReturnType<typeof setTimeout> | undefined;
  let modelTurnActive = false;
  let modelTurnId: string | undefined;
  let timedOut = false;

  const clearModelTurnTimer = () => {
    if (modelTurnTimer !== undefined) {
      clearTimeout(modelTurnTimer);
    }
    modelTurnTimer = undefined;
  };
  const settleResponseBoundary = () => {
    modelTurnActive = false;
    clearModelTurnTimer();
    if (state.activeResponses.get(sessionId) === response) {
      state.activeResponses.delete(sessionId);
    }
    if (state.modelInterruptions.get(sessionId)?.response === response) {
      state.modelInterruptions.delete(sessionId);
    }
    state.recoveryRequired.delete(sessionId);
  };
  const armModelTurnTimer = () => {
    clearModelTurnTimer();
    modelTurnTimer = setTimeout(() => {
      if (!modelTurnActive || timedOut || state.activeResponses.get(sessionId) !== response) {
        return;
      }
      timedOut = true;
      state.modelInterruptions.set(sessionId, {
        message: localModelTurnInterruptedMessage,
        response,
      });
      // A cancellation request is idempotent at Eve's durable session
      // boundary. We deliberately do not start another turn here: first wait
      // for the original turn's cancellation boundary to become observable.
      state.recoveryRequired.add(sessionId);
      // Cancellation cleanup is deliberately fire-and-forget from the timer.
      // oxlint-disable-next-line promise/prefer-await-to-then
      void settleLocalCancellation(options.cancelTurn(modelTurnId)).catch(() => null);
    }, modelTurnTimeoutMs);
    modelTurnTimer.unref?.();
  };
  const observeEvent = (event: MessageStreamEvent) => {
    switch (event.type) {
      case "step.started": {
        modelTurnActive = true;
        modelTurnId = event.data.turnId;
        armModelTurnTimer();
        return;
      }
      case "actions.requested":
      case "input.requested":
      case "session.waiting":
      case "session.completed":
      case "session.failed":
      case "turn.cancelled": {
        settleResponseBoundary();
        return;
      }
      default: {
        if (modelTurnActive) {
          armModelTurnTimer();
        }
      }
    }
  };
  state.responseObservers.set(response, observeEvent);
  void (async () => {
    try {
      for await (const event of response) {
        if (state.restartGeneration !== responseGeneration) {
          return;
        }
        if (options.appendEvent(events, event)) {
          observeEvent(event);
        }
      }
    } catch {
      state.recoveryRequired.add(sessionId);
    } finally {
      state.responseObservers.delete(response);
      readers.delete(response);
      if (readers.size === 0 && state.responsePumps.get(sessionId) === readers) {
        state.responsePumps.delete(sessionId);
      }
      if (state.restartGeneration === responseGeneration) {
        // Eve's response iterator can close after its transport reconnect budget
        // while the durable turn is still running. Keep the turn timer alive and
        // continue from the raw durable tail instead of treating that close as a
        // settled boundary.
        if (deriveInstalledEveStatus(events) === "working") {
          state.recoveryRequired.add(sessionId);
          options.consumeDurableTail(observeEvent);
        } else {
          settleResponseBoundary();
        }
      } else {
        clearModelTurnTimer();
      }
    }
  })();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createLocalEveSessionService(
  client: LocalSessionClient,
  options: {
    stateGeneration?: string;
    restartGeneration?: string;
    modelTurnTimeoutMs?: number;
    recoverTerminal?: (sessionId: string, clientRequestId: string) => Promise<void>;
    cancelRecovery?: (sessionId: string) => Promise<void>;
    isRecoveredSession?: (sessionId: string) => boolean;
  } = {},
): EveSessionService {
  const state = localRuntimeState(options.stateGeneration ?? "process");
  const localRequests = state.requests;
  const localSessionEvents = state.sessionEvents;
  const localSessionHandles = state.sessionHandles;
  const localActiveResponses = state.activeResponses;
  const modelTurnTimeoutMs = options.modelTurnTimeoutMs ?? localModelTurnTimeoutMs;

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
    for (const [sessionId, events] of localSessionEvents) {
      if (["completed", "failed", "cancelled"].includes(deriveInstalledEveStatus(events))) {
        continue;
      }
      state.tailControllers.get(sessionId)?.abort();
      state.tailControllers.delete(sessionId);
      state.tailPumps.delete(sessionId);
      localActiveResponses.delete(sessionId);
      state.responsePumps.delete(sessionId);
      // This handle belongs to the child being replaced. The next operation
      // must attach from a fresh durable snapshot, not its buffered tail.
      localSessionHandles.delete(sessionId);
      state.restartInterrupted.add(sessionId);
      state.recoveryRequired.add(sessionId);
    }
  }
  if (options.restartGeneration !== undefined) {
    state.restartGeneration = options.restartGeneration;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function sessionFor(sessionId: string): LocalSessionHandle {
    const existing = localSessionHandles.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const attached = client.sessions.attach(sessionId);
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function unavailableSession(sessionId: string): never {
    state.unavailableSessions.add(sessionId);
    state.tailControllers.get(sessionId)?.abort();
    localActiveResponses.delete(sessionId);
    throw new LocalSessionRecoveryUnavailableError();
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function readLocalSnapshot(sessionId: string, reconcileRecoveredProjection = false) {
    if (state.unavailableSessions.has(sessionId) && !reconcileRecoveredProjection) {
      throw new LocalSessionRecoveryUnavailableError();
    }
    try {
      const snapshot = await sessionFor(sessionId).snapshot();
      if (snapshot.session.sessionId !== sessionId) {
        throw new Error("Eve changed the local session during recovery.");
      }
      // A local stream read can succeed for a missing run with an empty tail.
      // It is not a resumable session and must not erase buffered progress.
      if (snapshot.events.length === 0) {
        unavailableSession(sessionId);
      }
      return snapshot;
    } catch (error) {
      if (
        error instanceof LocalSessionRecoveryUnavailableError ||
        (error instanceof ClientError && isUnavailableLocalSession(error))
      ) {
        unavailableSession(sessionId);
      }
      throw error;
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function acceptLocalContinuation(
    sessionId: string,
    operation: () => Promise<CancellableResponse>,
  ) {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof ClientError && isUnavailableLocalSession(error)) {
        unavailableSession(sessionId);
      }
      throw error;
    }
  }

  // eslint-disable-next-line eslint/func-style, eslint/require-await -- Preserve function declaration hoisting and initialization timing.
  async function recoverDurableTail(sessionId: string) {
    if (!state.recoveryRequired.has(sessionId)) {
      return;
    }
    const existing = state.recoveries.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const recovery = (async () => {
      const snapshot = await readLocalSnapshot(sessionId);
      localSessionEvents.set(sessionId, [...snapshot.events]);
      localSessionHandles.set(
        sessionId,
        client.sessions.attach(sessionId, {
          streamIndex: snapshot.session.streamIndex,
        }),
      );
      const interruption = state.modelInterruptions.get(sessionId);
      if (interruption === undefined || deriveInstalledEveStatus(snapshot.events) !== "working") {
        state.modelInterruptions.delete(sessionId);
        state.recoveryRequired.delete(sessionId);
      }
      if (deriveInstalledEveStatus(snapshot.events) !== "working") {
        state.restartInterrupted.delete(sessionId);
      }
      // Remove the recovery entry regardless of its terminal outcome.
      // oxlint-disable-next-line promise/prefer-await-to-then
    })().finally(() => state.recoveries.delete(sessionId));
    state.recoveries.set(sessionId, recovery);
    return recovery;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function sessionAtBufferedTail(sessionId: string): LocalSessionHandle {
    const attached = client.sessions.attach(sessionId, {
      streamIndex: localSessionEvents.get(sessionId)?.length ?? 0,
    });
    localSessionHandles.set(sessionId, attached);
    return attached;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function appendLocalEvent(
    sessionId: string,
    events: MessageStreamEvent[],
    event: MessageStreamEvent,
  ) {
    if (options.isRecoveredSession?.(sessionId) === true) {
      return appendImmutableLocalEvent(events, event);
    }
    events.push(event);
    return true;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function consumeDurableTail(
    sessionId: string,
    observeEvent: (event: MessageStreamEvent) => void,
  ) {
    if (state.tailPumps.has(sessionId)) {
      return;
    }
    const controller = new AbortController();
    state.tailControllers.set(sessionId, controller);
    const pump = (async () => {
      // MessageResponse has a bounded reconnect policy. A durable session may
      // outlive that HTTP response, so continue from the raw event cursor until
      // it reports a real boundary.
      while (
        !controller.signal.aborted &&
        deriveInstalledEveStatus(localSessionEvents.get(sessionId) ?? []) === "working"
      ) {
        try {
          const events = localSessionEvents.get(sessionId) ?? [];
          const session = client.sessions.attach(sessionId, {
            streamIndex: events.length,
          });
          localSessionHandles.set(sessionId, session);
          // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
          for await (const event of session.stream({ signal: controller.signal })) {
            if (controller.signal.aborted) {
              return;
            }
            if (appendLocalEvent(sessionId, events, event)) {
              observeEvent(event);
            }
            if (deriveInstalledEveStatus(events) !== "working") {
              return;
            }
          }
        } catch {
          // HMR can briefly interrupt the local child. Buffered public events
          // remain readable while the durable tail is retried.
        }
        if (
          controller.signal.aborted ||
          deriveInstalledEveStatus(localSessionEvents.get(sessionId) ?? []) !== "working"
        ) {
          return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- preserve intentional sequential control flow
        await delay(250);
      }
      // Remove the tail pump entry regardless of its terminal outcome.
      // oxlint-disable-next-line promise/prefer-await-to-then
    })().finally(() => {
      if (state.tailPumps.get(sessionId) === pump) {
        state.tailPumps.delete(sessionId);
        state.tailControllers.delete(sessionId);
      }
    });
    state.tailPumps.set(sessionId, pump);
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function consumeSessionResponse(sessionId: string, response: CancellableResponse) {
    consumeResponse(state, sessionId, response, modelTurnTimeoutMs, {
      cancelTurn: async (turnId) =>
        await sessionFor(sessionId).cancel(turnId === undefined ? undefined : { turnId }),
      consumeDurableTail: (observeEvent) => {
        consumeDurableTail(sessionId, observeEvent);
      },
      appendEvent: (events, event) => appendLocalEvent(sessionId, events, event),
    });
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function touchSession(sessionId: string) {
    const metadata = state.metadata.get(sessionId);
    if (metadata !== undefined) {
      state.metadata.set(sessionId, {
        ...metadata,
        updatedAtEpochMs: Date.now(),
      });
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function localResultOptions(sessionId: string) {
    if (state.unavailableSessions.has(sessionId)) {
      return {
        error: localSessionRecoveryError,
        status: "failed" as const,
        suppressInputRequests: true,
      };
    }
    const interruption = state.modelInterruptions.get(sessionId);
    const result: { status: "waiting" | undefined; error?: EveSessionResult["error"] } = {
      status:
        interruption !== undefined || state.restartInterrupted.has(sessionId)
          ? ("waiting" as const)
          : undefined,
    };
    if (interruption !== undefined) {
      result.error = {
        code: "model_turn_interrupted",
        message: interruption.message,
      };
    }
    return result;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function requireSettledModelTurn(sessionId: string) {
    if (state.unavailableSessions.has(sessionId)) {
      throw new LocalSessionRecoveryUnavailableError();
    }
    if (state.restartInterrupted.has(sessionId)) {
      await recoverDurableTail(sessionId);
    }
    if (state.modelInterruptions.has(sessionId)) {
      throw new Error("The previous Autograph response is still settling. Try again in a moment.");
    }
  }

  const service = Object.create(Object.prototype) as EveSessionService;
  service.start = async ({ prompt, resumeSessionId, clientRequestId, resumeMode }) => {
    if (resumeMode !== undefined && resumeMode !== "recover") {
      throw new LocalSessionRecoveryUnavailableError();
    }
    if (resumeMode === "recover") {
      if (resumeSessionId === undefined || options.recoverTerminal === undefined)
        throw new LocalSessionRecoveryUnavailableError();
      if (localActiveResponses.has(resumeSessionId) || state.continuationPumps.has(resumeSessionId))
        throw new Error(CONTINUATION_ALREADY_ACTIVE_MESSAGE);
      await options.recoverTerminal(resumeSessionId, clientRequestId);
      state.unavailableSessions.delete(resumeSessionId);
      state.recoveryRequired.delete(resumeSessionId);
      state.restartInterrupted.delete(resumeSessionId);
      state.modelInterruptions.delete(resumeSessionId);
      localSessionHandles.delete(resumeSessionId);
    }
    if (resumeSessionId !== undefined) {
      const snapshot = await readLocalSnapshot(resumeSessionId);
      localSessionEvents.set(resumeSessionId, [...snapshot.events]);
      touchSession(resumeSessionId);
      return await service.get({ cursor: 0, limit: 100, sessionId: resumeSessionId });
    }
    if (prompt === undefined) {
      throw new Error("A new App Builder session requires a prompt.");
    }
    const key = `start:${clientRequestId}`;
    const existing = localRequests.get(key);
    if (existing !== undefined) {
      if (state.unavailableSessions.has(existing)) {
        throw new LocalSessionRecoveryUnavailableError();
      }
      if (state.restartInterrupted.has(existing)) {
        return await service.get({ cursor: 0, limit: 100, sessionId: existing });
      }
      return acceptedResult(existing, localSessionEvents.get(existing));
    }
    const { session, response } = await client.sessions.create({
      message: prompt,
    });
    const { sessionId } = session.state;
    localRequests.set(key, sessionId);
    localSessionHandles.set(sessionId, session);
    const timestamp = Date.now();
    state.metadata.set(sessionId, {
      createdAtEpochMs: timestamp,
      title: localSessionTitle(prompt),
      updatedAtEpochMs: timestamp,
    });
    consumeSessionResponse(sessionId, response);
    return acceptedResult(sessionId, localSessionEvents.get(sessionId));
  };
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  service.list = async ({ cursor, limit }) => {
    const sessions = [...state.metadata.entries()]
      .toSorted(
        ([leftId, left], [rightId, right]) =>
          right.updatedAtEpochMs - left.updatedAtEpochMs || rightId.localeCompare(leftId),
      )
      .slice(cursor, cursor + limit)
      .map(([sessionId, metadata]) => {
        const result = resultForEvents(
          sessionId,
          localSessionEvents.get(sessionId) ?? [],
          0,
          100,
          localResultOptions(sessionId),
        );
        let stage: "complete" | "designing" | "prototype" | "ready";
        if (result.status === "completed") {
          stage = "complete";
        } else if (result.workingPreview === undefined || result.workingPreview === null) {
          stage = result.prototype === undefined ? "designing" : "prototype";
        } else {
          stage = "ready";
        }
        let resumability: "restart_required" | "terminal" | "live" = "live";
        if (state.unavailableSessions.has(sessionId)) {
          resumability = "restart_required";
        } else if (["completed", "failed", "cancelled"].includes(result.status)) {
          resumability = "terminal";
        }
        const app: Pick<EveSessionListResult["sessions"][number], "appId"> = {};
        if (result.uiPreview?.appId !== undefined) {
          app.appId = result.uiPreview.appId;
        }
        return {
          ...app,
          resumability,
          sessionId,
          stage,
          status: result.status,
          title: metadata.title,
          updatedAt: new Date(metadata.updatedAtEpochMs).toISOString(),
        };
      });
    return {
      cursor: cursor + sessions.length,
      kind: "session_list",
      sessions,
    };
  };
  const dispatchLocalBuildMessage = async (sessionId: string, message: string) => {
    await requireSettledModelTurn(sessionId);
    const response = await acceptLocalContinuation(
      sessionId,
      async () => await sessionAtBufferedTail(sessionId).send(message, { turnPolicy: "queue" }),
    );
    consumeSessionResponse(sessionId, response);
  };

  // GET has already reconciled canonical history. A decision is only an
  // eligibility hint here; the dispatch path still observes native state
  // and the controller rereads the durable decision.
  const hasRunnableLocalContinuation = async (sessionId: string) => {
    const approved = await readLocalBuildDecision(sessionId);
    if (approved?.decision === "runnable" && approved.scope !== undefined) {
      return true;
    }
    if (!localAuthoringConfigured()) {
      return false;
    }
    const authoring = await readLocalAuthoringDecision(sessionId);
    return authoring?.decision === "runnable" && authoring.scope !== undefined;
  };

  const continueLocalApprovedWork = async (sessionId: string): Promise<boolean> => {
    if (
      process.env.APP_BUILDER_EXECUTION_MODE !== DEVELOPMENT_MODE ||
      process.env.APP_BUILDER_EXECUTION_BUNDLE !== DEVELOPMENT_BUNDLE ||
      state.unavailableSessions.has(sessionId) ||
      localActiveResponses.has(sessionId)
    ) {
      return false;
    }
    const pending = state.continuationPumps.get(sessionId);
    if (pending !== undefined) {
      return await pending;
    }
    const work = async () => {
      if (
        options.isRecoveredSession?.(sessionId) === true &&
        !(await hasRunnableLocalContinuation(sessionId))
      ) {
        return false;
      }
      const snapshot = await readLocalSnapshot(sessionId);
      const status = deriveInstalledEveStatus(snapshot.events);
      const inputs = privateInputForEvents(snapshot.events);
      const stoppedTurns = sessionLimitCancelledTurns(inputs);
      for (const operation of state.guardOperations.values()) {
        if (
          operation.sessionId === sessionId &&
          operation.marker.stoppedBuildTurnId !== undefined &&
          provesSessionLimitResponse(operation.marker, inputs)
        )
          stoppedTurns.push(operation.marker.stoppedBuildTurnId);
      }
      if (stoppedTurns.length > 0) {
        const decision = await readLocalBuildDecision(sessionId);
        if (decision !== undefined && stoppedTurns.includes(decision.turnId)) return false;
      }
      const approved = await continueApprovedLocalBuild({
        active: status === "working",
        dispatch: async (message) => {
          await dispatchLocalBuildMessage(sessionId, message);
        },
        pendingInput: outstandingInstalledEveRequests(snapshot.events).length > 0,
        sessionId,
      });
      if (approved) return true;
      if (!localAuthoringConfigured()) return false;
      const drafting = await readLocalAuthoringDecision(sessionId);
      if (drafting !== undefined && stoppedTurns.includes(drafting.turnId)) return false;
      const outcome = await continueLocalPreapprovalAuthoring({
        sessionId,
        active: status !== "waiting",
        pendingInput: outstandingInstalledEveRequests(snapshot.events).length > 0,
        dispatch: async (message) => {
          await dispatchLocalBuildMessage(sessionId, message);
        },
        assertCurrent: async (decision) => {
          const fresh = await readLocalSnapshot(sessionId);
          const unavailable =
            state.unavailableSessions.has(sessionId) || localActiveResponses.has(sessionId);
          const active =
            deriveInstalledEveStatus(fresh.events) !== "waiting" ||
            outstandingInstalledEveRequests(fresh.events).length > 0;
          const changed = !isDeepStrictEqual(await readLocalAuthoringDecision(sessionId), decision);
          if (unavailable || active || changed)
            throw new Error("The accepted authoring boundary changed.");
          await requireSettledModelTurn(sessionId);
        },
      });
      return outcome === "queued" || outcome === "unknown";
    };
    const promise = work();
    state.continuationPumps.set(sessionId, promise);
    try {
      return await promise;
    } finally {
      if (state.continuationPumps.get(sessionId) === promise) {
        state.continuationPumps.delete(sessionId);
      }
    }
  };

  const continueLocalSessionLimit = async (
    sessionId: string,
    result: EveSessionResult,
  ): Promise<EveSessionResult> => {
    const events = localSessionEvents.get(sessionId) ?? [];
    const inputs = privateInputForEvents(events);
    const ids = guardRequestIds(inputs);
    for (const [key, operation] of state.guardOperations) {
      if (
        operation.sessionId === sessionId &&
        provesSessionLimitResponse(operation.marker, inputs)
      ) {
        operation.state = "succeeded";
        localRequests.set(key, sessionId);
      }
    }
    const settledIds = resolvedGuardRequestIds(inputs);
    for (const operation of state.guardOperations.values()) {
      if (operation.sessionId === sessionId && operation.state === "succeeded")
        settledIds.push(
          ...guardRequestIds({ pending: operation.marker.batches, resolved: [], version: 1 }),
        );
    }
    const stopAwaitingCancellation = [...state.guardOperations.values()].some(
      (operation) =>
        operation.sessionId === sessionId &&
        operation.marker.decision === "stop" &&
        !provesSessionLimitResponse(operation.marker, inputs),
    );
    if (stopAwaitingCancellation)
      return {
        ...omitControlledGuardQuestions(result, ids),
        error: {
          code: "framework_stop_settling",
          message:
            "Builder is reconciling your stop request. Keep this session and read it again; no product decision is required.",
        },
        status: "working",
      };
    if (ids.length === 0) return omitControlledGuardQuestions(result, settledIds);
    const stopped = [...state.guardOperations.values()].some(
      (operation) =>
        operation.sessionId === sessionId && matchesPendingGuardStop(operation.marker, inputs),
    );
    if (stopped)
      return {
        ...omitControlledGuardQuestions(result, ids),
        error: {
          code: "framework_stop_settling",
          message:
            "Builder is reconciling your stop request. Keep this session and read it again; no product decision is required.",
        },
        status: "working",
      };
    const expected = outstandingInstalledEveRequests(events);
    const nativeIds = inputs.pending.flatMap((batch) =>
      batch.requests.map((request) => request.requestId),
    );
    if (
      expected.some((request) => request.kind === "authorization") ||
      expected.length !== nativeIds.length ||
      expected.some((request, index) => request.requestId !== nativeIds[index])
    )
      return result;
    if (
      inputs.pending.some((batch) =>
        batch.requests.some((request) => !isLegacySessionLimitRequest(request)),
      )
    )
      return omitControlledGuardQuestions(result, ids);
    if (localActiveResponses.has(sessionId))
      return { ...omitControlledGuardQuestions(result, ids), status: "working" };
    const clientRequestId = stableId("framework_usage", {
      batch: inputs.pending[0],
      generation: state.generation,
      sessionId,
    });
    try {
      const next = await service.respond({
        clientRequestId,
        responses: mergeSessionLimitResponses(inputs, []),
        sessionId,
      });
      return {
        ...omitControlledGuardQuestions(result, ids),
        inputRequests: next.inputRequests ?? [],
        status: next.status,
      };
    } catch {
      return {
        ...omitControlledGuardQuestions(result, ids),
        error: {
          code: "framework_continuation_settling",
          message:
            "Builder is reconciling its saved continuation. Keep this session and read it again; no product decision is required.",
        },
        status: "working",
      };
    }
  };

  const hasLocalReader = (sessionId: string) =>
    localActiveResponses.has(sessionId) ||
    state.responsePumps.has(sessionId) ||
    state.tailPumps.has(sessionId);
  const reconcileLiveSnapshot = (sessionId: string, events: readonly MessageStreamEvent[]) => {
    const buffered = localSessionEvents.get(sessionId);
    if (buffered === undefined) {
      unavailableSession(sessionId);
    }
    const previousLength = buffered.length;
    try {
      appendCurrentLocalSnapshot(buffered, events);
    } catch {
      unavailableSession(sessionId);
    }
    for (const event of buffered.slice(previousLength)) {
      for (const response of state.responsePumps.get(sessionId) ?? []) {
        state.responseObservers.get(response)?.(event);
      }
    }
  };
  const refreshRecoveredTail = async (sessionId: string) => {
    // A response stream can remain attached before a normal native handoff.
    // Read current owned history even while that reader remains open.
    if (options.isRecoveredSession?.(sessionId) === true) {
      const snapshot = await readLocalSnapshot(sessionId, true);
      if (snapshot.events.length !== snapshot.session.streamIndex) {
        unavailableSession(sessionId);
      }
      if (hasLocalReader(sessionId)) {
        reconcileLiveSnapshot(sessionId, snapshot.events);
      } else {
        const buffered = localSessionEvents.get(sessionId) ?? [];
        // MessageResponse exposes a delivery-filtered stream. After a process
        // restart, a continuation could formerly seed the cache with only that
        // delivery, omitting the canonical ancestor history. Reconcile this
        // read projection only when every retained event is unchanged and in
        // order in the actual private-receipt-bound native lineage.
        let next = 0;
        for (const retained of buffered) {
          while (
            next < snapshot.events.length &&
            snapshot.events[next]?.meta.id !== retained.meta.id
          ) {
            next += 1;
          }
          if (!isDeepStrictEqual(snapshot.events[next], retained)) {
            unavailableSession(sessionId);
          }
          next += 1;
        }
        localSessionEvents.set(sessionId, [...snapshot.events]);
        localSessionHandles.set(
          sessionId,
          client.sessions.attach(sessionId, { streamIndex: snapshot.session.streamIndex }),
        );
        state.unavailableSessions.delete(sessionId);
      }
    }
  };

  service.get = async ({ sessionId, cursor, limit }) => {
    try {
      await refreshRecoveredTail(sessionId);
      if (state.restartInterrupted.has(sessionId)) {
        await recoverDurableTail(sessionId);
      }
      if (!localSessionEvents.has(sessionId)) {
        const snapshot = await readLocalSnapshot(sessionId);
        localSessionEvents.set(sessionId, [...snapshot.events]);
        localSessionHandles.set(
          sessionId,
          client.sessions.attach(sessionId, {
            streamIndex: snapshot.session.streamIndex,
          }),
        );
      }
    } catch (error) {
      if (!(error instanceof LocalSessionRecoveryUnavailableError)) {
        throw error;
      }
    }
    touchSession(sessionId);
    let result = resultForEvents(
      sessionId,
      localSessionEvents.get(sessionId) ?? [],
      cursor,
      limit,
      localResultOptions(sessionId),
    );
    result = await continueLocalSessionLimit(sessionId, result);
    if (
      pendingFrameworkGuardIds(privateInputForEvents(localSessionEvents.get(sessionId) ?? []))
        .length === 0 &&
      result.status === "waiting" &&
      (await continueLocalApprovedWork(sessionId))
    ) {
      if (
        localAuthoringConfigured() &&
        (await readLocalAuthoringDispatchState(sessionId)) === "unknown"
      )
        return {
          ...result,
          status: "working",
          error: {
            code: "preapproval_authoring_continuation_unknown",
            message:
              "The drafting continuation may have been accepted. Preserve this session and observe its outcome without resending.",
          },
        };
      return { ...result, status: "working" };
    }
    if (result.status === "waiting" && localAuthoringConfigured()) {
      return await localContinuationFailure(sessionId, result);
    }
    return result;
  };
  service.getStart = async ({ clientRequestId, cursor, limit }) => {
    const sessionId = localRequests.get(`start:${clientRequestId}`);
    if (sessionId === undefined) {
      return {
        cursor: 0,
        error: {
          code: "start_request_not_found",
          message:
            "No original start receipt is saved in this development process. Keep the original clientRequestId, any returned sessionId and transcript. Read that same sessionId with autograph_get if available; otherwise an operator must recover the original workflow state. Do not submit a replacement start.",
        },
        events: [],
        sessionId: "",
        status: "failed" as const,
      };
    }
    return await service.get({ cursor, limit, sessionId });
  };
  service.send = async ({ sessionId, message, clientRequestId }) => {
    await refreshRecoveredTail(sessionId);
    if (state.continuationPumps.has(sessionId)) {
      throw new Error(CONTINUATION_ALREADY_ACTIVE_MESSAGE);
    }
    if (state.unavailableSessions.has(sessionId)) {
      throw new LocalSessionRecoveryUnavailableError();
    }
    const key = `send:${sessionId}:${clientRequestId}`;
    if (!localRequests.has(key)) {
      await requireSettledModelTurn(sessionId);
      const response = await acceptLocalContinuation(
        sessionId,
        async () => await sessionAtBufferedTail(sessionId).send(message),
      );
      state.restartInterrupted.delete(sessionId);
      consumeSessionResponse(sessionId, response);
      localRequests.set(key, sessionId);
    }
    touchSession(sessionId);
    return acceptedResult(sessionId, localSessionEvents.get(sessionId));
  };
  const reconcileLocalGuardResponse = async (
    key: string,
    requestDigest: string,
    sessionId: string,
  ) => {
    const retained = state.guardOperations.get(key);
    if (retained !== undefined && retained.requestDigest !== requestDigest)
      throw new Error("The framework response identity changed.");
    if (retained !== undefined && retained.state === "reserved") {
      await recoverDurableTail(sessionId);
      const actual = privateInputForEvents(localSessionEvents.get(sessionId) ?? []);
      if (!provesSessionLimitResponse(retained.marker, actual))
        throw new Error("The framework continuation acceptance is still unknown.");
      retained.state = "succeeded";
      localRequests.set(key, sessionId);
    }
  };
  const prepareLocalGuardResponses = (
    sessionId: string,
    requested: Parameters<EveSessionService["respond"]>[0]["responses"],
    stopGuardOnly: boolean,
  ) => {
    let responses = requested;
    const inputs = privateInputForEvents(localSessionEvents.get(sessionId) ?? []);
    const ids = guardRequestIds(inputs);
    if (
      ids.length > 0 &&
      !stopGuardOnly &&
      !ids.every((id) => responses.some((response) => response.requestId === id))
    )
      responses = mergeSessionLimitResponses(inputs, responses);
    const expected = stopGuardOnly
      ? frameworkGuardBatches(inputs).flatMap((batch) =>
          batch.requests.map((entry) => entry.requestId),
        )
      : outstandingInstalledEveRequests(localSessionEvents.get(sessionId) ?? []).map(
          ({ requestId }) => requestId,
        );
    if (
      expected.length !== responses.length ||
      expected.some((requestId, index) => responses[index]?.requestId !== requestId)
    ) {
      throw new Error("The complete outstanding Eve input batch is required.");
    }
    return { ids, inputs, responses };
  };
  const localStoppedBuildDecision = async (sessionId: string, stopGuardOnly: boolean) =>
    stopGuardOnly &&
    process.env.APP_BUILDER_EXECUTION_MODE === DEVELOPMENT_MODE &&
    process.env.APP_BUILDER_EXECUTION_BUNDLE === DEVELOPMENT_BUNDLE
      ? await readLocalBuildDecision(sessionId)
      : undefined;
  const localGuardMarker = async (
    sessionId: string,
    inputs: PrivateInputState,
    stopGuardOnly: boolean,
    responses: Parameters<EveSessionService["respond"]>[0]["responses"],
  ): Promise<InternalSessionLimitResponse> => {
    const stoppedDecision = await localStoppedBuildDecision(sessionId, stopGuardOnly);
    const marker: Pick<
      InternalSessionLimitResponse,
      "adapterGeneration" | "adapterSessionId" | "batches" | "decision" | "stoppedBuildTurnId"
    > = {
      adapterGeneration: 1,
      adapterSessionId: sessionId,
      batches: stopGuardOnly ? frameworkGuardBatches(inputs) : inputs.pending,
      decision: stopGuardOnly ? "stop" : "continue",
    };
    if (stoppedDecision !== undefined) {
      marker.stoppedBuildTurnId = stoppedDecision.turnId;
    }
    return {
      ...marker,
      responses: nativeResponses(responses),
    };
  };
  const respondLocal = async (
    request: Parameters<EveSessionService["respond"]>[0],
    stopGuardOnly = false,
  ) => {
    const { sessionId, responses: requestedResponses, clientRequestId } = request;
    let responses = requestedResponses;
    await refreshRecoveredTail(sessionId);
    if (state.continuationPumps.has(sessionId)) {
      throw new Error(CONTINUATION_ALREADY_ACTIVE_MESSAGE);
    }
    if (state.unavailableSessions.has(sessionId)) {
      throw new LocalSessionRecoveryUnavailableError();
    }
    const key = `respond:${sessionId}:${clientRequestId}`;
    const requestDigest = digest({ clientRequestId, responses, sessionId });
    await reconcileLocalGuardResponse(key, requestDigest, sessionId);
    if (!localRequests.has(key)) {
      await requireSettledModelTurn(sessionId);
      const prepared = prepareLocalGuardResponses(sessionId, responses, stopGuardOnly);
      const { ids, inputs } = prepared;
      ({ responses } = prepared);
      if (ids.length > 0)
        state.guardOperations.set(key, {
          marker: await localGuardMarker(sessionId, inputs, stopGuardOnly, responses),
          requestDigest,
          sessionId,
          state: "reserved",
        });
      let result: CancellableResponse;
      try {
        result = await acceptLocalContinuation(
          sessionId,
          async () =>
            await sessionAtBufferedTail(sessionId).respond(toEveInputResponses(responses)),
        );
      } catch (error) {
        if (ids.length > 0) {
          state.recoveryRequired.add(sessionId);
          state.restartInterrupted.add(sessionId);
        }
        throw error;
      }
      const operation = state.guardOperations.get(key);
      if (operation !== undefined) operation.state = "succeeded";
      state.restartInterrupted.delete(sessionId);
      consumeSessionResponse(sessionId, result);
      localRequests.set(key, sessionId);
    }
    touchSession(sessionId);
    return acceptedResult(sessionId, localSessionEvents.get(sessionId));
  };
  service.respond = respondLocal;
  const stopLocalSessionLimitGuard = async (
    sessionId: string,
    turnId: string | undefined,
  ): Promise<EveSessionResult | undefined> => {
    const currentInputs = privateInputForEvents(localSessionEvents.get(sessionId) ?? []);
    if (guardRequestIds(currentInputs).length > 0 || !localSessionEvents.has(sessionId)) {
      const snapshot = await readLocalSnapshot(sessionId);
      localSessionEvents.set(sessionId, [...snapshot.events]);
      const inputs = privateInputForEvents(snapshot.events);
      const batches = frameworkGuardBatches(inputs);
      const [batch] = batches;
      if (batch !== undefined) {
        if (
          batches.some((entry) =>
            entry.requests.some((pending) => !pending.optionIds.includes("stop")),
          )
        )
          throw new Error("The cancellation input batch changed.");
        if (turnId !== undefined && batches.some((entry) => entry.turnId !== turnId))
          throw new Error("The cancellation turn changed.");
        const request = {
          clientRequestId: stableId("framework_stop", {
            batch,
            generation: state.generation,
            sessionId,
          }),
          responses: batches.flatMap((entry) =>
            entry.requests.map((pending) => ({
              requestId: pending.requestId,
              response: { kind: "answer" as const, optionId: "stop", value: "stop" },
            })),
          ),
          sessionId,
        };
        return await respondLocal(request, true);
      }
    }
    return undefined;
  };
  service.cancel = async ({ sessionId, turnId }) => {
    await options.cancelRecovery?.(sessionId);
    if (localAuthoringConfigured()) await blockLocalAuthoringContinuation(sessionId, turnId);
    if (state.unavailableSessions.has(sessionId)) {
      throw new LocalSessionRecoveryUnavailableError();
    }
    if (state.restartInterrupted.has(sessionId)) {
      touchSession(sessionId);
      return resultForEvents(sessionId, localSessionEvents.get(sessionId) ?? [], 0, 100, {
        status: "waiting",
      });
    }
    const stopped = await stopLocalSessionLimitGuard(sessionId, turnId);
    if (stopped !== undefined) return stopped;
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
          sessionFor(sessionId).cancel(turnId === undefined ? undefined : { turnId }),
        );
      } catch (error) {
        if (error instanceof HostedCancellationUnsettledError) {
          state.recoveryRequired.add(sessionId);
        }
        throw error;
      }
    }
    touchSession(sessionId);
    return resultForEvents(sessionId, localSessionEvents.get(sessionId) ?? []);
  };
  const { getStart } = service;
  const present = (result: EveSessionResult): EveSessionResult =>
    presentSessionLimitState(
      result,
      privateInputForEvents(localSessionEvents.get(result.sessionId) ?? []),
    );
  return {
    ...service,
    cancel: async (request) => present(await service.cancel(request)),
    get: async (request) => present(await service.get(request)),
    ...(getStart === undefined
      ? {}
      : {
          getStart: async (request: Parameters<NonNullable<EveSessionService["getStart"]>>[0]) =>
            present(await getStart(request)),
        }),
    respond: async (request) => present(await service.respond(request)),
    send: async (request) => present(await service.send(request)),
    start: async (request) => present(await service.start(request)),
  };
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
const notConfigured = async (): Promise<never> => {
  throw new AdapterNotConfiguredError();
};

/** Hosted use stays fail-closed until the authenticated durable adapter is wired. */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createEveSessionService(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): EveSessionService {
  const host = environment.EVE_AGENT_HOST;
  if (environment.APP_BUILDER_LOCAL_ADAPTER === "1" && host !== undefined) {
    const url = new URL(host);
    if (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
      throw new Error("The local Eve adapter requires a loopback EVE_AGENT_HOST.");
    }
    const client = new Client({ host: url.origin, redirect: "error" });
    const recovery = createLocalNativeRecovery(environment);
    return createLocalEveSessionService(
      recovery === undefined
        ? client
        : withLocalRecoveredSessions(client, recovery, async (sessionId, body) => {
            const response = await fetch(
              new URL(`/eve/v1/session/${encodeURIComponent(sessionId)}`, url.origin),
              {
                method: "POST",
                redirect: "error",
                headers: { "content-type": "application/json" },
                body: JSON.stringify(body),
              },
            );
            const value: unknown = await response.json();
            if (!response.ok) {
              const code = z.object({ code: z.string().max(256).optional() }).safeParse(value);
              throw new ClientError(
                response.status,
                JSON.stringify({
                  code: code.success ? code.data.code : undefined,
                  error: "The local session control was rejected.",
                }),
              );
            }
            return localRecoveredControlReceiptSchema.parse(value);
          }),
      {
        restartGeneration: localEveRestartGeneration(environment),
        stateGeneration: localCycleGeneration(environment),
        ...(recovery === undefined
          ? {}
          : {
              isRecoveredSession: (sessionId: string) => recovery.lineage(sessionId).length > 1,
              cancelRecovery: async (sessionId: string) => {
                await recovery.cancel(sessionId);
              },
              recoverTerminal: async (sessionId: string, requestId: string) => {
                await recovery.recover(client, sessionId, requestId, async (body) => {
                  const response = await fetch(new URL("/eve/v1/session", url.origin), {
                    method: "POST",
                    redirect: "error",
                    headers: { "content-type": "application/json" },
                    body: JSON.stringify(body),
                  });
                  if (!response.ok) throw new LocalSessionRecoveryUnavailableError();
                  return localRecoveryResponseSchema.parse(await response.json());
                });
              },
            }),
      },
    );
  }
  return {
    cancel: notConfigured,
    get: notConfigured,
    list: notConfigured,
    respond: notConfigured,
    send: notConfigured,
    start: notConfigured,
  };
}
