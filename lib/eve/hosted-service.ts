import { z } from "zod";

import type { EveSessionService } from "./service";
import {
  hostedPrincipalSchema,
  requireHostedOperationScope,
  tenantKeyFor,
  type HostedPrincipal,
} from "./hosted-auth";
import {
  hostedOperationRecordSchema,
  DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  durableHostedSessionRecordSchema,
  hostedSessionCheckpointDigest,
  hostedSessionCheckpointProgressDigest,
  hostedSessionCheckpointSchema,
  hostedSessionCreationDigest,
  hostedSessionRecordDigest,
  hostedSessionRecordSchema,
  hostedSessionSummary,
  hostedSessionTimeoutPolicySchema,
  reserveOperationResultSchema,
  toDurableHostedSessionRecord,
  type HostedEveStore,
  type HostedOperationKind,
  type HostedOperationRecord,
  type HostedSessionCheckpoint,
  type HostedSessionTimeoutPolicy,
} from "./hosted-store";
import {
  outstandingInternalEveRequests,
  toPublicEvent,
  type InternalEveEvent,
} from "./public-events";
import {
  eveSessionResultSchema,
  publicImplementationPlanSchema,
  publicInputRequestSchema,
  publicPrototypeSchema,
  publicEveEventSchema,
  publicSessionStageSchema,
  sessionStatusSchema,
  type EveSessionResult,
  type PublicInputRequest,
} from "../mcp/contracts";
import type { HostedPreviewAdmissionControlBinding } from "../hosted/admission-control";
import { hostedValueDigest, stableHostedId } from "./hosted-session-identity";

const hostedSnapshotSchema = z
  .object({
    status: sessionStatusSchema,
    events: z.array(z.unknown()).max(100_000),
    prototype: publicPrototypeSchema.optional(),
    implementationPlan: publicImplementationPlanSchema.optional(),
  })
  .strict();

export type HostedEngineSnapshot = z.infer<typeof hostedSnapshotSchema>;

export interface HostedEveTransport {
  start(input: {
    principal: HostedPrincipal;
    operationId: string;
    prompt: string;
  }): Promise<{ adapterSessionId: string; snapshot: HostedEngineSnapshot }>;
  get(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
  }): Promise<HostedEngineSnapshot>;
  send(input: {
    principal: HostedPrincipal;
    operationId: string;
    adapterSessionId: string;
    message: string;
  }): Promise<HostedEngineSnapshot>;
  respond(input: {
    principal: HostedPrincipal;
    operationId: string;
    adapterSessionId: string;
    responses: Array<{
      requestId: string;
      response:
        | { kind: "approve" }
        | { kind: "deny" }
        | { kind: "answer"; value: string; optionId?: string };
    }>;
  }): Promise<HostedEngineSnapshot>;
  cancel(input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    turnId?: string;
  }): Promise<HostedEngineSnapshot>;
}

export class HostedSessionNotFoundError extends Error {
  constructor() {
    super("The hosted Eve session was not found.");
    this.name = "HostedSessionNotFoundError";
  }
}

export class HostedAdapterSessionUnavailableError extends Error {
  constructor() {
    super("The underlying Eve session is unavailable.");
    this.name = "HostedAdapterSessionUnavailableError";
  }
}

export class HostedSessionRecoveryUnavailableError extends Error {
  constructor() {
    super("The App Builder session has no recoverable checkpoint.");
    this.name = "HostedSessionRecoveryUnavailableError";
  }
}

export class HostedSessionBusyError extends Error {
  constructor() {
    super("Another continuation is already active for this session.");
    this.name = "HostedSessionBusyError";
  }
}

export class HostedIdempotencyConflictError extends Error {
  constructor() {
    super("The client request identifier is already bound to another request.");
    this.name = "HostedIdempotencyConflictError";
  }
}

export class HostedSubmissionUnknownError extends Error {
  constructor() {
    super(
      "The hosted Eve submission outcome is unknown and will not be replayed.",
    );
    this.name = "HostedSubmissionUnknownError";
  }
}

export class HostedCancellationUnsettledError extends Error {
  constructor() {
    super("Cancellation was accepted but has not settled; use autograph_get.");
    this.name = "HostedCancellationUnsettledError";
  }
}

export class HostedRejectedOperationError extends Error {
  readonly code: string;

  constructor(code = "operation_rejected") {
    super("The hosted Eve operation was rejected before a durable result.");
    this.name = "HostedRejectedOperationError";
    this.code = code;
  }
}

export class HostedAdmissionDeniedError extends Error {
  constructor() {
    super("The hosted Eve admission limit was reached.");
    this.name = "HostedAdmissionDeniedError";
  }
}

/** Transport adapters use this only when dispatch may have reached Eve. */
export class SubmissionOutcomeUnknownError extends Error {
  constructor() {
    super("The Eve transport cannot determine whether submission occurred.");
    this.name = "SubmissionOutcomeUnknownError";
  }
}

/** Transport adapters may use this only when they prove dispatch did not run. */
export class SubmissionRejectedBeforeDispatchError extends Error {
  readonly code: string;

  constructor(code = "submission_rejected") {
    super("The Eve transport rejected the operation before dispatch.");
    this.name = "SubmissionRejectedBeforeDispatchError";
    this.code = code;
  }
}

function assertNever(value: never): never {
  void value;
  throw new HostedSubmissionUnknownError();
}

function projectSnapshot(
  sessionId: string,
  snapshotInput: unknown,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const snapshot = hostedSnapshotSchema.parse(snapshotInput);
  const projected = snapshot.events
    .flatMap((candidate) => {
      if (candidate === null || typeof candidate !== "object") return [];
      const projected = toPublicEvent(candidate as InternalEveEvent);
      if (projected === null) return [];
      const parsed = publicEveEventSchema.safeParse(projected);
      return parsed.success ? [parsed.data] : [];
    })
    .map((event, index) => ({ ...event, index }));
  const events = projected.slice(cursor, cursor + limit);
  const inputRequests = outstandingInternalEveRequests(
    snapshot.events.filter(
      (event): event is InternalEveEvent =>
        event !== null && typeof event === "object",
    ),
  );
  return eveSessionResultSchema.parse({
    sessionId,
    status: snapshot.status,
    cursor: Math.min(cursor + events.length, projected.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(snapshot.prototype === undefined
      ? {}
      : { prototype: snapshot.prototype }),
    ...(snapshot.implementationPlan === undefined
      ? {}
      : { implementationPlan: snapshot.implementationPlan }),
  });
}

function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 200) || "Untitled app";
}

function stageForResult(
  result: EveSessionResult,
): z.infer<typeof publicSessionStageSchema> {
  if (result.status === "completed") return "complete";
  if (["failed", "cancelled"].includes(result.status)) return "needs_attention";
  if (result.implementationPlan !== undefined) return "ready";
  if (result.prototype !== undefined) return "prototype";
  if (result.status === "input_required") return "needs_attention";
  if (result.status === "working") return "designing";
  return "planning";
}

type CheckpointInputProfile = {
  titleBytes: number;
  descriptionBytes: number;
  optionCount: number;
  optionLabelBytes: number;
  authorizationInstructionBytes: number;
  repositoryScopeCount: number;
};

const checkpointInputProfiles: readonly CheckpointInputProfile[] = [
  {
    titleBytes: 2_048,
    descriptionBytes: 4_096,
    optionCount: 32,
    optionLabelBytes: 512,
    authorizationInstructionBytes: 1_000,
    repositoryScopeCount: 32,
  },
  {
    titleBytes: 512,
    descriptionBytes: 1_024,
    optionCount: 16,
    optionLabelBytes: 256,
    authorizationInstructionBytes: 512,
    repositoryScopeCount: 16,
  },
  {
    titleBytes: 128,
    descriptionBytes: 0,
    optionCount: 4,
    optionLabelBytes: 64,
    authorizationInstructionBytes: 0,
    repositoryScopeCount: 4,
  },
];

function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes === 0) return "";
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) return value;
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (encoder.encode(value.slice(0, midpoint)).byteLength <= maximumBytes)
      lower = midpoint;
    else upper = midpoint - 1;
  }
  const end =
    lower > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(lower - 1))
      ? lower - 1
      : lower;
  return value.slice(0, end);
}

function checkpointInputRequest(
  request: PublicInputRequest,
  profile: CheckpointInputProfile,
): PublicInputRequest {
  const options = request.options
    ?.slice(0, profile.optionCount)
    .map(({ id, label }) => ({
      id,
      label: truncateUtf8(label, profile.optionLabelBytes),
    }));
  const authorization = request.authorization;
  const repositoryAccess = authorization?.repositoryAccess;
  return publicInputRequestSchema.parse({
    requestId: request.requestId,
    kind: request.kind,
    title: truncateUtf8(request.title, profile.titleBytes),
    ...(profile.descriptionBytes === 0 || request.description === undefined
      ? {}
      : {
          description: truncateUtf8(
            request.description,
            profile.descriptionBytes,
          ),
        }),
    ...(options === undefined || options.length === 0 ? {} : { options }),
    allowFreeform: request.allowFreeform,
    ...(request.presentation === undefined
      ? {}
      : { presentation: request.presentation }),
    ...(authorization === undefined
      ? {}
      : {
          authorization: {
            ...(authorization.url === undefined
              ? {}
              : { url: authorization.url }),
            ...(authorization.userCode === undefined
              ? {}
              : { userCode: authorization.userCode }),
            ...(authorization.expiresAt === undefined
              ? {}
              : { expiresAt: authorization.expiresAt }),
            ...(profile.authorizationInstructionBytes === 0 ||
            authorization.instructions === undefined
              ? {}
              : {
                  instructions: truncateUtf8(
                    authorization.instructions,
                    profile.authorizationInstructionBytes,
                  ),
                }),
            ...(authorization.displayName === undefined
              ? {}
              : { displayName: authorization.displayName }),
            ...(repositoryAccess === undefined
              ? {}
              : {
                  repositoryAccess: {
                    ...repositoryAccess,
                    scopes: repositoryAccess.scopes.slice(
                      0,
                      profile.repositoryScopeCount,
                    ),
                  },
                }),
          },
        }),
  });
}

function checkpointEvent(
  event: z.infer<typeof publicEveEventSchema>,
  profile: CheckpointInputProfile,
): z.infer<typeof publicEveEventSchema> {
  if (event.type === "input_required")
    return {
      ...event,
      request: checkpointInputRequest(event.request, profile),
    };
  return event;
}

function checkpointForSnapshot(
  sessionId: string,
  snapshot: HostedEngineSnapshot,
  capturedAtEpochMs: number,
): HostedSessionCheckpoint {
  const ring = new Array<z.infer<typeof publicEveEventSchema>>(512);
  let publicEventCount = 0;
  for (const candidate of snapshot.events) {
    if (candidate === null || typeof candidate !== "object") continue;
    const projected = toPublicEvent(candidate as InternalEveEvent);
    if (projected === null) continue;
    const parsed = publicEveEventSchema.safeParse({
      ...projected,
      index: publicEventCount,
    });
    if (!parsed.success) continue;
    const event = parsed.data;
    ring[publicEventCount % ring.length] =
      event.type === "assistant_message"
        ? { ...event, text: event.text.slice(-65_536) }
        : event.type === "progress"
          ? { ...event, label: event.label.slice(-4_096) }
          : event.type === "error"
            ? {
                ...event,
                code: event.code.slice(0, 100),
                message: event.message.slice(-65_536),
              }
            : event;
    publicEventCount += 1;
  }
  const retainedCount = Math.min(publicEventCount, ring.length);
  const events = Array.from({ length: retainedCount }, (_, index) => {
    const absoluteIndex = publicEventCount - retainedCount + index;
    return ring[absoluteIndex % ring.length]!;
  });
  const outstandingRequests = outstandingInternalEveRequests(
    snapshot.events.filter(
      (event): event is InternalEveEvent =>
        event !== null && typeof event === "object",
    ),
  );

  function fitCheckpoint(input: {
    profile: CheckpointInputProfile;
    includePrototype: boolean;
    includeImplementationPlan: boolean;
  }) {
    const boundedEvents = events.map((event) =>
      checkpointEvent(event, input.profile),
    );
    const inputRequests = outstandingRequests
      .slice(0, 32)
      .map((request) => checkpointInputRequest(request, input.profile));
    let lower = 0;
    let upper = boundedEvents.length;
    let best: HostedSessionCheckpoint | undefined;
    while (lower <= upper) {
      const retainedCount = Math.floor((lower + upper) / 2);
      const retainedEvents =
        retainedCount === 0 ? [] : boundedEvents.slice(-retainedCount);
      const candidate = hostedSessionCheckpointSchema.safeParse({
        version: 1,
        status: snapshot.status,
        events: retainedEvents,
        ...(retainedEvents[0] === undefined
          ? publicEventCount === 0
            ? {}
            : { truncatedBeforeIndex: publicEventCount }
          : retainedEvents[0].index === 0
            ? {}
            : { truncatedBeforeIndex: retainedEvents[0].index }),
        ...(inputRequests.length === 0 ? {} : { inputRequests }),
        ...(input.includePrototype && snapshot.prototype !== undefined
          ? { prototype: snapshot.prototype }
          : {}),
        ...(input.includeImplementationPlan &&
        snapshot.implementationPlan !== undefined
          ? { implementationPlan: snapshot.implementationPlan }
          : {}),
        capturedAtEpochMs,
      });
      if (candidate.success) {
        best = candidate.data;
        lower = retainedCount + 1;
      } else {
        upper = retainedCount - 1;
      }
    }
    return best;
  }

  for (const profile of checkpointInputProfiles) {
    const checkpoint = fitCheckpoint({
      profile,
      includePrototype: true,
      includeImplementationPlan: true,
    });
    if (checkpoint !== undefined) return checkpoint;
  }

  const minimalProfile = checkpointInputProfiles.at(-1)!;
  for (const artifactSelection of [
    { includePrototype: false, includeImplementationPlan: true },
    { includePrototype: true, includeImplementationPlan: false },
    { includePrototype: false, includeImplementationPlan: false },
  ]) {
    const checkpoint = fitCheckpoint({
      profile: minimalProfile,
      ...artifactSelection,
    });
    if (checkpoint !== undefined) return checkpoint;
  }

  // A structurally valid fallback prevents an oversized transport snapshot
  // from turning an already-dispatched mutation into an unknown outcome.
  return {
    version: 1,
    status: snapshot.status,
    events: [],
    ...(publicEventCount === 0
      ? {}
      : { truncatedBeforeIndex: publicEventCount }),
    capturedAtEpochMs,
  };
}

function resultFromCheckpoint(
  sessionId: string,
  checkpoint: HostedSessionCheckpoint,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const offset = checkpoint.truncatedBeforeIndex ?? 0;
  const effectiveCursor = Math.max(cursor, offset);
  const start = effectiveCursor - offset;
  const events = checkpoint.events.slice(start, start + limit);
  return eveSessionResultSchema.parse({
    sessionId,
    status: checkpoint.status === "working" ? "waiting" : checkpoint.status,
    cursor: Math.min(
      effectiveCursor + events.length,
      offset + checkpoint.events.length,
    ),
    events,
    ...(checkpoint.inputRequests === undefined
      ? {}
      : { inputRequests: checkpoint.inputRequests }),
    ...(checkpoint.prototype === undefined
      ? {}
      : { prototype: checkpoint.prototype }),
    ...(checkpoint.implementationPlan === undefined
      ? {}
      : { implementationPlan: checkpoint.implementationPlan }),
  });
}

function recoveryPrompt(
  record: z.infer<typeof durableHostedSessionRecordSchema>,
) {
  const checkpoint = record.checkpoint;
  if (checkpoint === undefined)
    throw new HostedSessionRecoveryUnavailableError();
  const messages = checkpoint.events
    .filter(
      (event): event is Extract<typeof event, { type: "assistant_message" }> =>
        event.type === "assistant_message",
    )
    .slice(-20)
    .map(({ text }) => text)
    .join("\n\n")
    .slice(-12_000);
  return [
    "Continue this interrupted Autograph App Builder session from its durable checkpoint.",
    `Product title: ${record.title}`,
    record.appId === undefined ? undefined : `App id: ${record.appId}`,
    checkpoint.prototype === undefined
      ? undefined
      : `Prototype: ${checkpoint.prototype.path} (${checkpoint.prototype.digest})`,
    checkpoint.implementationPlan === undefined
      ? undefined
      : `Implementation plan: ${JSON.stringify(checkpoint.implementationPlan)}`,
    checkpoint.inputRequests === undefined
      ? undefined
      : `Outstanding unresolved product requests from the prior runtime (the exact prior request IDs are retained for reconciliation): ${JSON.stringify(checkpoint.inputRequests)}`,
    messages.length === 0
      ? undefined
      : `Prior product conversation:\n${messages}`,
    checkpoint.inputRequests === undefined
      ? undefined
      : "Reissue every unresolved product request before later work. Do not infer that any of them was answered or approved.",
    "Preserve the prior product decisions, revalidate current source access before any repository work, and continue from the next unfinished product step.",
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

export function createHostedEveSessionService(input: {
  principal: HostedPrincipal;
  store: HostedEveStore;
  transport: HostedEveTransport;
  beforeRead?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    adapterSessionId: string;
  }) => Promise<void>;
  now?: () => number;
  admissionControl?: HostedPreviewAdmissionControlBinding;
  sessionTimeoutPolicy?: HostedSessionTimeoutPolicy;
}): EveSessionService {
  const principal = hostedPrincipalSchema.parse(input.principal);
  const now = input.now ?? Date.now;
  const sessionTimeoutPolicy = hostedSessionTimeoutPolicySchema.parse(
    input.sessionTimeoutPolicy ?? DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  );

  function requireOwnedOperation(
    operationInput: unknown,
    expected: {
      operationId: string;
      requestDigest: string;
      kind: HostedOperationKind;
      clientRequestId: string;
      sessionId?: string;
      resumeSessionId?: string;
    },
  ) {
    const operation = hostedOperationRecordSchema.parse(operationInput);
    if (
      tenantKeyFor(operation.principal) !== tenantKeyFor(principal) ||
      operation.operationId !== expected.operationId ||
      operation.requestDigest !== expected.requestDigest ||
      operation.kind !== expected.kind ||
      operation.clientRequestId !== expected.clientRequestId ||
      operation.resumeSessionId !== expected.resumeSessionId ||
      (expected.sessionId === undefined
        ? operation.kind === "start" &&
          operation.state !== "succeeded" &&
          operation.sessionId !== undefined
        : operation.sessionId !== expected.sessionId)
    ) {
      throw new HostedSubmissionUnknownError();
    }
    return operation;
  }

  async function requireSession(sessionId: string) {
    const session = await input.store.getSession(principal, sessionId);
    if (session === null) throw new HostedSessionNotFoundError();
    const parsed = hostedSessionRecordSchema.parse(session);
    if (
      parsed.sessionId !== sessionId ||
      tenantKeyFor(parsed.principal) !== tenantKeyFor(principal)
    ) {
      throw new HostedSessionNotFoundError();
    }
    return parsed;
  }

  async function requireBoundSucceededStartSession(
    operation: HostedOperationRecord,
  ) {
    if (
      operation.kind !== "start" ||
      operation.state !== "succeeded" ||
      operation.sessionRecordDigest === undefined
    ) {
      throw new HostedSubmissionUnknownError();
    }
    try {
      const storedSession = await input.store.getSession(
        principal,
        operation.sessionId,
      );
      if (storedSession === null) {
        throw new HostedSubmissionUnknownError();
      }
      const verifiedSession = hostedSessionRecordSchema.parse(storedSession);
      if (
        verifiedSession.sessionId !== operation.sessionId ||
        tenantKeyFor(verifiedSession.principal) !== tenantKeyFor(principal) ||
        hostedSessionCreationDigest(verifiedSession) !==
          operation.sessionRecordDigest
      ) {
        throw new HostedSubmissionUnknownError();
      }
      return verifiedSession;
    } catch {
      throw new HostedSubmissionUnknownError();
    }
  }

  async function mutate<T extends { clientRequestId: string }>(options: {
    kind: HostedOperationKind;
    request: T;
    sessionId?: string;
    resumeSessionId?: string;
    dispatch(operationId: string): Promise<{
      result: EveSessionResult;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
    }>;
  }): Promise<EveSessionResult> {
    const requestDigest = hostedValueDigest({
      kind: options.kind,
      request: options.request,
      sessionId: options.sessionId,
    });
    const operationId = stableHostedId("op", {
      tenant: [
        principal.issuer,
        principal.audience,
        principal.workspaceId,
        principal.ownerUserId,
      ],
      kind: options.kind,
      clientRequestId: options.request.clientRequestId,
    });
    const timestamp = now();
    const candidate = hostedOperationRecordSchema.parse({
      version: 1,
      operationId,
      principal,
      kind: options.kind,
      clientRequestId: options.request.clientRequestId,
      requestDigest,
      state: "reserved",
      ...(options.sessionId === undefined
        ? {}
        : { sessionId: options.sessionId }),
      ...(options.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
      createdAtEpochMs: timestamp,
      updatedAtEpochMs: timestamp,
    });
    let reservation: z.infer<typeof reserveOperationResultSchema>;
    try {
      reservation = reserveOperationResultSchema.parse(
        await input.store.reserveOperation(
          principal,
          candidate,
          options.kind === "start" && input.admissionControl !== undefined
            ? {
                binding: input.admissionControl,
                nowEpochMs: timestamp,
                sessionTimeoutPolicy,
              }
            : undefined,
        ),
      );
    } catch {
      throw new HostedSubmissionUnknownError();
    }
    switch (reservation.disposition) {
      case "conflict":
        throw new HostedIdempotencyConflictError();
      case "rejected":
        if (reservation.reason === "session_busy")
          throw new HostedSessionBusyError();
        throw new HostedAdmissionDeniedError();
      case "reserved": {
        const operation = requireOwnedOperation(reservation.operation, {
          operationId,
          requestDigest,
          kind: options.kind,
          clientRequestId: options.request.clientRequestId,
          sessionId: options.sessionId,
          resumeSessionId: options.resumeSessionId,
        });
        if (operation.state !== "reserved") {
          throw new HostedSubmissionUnknownError();
        }
        break;
      }
      case "existing": {
        const operation = requireOwnedOperation(reservation.operation, {
          operationId,
          requestDigest,
          kind: options.kind,
          clientRequestId: options.request.clientRequestId,
          sessionId: options.sessionId,
          resumeSessionId: options.resumeSessionId,
        });
        switch (operation.state) {
          case "succeeded": {
            const result = eveSessionResultSchema.parse(operation.result);
            if (operation.kind === "start") {
              await requireBoundSucceededStartSession(operation);
            }
            return result;
          }
          case "submission_unknown":
          case "reserved":
            throw new HostedSubmissionUnknownError();
          case "rejected":
            throw new HostedRejectedOperationError(operation.safeErrorCode);
          default:
            return assertNever(operation);
        }
        break;
      }
      default:
        return assertNever(reservation);
    }

    let dispatched: {
      result: EveSessionResult;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
    };
    try {
      dispatched = await options.dispatch(operationId);
    } catch (error) {
      const rejected = error instanceof SubmissionRejectedBeforeDispatchError;
      let settlementVerified = false;
      try {
        const settled = await input.store.settleUnsuccessful({
          principal,
          operationId,
          requestDigest,
          state: rejected ? "rejected" : "submission_unknown",
          safeErrorCode: rejected ? error.code : "submission_unknown",
          nowEpochMs: now(),
        });
        const verified = requireOwnedOperation(settled, {
          operationId,
          requestDigest,
          kind: options.kind,
          clientRequestId: options.request.clientRequestId,
          sessionId: options.sessionId,
          resumeSessionId: options.resumeSessionId,
        });
        const expectedState = rejected ? "rejected" : "submission_unknown";
        const expectedCode = rejected ? error.code : "submission_unknown";
        settlementVerified =
          verified.state === expectedState &&
          verified.safeErrorCode === expectedCode;
      } catch {
        // The caller cannot know whether the durable transition committed.
        // `reserved` remains non-replayable; a committed terminal record is
        // interpreted from the store on a later exact retry.
      }
      if (!settlementVerified) throw new HostedSubmissionUnknownError();
      if (rejected) throw new HostedRejectedOperationError(error.code);
      throw new HostedSubmissionUnknownError();
    }

    try {
      const dispatchedResult = eveSessionResultSchema.parse(dispatched.result);
      const dispatchedSession =
        dispatched.newSession === undefined
          ? undefined
          : hostedSessionRecordSchema.parse(dispatched.newSession);
      if (
        (options.kind === "start" && dispatchedSession === undefined) ||
        (options.kind !== "start" && dispatchedSession !== undefined) ||
        (dispatchedSession !== undefined &&
          dispatchedResult.sessionId !== dispatchedSession.sessionId)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      const settled = await input.store.settleSucceeded({
        principal,
        operationId,
        requestDigest,
        result: dispatchedResult,
        ...(dispatchedSession === undefined
          ? {}
          : { session: dispatchedSession }),
        nowEpochMs: now(),
      });
      const verified = requireOwnedOperation(settled, {
        operationId,
        requestDigest,
        kind: options.kind,
        clientRequestId: options.request.clientRequestId,
        sessionId: options.sessionId,
        resumeSessionId: options.resumeSessionId,
      });
      if (verified.state !== "succeeded") {
        throw new HostedSubmissionUnknownError();
      }
      const verifiedResult = eveSessionResultSchema.parse(verified.result);
      if (
        hostedValueDigest(verifiedResult) !==
          hostedValueDigest(dispatchedResult) ||
        canonical(verifiedResult) !== canonical(dispatchedResult)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      if (dispatchedSession !== undefined) {
        if (verifiedResult.sessionId !== dispatchedSession.sessionId) {
          throw new HostedSubmissionUnknownError();
        }
        if (
          verified.sessionRecordDigest !==
          hostedSessionCreationDigest(dispatchedSession)
        ) {
          throw new HostedSubmissionUnknownError();
        }
        const verifiedSession =
          await requireBoundSucceededStartSession(verified);
        if (
          hostedSessionRecordDigest(verifiedSession) !==
            hostedSessionRecordDigest(dispatchedSession) ||
          canonical(verifiedSession) !== canonical(dispatchedSession)
        ) {
          throw new HostedSubmissionUnknownError();
        }
      }
      return verifiedResult;
    } catch {
      // Eve may have accepted the mutation even if durable settlement failed.
      // Leave the reservation non-replayable. If the transaction committed and
      // only its response was lost, the next retry recovers the stored result.
      throw new HostedSubmissionUnknownError();
    }
  }

  async function observeSnapshot(
    sessionId: string,
    snapshot: HostedEngineSnapshot,
    resumability: "live" | "terminal" = [
      "completed",
      "failed",
      "cancelled",
    ].includes(snapshot.status)
      ? "terminal"
      : "live",
  ) {
    const timestamp = now();
    const completeResult = projectSnapshot(sessionId, snapshot, 0, 100);
    const checkpoint = checkpointForSnapshot(sessionId, snapshot, timestamp);
    await input.store.observeSession?.({
      principal,
      sessionId,
      checkpoint,
      stage: stageForResult(completeResult),
      resumability,
      ...(completeResult.implementationPlan?.appId === undefined
        ? {}
        : { appId: completeResult.implementationPlan.appId }),
      nowEpochMs: timestamp,
    });
    return completeResult;
  }

  async function readSession(inputValue: {
    sessionId: string;
    cursor: number;
    limit: number;
  }) {
    const { sessionId, cursor, limit } = inputValue;
    const session = toDurableHostedSessionRecord(
      await requireSession(sessionId),
    );
    await input.beforeRead?.({
      principal,
      sessionId,
      adapterSessionId: session.adapterSessionId,
    });
    try {
      const snapshot = await input.transport.get({
        principal,
        adapterSessionId: session.adapterSessionId,
      });
      const observedAt = now();
      const observedCheckpoint = checkpointForSnapshot(
        sessionId,
        snapshot,
        observedAt,
      );
      if (
        snapshot.status === "working" &&
        session.checkpointProgressDigest ===
          hostedSessionCheckpointProgressDigest(observedCheckpoint) &&
        observedAt >=
          session.lastProgressAtEpochMs + sessionTimeoutPolicy.idleTimeoutMs
      ) {
        const checkpoint = session.checkpoint ?? observedCheckpoint;
        await input.store.observeSession?.({
          principal,
          sessionId,
          checkpoint,
          stage: session.stage,
          resumability: "checkpoint",
          ...(session.appId === undefined ? {} : { appId: session.appId }),
          nowEpochMs: observedAt,
        });
        return resultFromCheckpoint(sessionId, checkpoint, cursor, limit);
      }
      await observeSnapshot(sessionId, snapshot);
      return projectSnapshot(sessionId, snapshot, cursor, limit);
    } catch (error) {
      if (!(error instanceof HostedAdapterSessionUnavailableError)) throw error;
      if (session.checkpoint === undefined)
        throw new HostedSessionRecoveryUnavailableError();
      await input.store.observeSession?.({
        principal,
        sessionId,
        checkpoint: session.checkpoint,
        stage: session.stage,
        resumability: "checkpoint",
        ...(session.appId === undefined ? {} : { appId: session.appId }),
        nowEpochMs: now(),
      });
      return resultFromCheckpoint(sessionId, session.checkpoint, cursor, limit);
    }
  }

  return {
    async start(request) {
      requireHostedOperationScope(principal, "start");
      if (request.resumeSessionId !== undefined) {
        const stored = await requireSession(request.resumeSessionId);
        let existing = toDurableHostedSessionRecord(stored);
        if (
          stored.version === 1 &&
          ["completed", "failed", "cancelled"].includes(stored.status)
        ) {
          try {
            const snapshot = await input.transport.get({
              principal,
              adapterSessionId: stored.adapterSessionId,
            });
            await observeSnapshot(stored.sessionId, snapshot);
            existing = toDurableHostedSessionRecord(
              await requireSession(stored.sessionId),
            );
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError))
              throw error;
          }
        }
        const terminal = ["completed", "failed", "cancelled"].includes(
          existing.status,
        );
        const interrupted =
          existing.status === "working" &&
          existing.resumability === "checkpoint";
        if (terminal || interrupted) {
          if (existing.checkpoint === undefined)
            throw new HostedSessionRecoveryUnavailableError();
          return mutate({
            kind: "start",
            request,
            resumeSessionId: existing.sessionId,
            async dispatch(operationId) {
              const response = await input.transport.start({
                principal,
                operationId,
                prompt: recoveryPrompt(existing),
              });
              const sessionId = stableHostedId("ses", {
                operationId,
                adapterSessionId: response.adapterSessionId,
              });
              const result = projectSnapshot(sessionId, response.snapshot);
              const timestamp = now();
              const checkpoint = checkpointForSnapshot(
                sessionId,
                response.snapshot,
                timestamp,
              );
              return {
                result,
                newSession: durableHostedSessionRecordSchema.parse({
                  version: 2,
                  sessionId,
                  principal,
                  adapterSessionId: response.adapterSessionId,
                  originAdapterSessionId: response.adapterSessionId,
                  adapterGeneration: 1,
                  title: existing.title,
                  ...(result.implementationPlan?.appId === undefined
                    ? existing.appId === undefined
                      ? {}
                      : { appId: existing.appId }
                    : { appId: result.implementationPlan.appId }),
                  stage: stageForResult(result),
                  status: result.status,
                  resumability: ["completed", "failed", "cancelled"].includes(
                    result.status,
                  )
                    ? "terminal"
                    : "live",
                  checkpoint,
                  checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
                  checkpointProgressDigest:
                    hostedSessionCheckpointProgressDigest(checkpoint),
                  parentSessionId: existing.sessionId,
                  lastProgressAtEpochMs: timestamp,
                  createdAtEpochMs: timestamp,
                  updatedAtEpochMs: timestamp,
                }),
              };
            },
          });
        }
        if (!terminal) {
          try {
            const snapshot = await input.transport.get({
              principal,
              adapterSessionId: existing.adapterSessionId,
            });
            return await observeSnapshot(existing.sessionId, snapshot);
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError))
              throw error;
          }
        }
        if (
          existing.checkpoint === undefined ||
          existing.checkpointDigest === undefined ||
          input.store.replaceSessionAdapter === undefined
        )
          throw new HostedSessionRecoveryUnavailableError();
        return mutate({
          kind: "resume",
          request,
          sessionId: existing.sessionId,
          async dispatch(operationId) {
            const response = await input.transport.start({
              principal,
              operationId,
              prompt: recoveryPrompt(existing),
            });
            const result = projectSnapshot(
              existing.sessionId,
              response.snapshot,
            );
            const timestamp = now();
            const checkpoint = checkpointForSnapshot(
              existing.sessionId,
              response.snapshot,
              timestamp,
            );
            const replaced = hostedSessionRecordSchema.parse(
              await input.store.replaceSessionAdapter!({
                principal,
                sessionId: existing.sessionId,
                expectedAdapterGeneration: existing.adapterGeneration,
                expectedCheckpointDigest: existing.checkpointDigest,
                adapterSessionId: response.adapterSessionId,
                checkpoint,
                stage: stageForResult(result),
                resumability: ["completed", "failed", "cancelled"].includes(
                  result.status,
                )
                  ? "terminal"
                  : "live",
                ...(result.implementationPlan?.appId === undefined
                  ? {}
                  : { appId: result.implementationPlan.appId }),
                nowEpochMs: timestamp,
              }),
            );
            const durable = toDurableHostedSessionRecord(replaced);
            if (
              durable.adapterSessionId !== response.adapterSessionId ||
              durable.adapterGeneration !== existing.adapterGeneration + 1 ||
              durable.checkpointDigest !==
                hostedSessionCheckpointDigest(checkpoint)
            )
              throw new HostedSubmissionUnknownError();
            return { result };
          },
        });
      }
      if (request.prompt === undefined)
        throw new SubmissionRejectedBeforeDispatchError("prompt_required");
      const prompt = request.prompt;
      return mutate({
        kind: "start",
        request,
        async dispatch(operationId) {
          const response = await input.transport.start({
            principal,
            operationId,
            prompt,
          });
          const sessionId = stableHostedId("ses", {
            operationId,
            adapterSessionId: response.adapterSessionId,
          });
          const result = projectSnapshot(sessionId, response.snapshot);
          const timestamp = now();
          const checkpoint = checkpointForSnapshot(
            sessionId,
            response.snapshot,
            timestamp,
          );
          return {
            result,
            newSession: durableHostedSessionRecordSchema.parse({
              version: 2,
              sessionId,
              principal,
              adapterSessionId: response.adapterSessionId,
              originAdapterSessionId: response.adapterSessionId,
              adapterGeneration: 1,
              title: titleFromPrompt(prompt),
              ...(result.implementationPlan?.appId === undefined
                ? {}
                : { appId: result.implementationPlan.appId }),
              stage: stageForResult(result),
              status: result.status,
              resumability: ["completed", "failed", "cancelled"].includes(
                result.status,
              )
                ? "terminal"
                : "live",
              checkpoint,
              checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
              checkpointProgressDigest:
                hostedSessionCheckpointProgressDigest(checkpoint),
              lastProgressAtEpochMs: timestamp,
              createdAtEpochMs: timestamp,
              updatedAtEpochMs: timestamp,
            }),
          };
        },
      });
    },
    async list({ cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      const listed = await input.store.listSessions({
        principal,
        cursor,
        limit,
      });
      return {
        kind: "session_list",
        cursor: listed.cursor,
        sessions: listed.sessions.map(hostedSessionSummary),
      };
    },
    async recoverStart(request) {
      requireHostedOperationScope(principal, "start");
      return readSession(request);
    },
    async get({ sessionId, cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      return readSession({ sessionId, cursor, limit });
    },
    async send(request) {
      requireHostedOperationScope(principal, "send");
      const session = await requireSession(request.sessionId);
      return mutate({
        kind: "send",
        request,
        sessionId: request.sessionId,
        async dispatch(operationId) {
          const snapshot = await input.transport.send({
            principal,
            operationId,
            adapterSessionId: session.adapterSessionId,
            message: request.message,
          });
          const result = projectSnapshot(request.sessionId, snapshot);
          await observeSnapshot(request.sessionId, snapshot);
          return { result };
        },
      });
    },
    async respond(request) {
      requireHostedOperationScope(principal, "respond");
      const session = await requireSession(request.sessionId);
      return mutate({
        kind: "respond",
        request,
        sessionId: request.sessionId,
        async dispatch(operationId) {
          const before = await input.transport.get({
            principal,
            adapterSessionId: session.adapterSessionId,
          });
          const expected = outstandingInternalEveRequests(
            before.events.filter(
              (event): event is InternalEveEvent =>
                event !== null && typeof event === "object",
            ),
          ).map(({ requestId }) => requestId);
          if (
            expected.length !== request.responses.length ||
            expected.some(
              (requestId, index) =>
                request.responses[index]?.requestId !== requestId,
            )
          )
            throw new SubmissionRejectedBeforeDispatchError(
              "input_batch_changed",
            );
          const snapshot = await input.transport.respond({
            principal,
            operationId,
            adapterSessionId: session.adapterSessionId,
            responses: request.responses,
          });
          const result = projectSnapshot(request.sessionId, snapshot);
          await observeSnapshot(request.sessionId, snapshot);
          return { result };
        },
      });
    },
    async cancel({ sessionId, turnId }) {
      requireHostedOperationScope(principal, "cancel");
      const session = await requireSession(sessionId);
      const snapshot = await input.transport.cancel({
        principal,
        adapterSessionId: session.adapterSessionId,
        ...(turnId === undefined ? {} : { turnId }),
      });
      const result = projectSnapshot(sessionId, snapshot);
      await observeSnapshot(sessionId, snapshot);
      return result;
    },
  };
}

export const hostedEveProjectionForTesting = projectSnapshot;
