import type { z } from "zod";

import type { EveSessionService } from "./service";
import { canonical, digest, stableId } from "./hosted-operation-identifiers";
import { hostedPrincipalSchema, requireHostedOperationScope, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
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
} from "./hosted-store";
import type {
  HostedEveStore,
  HostedOperationKind,
  HostedOperationRecord,
  HostedSessionCheckpoint,
  HostedSessionTimeoutPolicy,
} from "./hosted-store";
import { outstandingInternalEveRequests, toPublicEvent } from "./public-events";
import type { InternalEveEvent } from "./public-events";
import { projectHostedSnapshot } from "./hosted-projection";
import type { HostedEngineSnapshot } from "./hosted-projection";
import {
  eveSessionResultSchema,
  publicInputRequestSchema,
  publicEveEventSchema,
} from "../mcp/contracts";
import type {
  publicSessionStageSchema,
  EveSessionResult,
  PublicInputRequest,
} from "../mcp/contracts";
import {
  HostedAdapterSessionUnavailableError,
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionBusyError,
  HostedSessionNotFoundError,
  HostedSessionRecoveryUnavailableError,
  HostedSubmissionUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-errors";
import { recoveryPromptForSession } from "./hosted-recovery-prompt";
import { resultFromHostedCheckpoint } from "./hosted-checkpoint-result";

const projectSnapshot = projectHostedSnapshot;

export {
  HostedAdapterSessionUnavailableError,
  HostedCancellationUnsettledError,
  HostedIdempotencyConflictError,
  HostedRejectedOperationError,
  HostedSessionBusyError,
  HostedSessionNotFoundError,
  HostedSessionRecoveryUnavailableError,
  HostedSubmissionUnknownError,
  SubmissionOutcomeUnknownError,
  SubmissionRejectedBeforeDispatchError,
} from "./hosted-errors";

export type { HostedEngineSnapshot } from "./hosted-projection";

export interface HostedEveTransport {
  start: (input: {
    principal: HostedPrincipal;
    operationId: string;
    prompt: string;
    sourceHandoffId?: string;
  }) => Promise<{
    adapterSessionId: string;
    snapshot: HostedEngineSnapshot;
  }>;
  get: (input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
  }) => Promise<HostedEngineSnapshot>;
  send: (input: {
    principal: HostedPrincipal;
    operationId: string;
    adapterSessionId: string;
    message: string;
    sourceHandoffId?: string;
  }) => Promise<HostedEngineSnapshot>;
  respond: (input: {
    principal: HostedPrincipal;
    operationId: string;
    adapterSessionId: string;
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
    sourceHandoffId?: string;
  }) => Promise<HostedEngineSnapshot>;
  cancel: (input: {
    principal: HostedPrincipal;
    adapterSessionId: string;
    turnId?: string;
  }) => Promise<HostedEngineSnapshot>;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function assertNever(value: never): never {
  void value;
  throw new HostedSubmissionUnknownError();
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function titleFromPrompt(prompt: string): string {
  const firstLine = prompt.trim().split(/\r?\n/u, 1)[0]?.trim() ?? "";
  return firstLine.slice(0, 200) || "Untitled app";
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function stageForResult(result: EveSessionResult): z.infer<typeof publicSessionStageSchema> {
  if (result.status === "completed") {
    return "complete";
  }
  if (["failed", "cancelled"].includes(result.status)) {
    return "needs_attention";
  }
  if (result.implementationPlan !== undefined) {
    return "ready";
  }
  if (result.prototype !== undefined) {
    return "prototype";
  }
  if (result.status === "input_required") {
    return "needs_attention";
  }
  if (result.status === "working") {
    return "designing";
  }
  return "planning";
}

interface CheckpointInputProfile {
  titleBytes: number;
  descriptionBytes: number;
  optionCount: number;
  optionLabelBytes: number;
  authorizationInstructionBytes: number;
  repositoryScopeCount: number;
}

const checkpointInputProfiles: readonly CheckpointInputProfile[] = [
  {
    authorizationInstructionBytes: 1000,
    descriptionBytes: 4096,
    optionCount: 32,
    optionLabelBytes: 512,
    repositoryScopeCount: 32,
    titleBytes: 2048,
  },
  {
    authorizationInstructionBytes: 512,
    descriptionBytes: 1024,
    optionCount: 16,
    optionLabelBytes: 256,
    repositoryScopeCount: 16,
    titleBytes: 512,
  },
  {
    authorizationInstructionBytes: 0,
    descriptionBytes: 0,
    optionCount: 4,
    optionLabelBytes: 64,
    repositoryScopeCount: 4,
    titleBytes: 128,
  },
];

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function truncateUtf8(value: string, maximumBytes: number): string {
  if (maximumBytes === 0) {
    return "";
  }
  const encoder = new TextEncoder();
  if (encoder.encode(value).byteLength <= maximumBytes) {
    return value;
  }
  let lower = 0;
  let upper = value.length;
  while (lower < upper) {
    const midpoint = Math.ceil((lower + upper) / 2);
    if (encoder.encode(value.slice(0, midpoint)).byteLength <= maximumBytes) {
      lower = midpoint;
    } else {
      upper = midpoint - 1;
    }
  }
  const end = lower > 0 && /[\uD800-\uDBFF]/u.test(value.charAt(lower - 1)) ? lower - 1 : lower;
  return value.slice(0, end);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function checkpointInputRequest(
  request: PublicInputRequest,
  profile: CheckpointInputProfile,
): PublicInputRequest {
  const options = request.options?.slice(0, profile.optionCount).map(({ id, label }) => ({
    id,
    label: truncateUtf8(label, profile.optionLabelBytes),
  }));
  const { authorization } = request;
  const repositoryAccess = authorization?.repositoryAccess;
  return publicInputRequestSchema.parse({
    allowFreeform: request.allowFreeform,
    ...(authorization === undefined
      ? {}
      : {
          authorization: {
            ...(authorization.displayName === undefined
              ? {}
              : { displayName: authorization.displayName }),
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
            ...(repositoryAccess === undefined
              ? {}
              : {
                  repositoryAccess: {
                    ...repositoryAccess,
                    scopes: repositoryAccess.scopes.slice(0, profile.repositoryScopeCount),
                  },
                }),
            ...(authorization.url === undefined ? {} : { url: authorization.url }),
            ...(authorization.userCode === undefined ? {} : { userCode: authorization.userCode }),
          },
        }),
    ...(profile.descriptionBytes === 0 || request.description === undefined
      ? {}
      : {
          description: truncateUtf8(request.description, profile.descriptionBytes),
        }),
    kind: request.kind,
    ...(options === undefined || options.length === 0 ? {} : { options }),
    ...(request.presentation === undefined ? {} : { presentation: request.presentation }),
    requestId: request.requestId,
    title: truncateUtf8(request.title, profile.titleBytes),
  });
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function checkpointEvent(
  event: z.infer<typeof publicEveEventSchema>,
  profile: CheckpointInputProfile,
): z.infer<typeof publicEveEventSchema> {
  if (event.type === "input_required") {
    return {
      ...event,
      request: checkpointInputRequest(event.request, profile),
    };
  }
  return event;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function checkpointForSnapshot(
  sessionId: string,
  snapshot: HostedEngineSnapshot,
  capturedAtEpochMs: number,
): HostedSessionCheckpoint {
  const ring = Array.from<z.infer<typeof publicEveEventSchema>>({ length: 512 });
  let publicEventCount = 0;
  for (const candidate of snapshot.events) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const projected = toPublicEvent(candidate as InternalEveEvent);
    if (projected === null) {
      continue;
    }
    const parsed = publicEveEventSchema.safeParse({
      ...projected,
      index: publicEventCount,
    });
    if (!parsed.success) {
      continue;
    }
    const event = parsed.data;
    let boundedEvent = event;
    if (event.type === "assistant_message") {
      boundedEvent = { ...event, text: event.text.slice(-65_536) };
    } else if (event.type === "progress") {
      boundedEvent = { ...event, label: event.label.slice(-4096) };
    } else if (event.type === "error") {
      boundedEvent = {
        ...event,
        code: event.code.slice(0, 100),
        message: event.message.slice(-65_536),
      };
    }
    ring[publicEventCount % ring.length] = boundedEvent;
    publicEventCount += 1;
  }
  const retainedCount = Math.min(publicEventCount, ring.length);
  const events = Array.from({ length: retainedCount }, (_, index) => {
    const absoluteIndex = publicEventCount - retainedCount + index;
    const event = ring[absoluteIndex % ring.length];
    if (event === undefined) {
      throw new HostedSessionRecoveryUnavailableError();
    }
    return event;
  });
  const outstandingRequests = outstandingInternalEveRequests(
    snapshot.events.filter(
      (event): event is InternalEveEvent => event !== null && typeof event === "object",
    ),
  );

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  function fitCheckpoint(input: {
    profile: CheckpointInputProfile;
    includePrototype: boolean;
    includeImplementationPlan: boolean;
  }) {
    const boundedEvents = events.map((event) => checkpointEvent(event, input.profile));
    const inputRequests = outstandingRequests
      .slice(0, 32)
      .map((request) => checkpointInputRequest(request, input.profile));
    let lower = 0;
    let upper = boundedEvents.length;
    let best: HostedSessionCheckpoint | undefined;
    while (lower <= upper) {
      const candidateCount = Math.floor((lower + upper) / 2);
      const retainedEvents = candidateCount === 0 ? [] : boundedEvents.slice(-candidateCount);
      let truncatedBeforeIndex: number | undefined;
      if (retainedEvents[0] === undefined) {
        if (publicEventCount !== 0) {
          truncatedBeforeIndex = publicEventCount;
        }
      } else if (retainedEvents[0].index !== 0) {
        truncatedBeforeIndex = retainedEvents[0].index;
      }
      const candidate = hostedSessionCheckpointSchema.safeParse({
        capturedAtEpochMs,
        events: retainedEvents,
        ...(snapshot.workingPreview === undefined
          ? {}
          : { workingPreview: snapshot.workingPreview }),
        ...(input.includeImplementationPlan && snapshot.implementationPlan !== undefined
          ? { implementationPlan: snapshot.implementationPlan }
          : {}),
        ...(inputRequests.length === 0 ? {} : { inputRequests }),
        ...(input.includePrototype && snapshot.prototype !== undefined
          ? { prototype: snapshot.prototype }
          : {}),
        status: snapshot.status,
        ...(truncatedBeforeIndex === undefined ? {} : { truncatedBeforeIndex }),
        version: 1,
      });
      if (candidate.success) {
        best = candidate.data;
        lower = candidateCount + 1;
      } else {
        upper = candidateCount - 1;
      }
    }
    return best;
  }

  for (const profile of checkpointInputProfiles) {
    const checkpoint = fitCheckpoint({
      includeImplementationPlan: true,
      includePrototype: true,
      profile,
    });
    if (checkpoint !== undefined) {
      return checkpoint;
    }
  }

  const minimalProfile = checkpointInputProfiles.at(-1);
  if (minimalProfile === undefined) {
    throw new HostedSessionRecoveryUnavailableError();
  }
  for (const artifactSelection of [
    { includeImplementationPlan: true, includePrototype: false },
    { includeImplementationPlan: false, includePrototype: true },
    { includeImplementationPlan: false, includePrototype: false },
  ]) {
    const checkpoint = fitCheckpoint({
      profile: minimalProfile,
      ...artifactSelection,
    });
    if (checkpoint !== undefined) {
      return checkpoint;
    }
  }

  // A structurally valid fallback prevents an oversized transport snapshot
  // from turning an already-dispatched mutation into an unknown outcome.
  return {
    capturedAtEpochMs,
    events: [],
    status: snapshot.status,
    ...(publicEventCount === 0 ? {} : { truncatedBeforeIndex: publicEventCount }),
    version: 1,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function recoveryPrompt(record: z.infer<typeof durableHostedSessionRecordSchema>): string {
  const prompt = recoveryPromptForSession(record);
  if (prompt === undefined) {
    throw new HostedSessionRecoveryUnavailableError();
  }
  return prompt;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createHostedEveSessionService(input: {
  principal: HostedPrincipal;
  store: HostedEveStore;
  transport: HostedEveTransport;
  beforeRead?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    adapterSessionId: string;
    sourceHandoffId?: string;
  }) => Promise<void>;
  now?: () => number;
  sessionTimeoutPolicy?: HostedSessionTimeoutPolicy;
}): EveSessionService {
  const principal = hostedPrincipalSchema.parse(input.principal);
  const now = input.now ?? Date.now;
  const sessionTimeoutPolicy = hostedSessionTimeoutPolicySchema.parse(
    input.sessionTimeoutPolicy ?? DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  );

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function requireSession(sessionId: string) {
    const session = await input.store.getSession(principal, sessionId);
    if (session === null) {
      throw new HostedSessionNotFoundError();
    }
    const parsed = hostedSessionRecordSchema.parse(session);
    if (
      parsed.sessionId !== sessionId ||
      tenantKeyFor(parsed.principal) !== tenantKeyFor(principal)
    ) {
      throw new HostedSessionNotFoundError();
    }
    return parsed;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function requireBoundSucceededStartSession(operation: HostedOperationRecord) {
    if (
      operation.kind !== "start" ||
      operation.state !== "succeeded" ||
      operation.sessionRecordDigest === undefined
    ) {
      throw new HostedSubmissionUnknownError();
    }
    try {
      const storedSession = await input.store.getSession(principal, operation.sessionId);
      if (storedSession === null) {
        throw new HostedSubmissionUnknownError();
      }
      const verifiedSession = hostedSessionRecordSchema.parse(storedSession);
      if (
        verifiedSession.sessionId !== operation.sessionId ||
        tenantKeyFor(verifiedSession.principal) !== tenantKeyFor(principal) ||
        hostedSessionCreationDigest(verifiedSession) !== operation.sessionRecordDigest
      ) {
        throw new HostedSubmissionUnknownError();
      }
      return verifiedSession;
    } catch {
      throw new HostedSubmissionUnknownError();
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function mutate<T extends { clientRequestId: string }>(options: {
    kind: HostedOperationKind;
    request: T;
    sessionId?: string;
    resumeSessionId?: string;
    dispatch: (operationId: string) => Promise<{
      result: EveSessionResult;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
    }>;
  }): Promise<EveSessionResult> {
    const requestDigest = digest({
      kind: options.kind,
      request: options.request,
      sessionId: options.sessionId,
    });
    const operationId = stableId(
      "op",
      Object.fromEntries([
        [
          "tenant",
          [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
        ],
        ["kind", options.kind],
        ["clientRequestId", options.request.clientRequestId],
      ]),
    );
    const timestamp = now();
    const candidate = hostedOperationRecordSchema.parse({
      clientRequestId: options.request.clientRequestId,
      createdAtEpochMs: timestamp,
      kind: options.kind,
      operationId,
      principal,
      requestDigest,
      ...(options.sessionId === undefined ? {} : { sessionId: options.sessionId }),
      ...(options.resumeSessionId === undefined
        ? {}
        : { resumeSessionId: options.resumeSessionId }),
      state: "reserved",
      updatedAtEpochMs: timestamp,
      version: 1,
    });
    let reservation: z.infer<typeof reserveOperationResultSchema>;
    try {
      reservation = reserveOperationResultSchema.parse(
        await input.store.reserveOperation(principal, candidate),
      );
    } catch {
      throw new HostedSubmissionUnknownError();
    }
    switch (reservation.disposition) {
      case "conflict": {
        throw new HostedIdempotencyConflictError();
      }
      case "rejected": {
        throw new HostedSessionBusyError();
      }
      case "reserved": {
        const operation = requireOwnedOperation(reservation.operation, {
          clientRequestId: options.request.clientRequestId,
          kind: options.kind,
          operationId,
          requestDigest,
          resumeSessionId: options.resumeSessionId,
          sessionId: options.sessionId,
        });
        if (operation.state !== "reserved") {
          throw new HostedSubmissionUnknownError();
        }
        break;
      }
      case "existing": {
        const operation = requireOwnedOperation(reservation.operation, {
          clientRequestId: options.request.clientRequestId,
          kind: options.kind,
          operationId,
          requestDigest,
          resumeSessionId: options.resumeSessionId,
          sessionId: options.sessionId,
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
          case "reserved": {
            throw new HostedSubmissionUnknownError();
          }
          case "rejected": {
            throw new HostedRejectedOperationError(operation.safeErrorCode);
          }
          default: {
            return assertNever(operation);
          }
        }
      }
      default: {
        return assertNever(reservation);
      }
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
          nowEpochMs: now(),
          operationId,
          principal,
          requestDigest,
          safeErrorCode: rejected ? error.code : "submission_unknown",
          state: rejected ? "rejected" : "submission_unknown",
        });
        const verified = requireOwnedOperation(settled, {
          clientRequestId: options.request.clientRequestId,
          kind: options.kind,
          operationId,
          requestDigest,
          resumeSessionId: options.resumeSessionId,
          sessionId: options.sessionId,
        });
        const expectedState = rejected ? "rejected" : "submission_unknown";
        const expectedCode = rejected ? error.code : "submission_unknown";
        settlementVerified =
          verified.state === expectedState && verified.safeErrorCode === expectedCode;
      } catch {
        // The caller cannot know whether the durable transition committed.
        // `reserved` remains non-replayable; a committed terminal record is
        // interpreted from the store on a later exact retry.
      }
      if (!settlementVerified) {
        throw new HostedSubmissionUnknownError();
      }
      if (rejected) {
        throw new HostedRejectedOperationError(error.code);
      }
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
        nowEpochMs: now(),
        operationId,
        principal,
        requestDigest,
        result: dispatchedResult,
        ...(dispatchedSession === undefined ? {} : { session: dispatchedSession }),
      });
      const verified = requireOwnedOperation(settled, {
        clientRequestId: options.request.clientRequestId,
        kind: options.kind,
        operationId,
        requestDigest,
        resumeSessionId: options.resumeSessionId,
        sessionId: options.sessionId,
      });
      if (verified.state !== "succeeded") {
        throw new HostedSubmissionUnknownError();
      }
      const verifiedResult = eveSessionResultSchema.parse(verified.result);
      if (
        digest(verifiedResult) !== digest(dispatchedResult) ||
        canonical(verifiedResult) !== canonical(dispatchedResult)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      if (dispatchedSession !== undefined) {
        if (verifiedResult.sessionId !== dispatchedSession.sessionId) {
          throw new HostedSubmissionUnknownError();
        }
        if (verified.sessionRecordDigest !== hostedSessionCreationDigest(dispatchedSession)) {
          throw new HostedSubmissionUnknownError();
        }
        const verifiedSession = await requireBoundSucceededStartSession(verified);
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

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function observeSnapshot(
    sessionId: string,
    snapshot: HostedEngineSnapshot,
    resumability: "live" | "terminal" = ["completed", "failed", "cancelled"].includes(
      snapshot.status,
    )
      ? "terminal"
      : "live",
  ) {
    const timestamp = now();
    const completeResult = projectSnapshot(sessionId, snapshot, 0, 100);
    const checkpoint = checkpointForSnapshot(sessionId, snapshot, timestamp);
    const observed = await input.store.observeSession?.({
      checkpoint,
      ...(completeResult.implementationPlan?.appId === undefined
        ? {}
        : { appId: completeResult.implementationPlan.appId }),
      nowEpochMs: timestamp,
      principal,
      resumability,
      sessionId,
      stage: stageForResult(completeResult),
    });
    if (observed?.status === "cancelled") {
      const durable = toDurableHostedSessionRecord(observed);
      if (durable.checkpoint) {
        return resultFromHostedCheckpoint(sessionId, durable.checkpoint, 0, 100);
      }
    }
    return completeResult;
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function readSession(inputValue: { sessionId: string; cursor: number; limit: number }) {
    const { sessionId, cursor, limit } = inputValue;
    const session = toDurableHostedSessionRecord(await requireSession(sessionId));
    await input.beforeRead?.({
      adapterSessionId: session.adapterSessionId,
      principal,
      sessionId,
      sourceHandoffId: session.sourceHandoffId,
    });
    try {
      const snapshot = await input.transport.get({
        adapterSessionId: session.adapterSessionId,
        principal,
      });
      const observedAt = now();
      const observedCheckpoint = checkpointForSnapshot(sessionId, snapshot, observedAt);
      if (
        snapshot.status === "working" &&
        session.checkpointProgressDigest ===
          hostedSessionCheckpointProgressDigest(observedCheckpoint) &&
        observedAt >= session.lastProgressAtEpochMs + sessionTimeoutPolicy.idleTimeoutMs
      ) {
        const checkpoint = session.checkpoint ?? observedCheckpoint;
        const observed = await input.store.observeSession?.({
          ...(session.appId === undefined ? {} : { appId: session.appId }),
          checkpoint,
          nowEpochMs: observedAt,
          principal,
          resumability: "checkpoint",
          sessionId,
          stage: session.stage,
        });
        const retained = observed && toDurableHostedSessionRecord(observed).checkpoint;
        return resultFromHostedCheckpoint(sessionId, retained ?? checkpoint, cursor, limit);
      }
      const observed = await observeSnapshot(sessionId, snapshot);
      if (observed.status === "cancelled") {
        const durable = toDurableHostedSessionRecord(await requireSession(sessionId));
        if (durable.checkpoint) {
          return resultFromHostedCheckpoint(sessionId, durable.checkpoint, cursor, limit);
        }
      }
      return projectSnapshot(sessionId, snapshot, cursor, limit);
    } catch (error) {
      if (!(error instanceof HostedAdapterSessionUnavailableError)) {
        throw error;
      }
      if (session.checkpoint === undefined) {
        throw new HostedSessionRecoveryUnavailableError();
      }
      const observed = await input.store.observeSession?.({
        ...(session.appId === undefined ? {} : { appId: session.appId }),
        checkpoint: session.checkpoint,
        nowEpochMs: now(),
        principal,
        resumability: "checkpoint",
        sessionId,
        stage: session.stage,
      });
      const retained = observed && toDurableHostedSessionRecord(observed).checkpoint;
      return resultFromHostedCheckpoint(sessionId, retained ?? session.checkpoint, cursor, limit);
    }
  }

  return {
    async cancel({ sessionId, turnId }) {
      requireHostedOperationScope(principal, "cancel");
      const session = await requireSession(sessionId);
      let snapshot: HostedEngineSnapshot;
      try {
        snapshot = await input.transport.cancel({
          adapterSessionId: session.adapterSessionId,
          principal,
          ...(turnId === undefined ? {} : { turnId }),
        });
      } catch (error) {
        if (error instanceof SubmissionRejectedBeforeDispatchError) {
          throw new HostedRejectedOperationError(error.code);
        }
        throw error;
      }
      return observeSnapshot(sessionId, snapshot);
    },
    get({ sessionId, cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      return readSession({ cursor, limit, sessionId });
    },
    async list({ cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      const listed = await input.store.listSessions({
        cursor,
        limit,
        principal,
      });
      return {
        cursor: listed.cursor,
        kind: "session_list",
        sessions: listed.sessions.map(hostedSessionSummary),
      };
    }, // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async recoverStart(request) {
      requireHostedOperationScope(principal, "start");
      return readSession(request);
    }, // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    async respond(request) {
      requireHostedOperationScope(principal, "respond");
      const session = await requireSession(request.sessionId);
      return mutate({
        async dispatch(operationId) {
          const before = await input.transport.get({
            adapterSessionId: session.adapterSessionId,
            principal,
          });
          const expected = outstandingInternalEveRequests(
            before.events.filter(
              (event): event is InternalEveEvent => event !== null && typeof event === "object",
            ),
          ).map(({ requestId }) => requestId);
          if (
            expected.some((requestId, index) => request.responses[index]?.requestId !== requestId)
          ) {
            throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
          }
          const snapshot = await input.transport.respond({
            adapterSessionId: session.adapterSessionId,
            operationId,
            principal,
            responses: request.responses,
            ...(session.version === 2 && session.sourceHandoffId
              ? { sourceHandoffId: session.sourceHandoffId }
              : {}),
          });
          const result = await observeSnapshot(request.sessionId, snapshot);
          return { result };
        },
        kind: "respond",
        request,
        sessionId: request.sessionId,
      });
    },
    async send(request) {
      requireHostedOperationScope(principal, "send");
      const session = await requireSession(request.sessionId);
      return mutate({
        async dispatch(operationId) {
          const snapshot = await input.transport.send({
            adapterSessionId: session.adapterSessionId,
            message: request.message,
            operationId,
            principal,
            ...(session.version === 2 && session.sourceHandoffId
              ? { sourceHandoffId: session.sourceHandoffId }
              : {}),
          });
          const result = await observeSnapshot(request.sessionId, snapshot);
          return { result };
        },
        kind: "send",
        request,
        sessionId: request.sessionId,
      });
    },
    async start(request) {
      requireHostedOperationScope(principal, "start");
      if (request.resumeSessionId !== undefined) {
        const stored = await requireSession(request.resumeSessionId);
        let existing = toDurableHostedSessionRecord(stored);
        if (stored.version === 1 && ["completed", "failed", "cancelled"].includes(stored.status)) {
          try {
            const snapshot = await input.transport.get({
              adapterSessionId: stored.adapterSessionId,
              principal,
            });
            await observeSnapshot(stored.sessionId, snapshot);
            existing = toDurableHostedSessionRecord(await requireSession(stored.sessionId));
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError)) {
              throw error;
            }
          }
        }
        const terminal = ["completed", "failed", "cancelled"].includes(existing.status);
        const interrupted = existing.status === "working" && existing.resumability === "checkpoint";
        if (terminal || interrupted) {
          if (existing.checkpoint === undefined) {
            throw new HostedSessionRecoveryUnavailableError();
          }
          return mutate({
            async dispatch(operationId) {
              const response = await input.transport.start({
                operationId,
                principal,
                prompt: recoveryPrompt(existing),
                ...(existing.sourceHandoffId ? { sourceHandoffId: existing.sourceHandoffId } : {}),
              });
              const sessionId = stableId(
                "ses",
                Object.fromEntries([
                  ["operationId", operationId],
                  ["adapterSessionId", response.adapterSessionId],
                ]),
              );
              const result = projectSnapshot(sessionId, response.snapshot);
              const timestamp = now();
              const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
              const { appId: existingAppId } = existing;
              const { appId: implementationAppId } = result.implementationPlan ?? {};
              const appId = implementationAppId ?? existingAppId;
              return {
                newSession: durableHostedSessionRecordSchema.parse({
                  adapterGeneration: 1,
                  adapterSessionId: response.adapterSessionId,
                  ...(appId === undefined ? {} : { appId }),
                  checkpoint,
                  checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
                  checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
                  createdAtEpochMs: timestamp,
                  lastProgressAtEpochMs: timestamp,
                  originAdapterSessionId: response.adapterSessionId,
                  parentSessionId: existing.sessionId,
                  principal,
                  resumability: ["completed", "failed", "cancelled"].includes(result.status)
                    ? "terminal"
                    : "live",
                  sessionId,
                  ...(existing.sourceHandoffId
                    ? { sourceHandoffId: existing.sourceHandoffId }
                    : {}),
                  stage: stageForResult(result),
                  status: result.status,
                  title: existing.title,
                  updatedAtEpochMs: timestamp,
                  version: 2,
                }),
                result,
              };
            },
            kind: "start",
            request,
            resumeSessionId: existing.sessionId,
          });
        }
        if (!terminal) {
          try {
            const snapshot = await input.transport.get({
              adapterSessionId: existing.adapterSessionId,
              principal,
            });
            return await observeSnapshot(existing.sessionId, snapshot);
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError)) {
              throw error;
            }
          }
        }
        if (
          existing.checkpoint === undefined ||
          existing.checkpointDigest === undefined ||
          input.store.replaceSessionAdapter === undefined
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const { replaceSessionAdapter } = input.store;
        if (replaceSessionAdapter === undefined) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        return mutate({
          async dispatch(operationId) {
            const response = await input.transport.start({
              operationId,
              principal,
              prompt: recoveryPrompt(existing),
              ...(existing.sourceHandoffId ? { sourceHandoffId: existing.sourceHandoffId } : {}),
            });
            const result = projectSnapshot(existing.sessionId, response.snapshot);
            const timestamp = now();
            const checkpoint = checkpointForSnapshot(
              existing.sessionId,
              response.snapshot,
              timestamp,
            );
            const replaced = hostedSessionRecordSchema.parse(
              await replaceSessionAdapter.call(input.store, {
                adapterSessionId: response.adapterSessionId,
                ...(result.implementationPlan?.appId === undefined
                  ? {}
                  : { appId: result.implementationPlan.appId }),
                checkpoint,
                expectedAdapterGeneration: existing.adapterGeneration,
                expectedCheckpointDigest: existing.checkpointDigest,
                nowEpochMs: timestamp,
                principal,
                resumability: ["completed", "failed", "cancelled"].includes(result.status)
                  ? "terminal"
                  : "live",
                sessionId: existing.sessionId,
                stage: stageForResult(result),
              }),
            );
            const durable = toDurableHostedSessionRecord(replaced);
            if (
              durable.adapterSessionId !== response.adapterSessionId ||
              durable.adapterGeneration !== existing.adapterGeneration + 1 ||
              durable.checkpointDigest !== hostedSessionCheckpointDigest(checkpoint)
            ) {
              throw new HostedSubmissionUnknownError();
            }
            return { result };
          },
          kind: "resume",
          request,
          sessionId: existing.sessionId,
        });
      }
      if (request.prompt === undefined) {
        throw new SubmissionRejectedBeforeDispatchError("prompt_required");
      }
      const { prompt } = request;
      return mutate({
        async dispatch(operationId) {
          const response = await input.transport.start({
            operationId,
            principal,
            prompt,
            ...(request.sourceHandoffId ? { sourceHandoffId: request.sourceHandoffId } : {}),
          });
          const sessionId = stableId(
            "ses",
            Object.fromEntries([
              ["operationId", operationId],
              ["adapterSessionId", response.adapterSessionId],
            ]),
          );
          const result = projectSnapshot(sessionId, response.snapshot);
          const timestamp = now();
          const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
          return {
            newSession: durableHostedSessionRecordSchema.parse({
              adapterGeneration: 1,
              adapterSessionId: response.adapterSessionId,
              ...(result.implementationPlan?.appId === undefined
                ? {}
                : { appId: result.implementationPlan.appId }),
              checkpoint,
              checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
              checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
              createdAtEpochMs: timestamp,
              lastProgressAtEpochMs: timestamp,
              originAdapterSessionId: response.adapterSessionId,
              principal,
              resumability: ["completed", "failed", "cancelled"].includes(result.status)
                ? "terminal"
                : "live",
              sessionId,
              ...(request.sourceHandoffId ? { sourceHandoffId: request.sourceHandoffId } : {}),
              stage: stageForResult(result),
              status: result.status,
              title: titleFromPrompt(prompt),
              updatedAtEpochMs: timestamp,
              version: 2,
            }),
            result,
          };
        },
        kind: "start",
        request,
      });
    },
  };
}

export const hostedEveProjectionForTesting = projectSnapshot;
