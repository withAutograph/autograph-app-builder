import {
  captureResourceApprovalResponse,
  resourceApprovalResponseProofSchema,
} from "./resource-approval-response";
import type { ResourceApprovalResponseMarker } from "./resource-approval-response";
import { provesNativeDelivery } from "./native-delivery-state";
import type { NativeDeliveryState, SendDelivery } from "./native-delivery-state";
import {
  guardRequestIds,
  pendingFrameworkGuardIds,
  presentSessionLimitState,
  sessionLimitCancelledTurns,
  frameworkGuardBatches,
  matchesReservedGuardResponse,
  resolvedGuardRequestIds,
  isLegacySessionLimitRequest,
  mergeSessionLimitResponses,
  nativeResponses,
  omitControlledGuardQuestions,
  provesSessionLimitResponse,
  internalSessionLimitResponseSchema,
} from "./session-limit-input";
import type {
  PrivateInputState,
  InternalSessionLimitResponse,
  NativeInputBatch,
} from "./session-limit-input";
import { HostedCheckpointObservationConflictError } from "./hosted-checkpoint-observation-conflict-error";
import { continueApprovedHostedBuild } from "./approved-build-controller";
import { assertHostedBuildDecisionOwner } from "./approved-build-owner";
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { createInterface } from "node:readline";

import type { z } from "zod";

import type { EveSessionService } from "./service";
import { canonical, digest, stableId } from "./hosted-operation-identifiers";
import { hostedPrincipalSchema, requireHostedOperationScope, tenantKeyFor } from "./hosted-auth";
import type { HostedPrincipal } from "./hosted-auth";
import {
  isProvedSendDelivery,
  isProvedResourceApprovalResponse,
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
  HostedPagedCheckpointMetadata,
  HostedPagedSessionBase,
  HostedSessionCheckpoint,
  HostedSessionRecord,
  HostedSessionTimeoutPolicy,
} from "./hosted-store";
import {
  currentWorkingPreview,
  outstandingInternalEveRequests,
  pendingBuilderOperation,
  toPublicEvent,
} from "./public-events";
import type { InternalEveEvent } from "./public-events";
import type { MessageStreamEvent } from "eve/client";
import {
  createPrivateHostedApprovalRecorder,
  privateHostedApprovalCaptureStateSchema,
} from "./private-hosted-approval";
import type { PrivateHostedApprovalCaptureState } from "./private-hosted-approval";
import type { NativeObservationState } from "./native-observation-state";
import { nativeObservationStateSchema } from "./native-observation-state";
import { projectHostedSnapshot } from "./hosted-projection";
import type { HostedEngineSnapshot } from "./hosted-projection";
import { HostedSessionReadTimeoutError } from "./hosted-session-read-timeout-error";
import {
  eveSessionResultSchema,
  publicInputRequestSchema,
  publicEveEventSchema,
} from "../mcp/contracts";
import type {
  publicSessionStageSchema,
  publicPrototypeSchema,
  EveSessionResult,
  PublicInputRequest,
  PublicPrototypeReference,
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
import { recoveryPromptForPagedSession, recoveryPromptForSession } from "./hosted-recovery-prompt";
import { resultFromHostedCheckpoint } from "./hosted-checkpoint-result";
import { reportHostedSubmissionDiagnostic } from "./hosted-submission-diagnostic";
import type {
  HostedSubmissionDiagnosticSink,
  HostedSubmissionPhase,
  SendReadFailureCategory,
} from "./hosted-submission-diagnostic";

const guardDecisions: readonly ("continue" | "stop")[] = ["continue", "stop"];
const HOSTED_START_REQUEST_TIMEOUT_MS = 300_000;
const HOSTED_IDLE_RESERVATION_GRACE_MS = 300_000;
const HOSTED_PROGRESS_NOTICE_MS = 60_000;

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
  /** Incremental readback for paged checkpoint writers. Legacy transports may omit it. */
  observe?: (input: {
    principal: HostedPrincipal;
    sessionId: string;
    adapterSessionId: string;
    nativeObservationState?: NativeObservationState;
    allowPartialObservation?: boolean;
    onEvent: (event: InternalEveEvent) => Promise<void> | void;
    onPrivateEvent?: (event: MessageStreamEvent) => Promise<void> | void;
    readDeadline?: boolean;
  }) => Promise<{
    activeTurnId?: string;
    artifactProjectionRequiresLegacyReadback: boolean;
    installedEventCount: number;
    observationComplete?: boolean;
    pendingRequests: PublicInputRequest[];
    prototype?: z.infer<typeof publicPrototypeSchema>;
    prototypeRef?: PublicPrototypeReference;
    publicEventCount: number;
    status: HostedEngineSnapshot["status"];
    nativeObservationState?: NativeObservationState;
    nextNativeIndex?: number;
    uiPreview?: HostedEngineSnapshot["uiPreview"];
    workingPreview?: HostedEngineSnapshot["workingPreview"];
  }>;
  /** Read only the adapter ID returned by a successful start in this dispatch. */
  observeStarted?: HostedEveTransport["observe"];
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
    onAccepted?: (deliveryId: string) => Promise<void>;
    sourceHandoffId?: string;
  }) => Promise<HostedEngineSnapshot>;
  /** Resolves after Eve accepts the message, without exporting its complete history. */
  sendAccepted?: (input: Parameters<HostedEveTransport["send"]>[0]) => Promise<void>;
  respond: (input: {
    nativeObservationState?: NativeObservationState;
    internalSessionLimitResponse?: InternalSessionLimitResponse;
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
  /** Resolves after Eve accepts and verifies settlement of the response batch. */
  respondAccepted?: (input: Parameters<HostedEveTransport["respond"]>[0]) => Promise<void>;
  cancel: (input: {
    nativeObservationState?: NativeObservationState;
    principal: HostedPrincipal;
    adapterSessionId: string;
    turnId?: string;
  }) => Promise<HostedEngineSnapshot>;
  /** Resolves only after the requested cancellation is observed without exporting full history. */
  cancelAccepted?: (input: Parameters<HostedEveTransport["cancel"]>[0]) => Promise<void>;
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
  if (result.workingPreview !== undefined && result.workingPreview !== null) {
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
  function fitCheckpoint(input: { profile: CheckpointInputProfile; includePrototype: boolean }) {
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
        ...(snapshot.nativeDeliveryState === undefined
          ? {}
          : { nativeDeliveryState: snapshot.nativeDeliveryState }),
        ...(snapshot.privateInputState === undefined
          ? {}
          : { privateInputState: snapshot.privateInputState }),
        events: retainedEvents,
        ...(snapshot.workingPreview === undefined
          ? {}
          : { workingPreview: snapshot.workingPreview }),
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
  for (const artifactSelection of [{ includePrototype: true }, { includePrototype: false }]) {
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
async function recoveryPrompt(input: {
  record: z.infer<typeof durableHostedSessionRecordSchema>;
  store: HostedEveStore;
  principal: HostedPrincipal;
}): Promise<string> {
  const { record } = input;
  if (record.checkpoint !== undefined) {
    const prompt = recoveryPromptForSession(record);
    if (prompt !== undefined) {
      return prompt;
    }
  }
  if (record.checkpointRef === undefined || input.store.readCheckpointPage === undefined) {
    throw new HostedSessionRecoveryUnavailableError();
  }
  const messages: string[] = [];
  let cursor = record.checkpointRef.eventCount;
  let metadata: HostedPagedCheckpointMetadata | undefined;
  do {
    const start = Math.max(0, cursor - 250);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Read only as many verified pages as needed for the recovery context.
    const page = await input.store.readCheckpointPage({
      checkpointRef: record.checkpointRef,
      cursor: start,
      limit: Math.max(1, cursor - start),
      principal: input.principal,
      sessionId: record.sessionId,
    });
    ({ metadata } = page);
    for (let index = page.events.length - 1; index >= 0 && messages.length < 20; index -= 1) {
      const event = page.events[index];
      if (event?.type === "assistant_message") {
        messages.unshift(event.text);
      }
    }
    cursor = start;
  } while (cursor > 0 && messages.length < 20);
  if (metadata === undefined) {
    throw new HostedSessionRecoveryUnavailableError();
  }
  return recoveryPromptForPagedSession({
    earlierEventsRemain: cursor > 0,
    metadata,
    recentMessages: messages,
    record,
  });
}

interface PagedEventSpool {
  directory: string;
  path: string;
  eventCount: number;
  eventStartIndex?: number;
  digest: string;
}

interface PagedObservationSpool extends PagedEventSpool {
  eventStartIndex: number;
  observation: Awaited<ReturnType<NonNullable<HostedEveTransport["observe"]>>>;
  privateApprovalCaptureState: PrivateHostedApprovalCaptureState;
}

// eslint-disable-next-line eslint/func-style -- Snapshot transports still return one materialized value, but durable persistence is paged.
async function spoolSnapshotEvents(snapshot: HostedEngineSnapshot): Promise<PagedEventSpool> {
  let directory: string;
  try {
    directory = await mkdtemp(nodePath.join(tmpdir(), "app-builder-checkpoint-"));
  } catch (error) {
    throw new Error(
      "Builder could not create private Eve checkpoint material. Check available local disk space and retry this saved session.",
      { cause: error },
    );
  }
  const path = nodePath.join(directory, "events.ndjson");
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "wx", 0o600);
    const hash = createHash("sha256");
    let eventCount = 0;
    for (const candidate of snapshot.events) {
      if (candidate === null || typeof candidate !== "object") {
        continue;
      }
      const projected = toPublicEvent(candidate as InternalEveEvent);
      if (projected === null) {
        continue;
      }
      const parsed = publicEveEventSchema.safeParse({ ...projected, index: eventCount });
      if (!parsed.success) {
        continue;
      }
      const line = `${JSON.stringify(parsed.data)}\n`;
      try {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Checkpoint spool writes must preserve backpressure.
        await file.writeFile(line);
      } catch (error) {
        throw new Error(
          `Builder could not write private Eve checkpoint material at ${path}. Free local disk space and retry this saved session.`,
          { cause: error },
        );
      }
      hash.update(line);
      eventCount += 1;
    }
    await file.sync();
    await file.close();
    file = null;
    return { digest: hash.digest("hex"), directory, eventCount, path };
  } catch (error) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The original spool or stream error remains authoritative.
      }
    }
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

const checkpointMetadataForSnapshot = (
  snapshot: HostedEngineSnapshot,
  capturedAtEpochMs: number,
  truncatedBeforeIndex?: number,
): HostedPagedCheckpointMetadata => {
  const internalEvents = snapshot.events.filter(
    (event): event is InternalEveEvent => event !== null && typeof event === "object",
  );
  const inputRequests = outstandingInternalEveRequests(internalEvents);
  return {
    capturedAtEpochMs,
    ...(snapshot.nativeDeliveryState === undefined
      ? {}
      : { nativeDeliveryState: snapshot.nativeDeliveryState }),
    ...(snapshot.privateInputState === undefined
      ? {}
      : { privateInputState: snapshot.privateInputState }),
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
    ...(snapshot.prototype === undefined ? {} : { prototype: snapshot.prototype }),
    status: snapshot.status,
    ...(truncatedBeforeIndex === undefined ? {} : { truncatedBeforeIndex }),
    ...(snapshot.uiPreview === undefined ? {} : { uiPreview: snapshot.uiPreview }),
    version: 1,
    ...(snapshot.workingPreview === undefined ? {} : { workingPreview: snapshot.workingPreview }),
  };
};

// eslint-disable-next-line eslint/func-style -- Project snapshot events lazily for progress recovery.
function* publicSnapshotEvents(snapshot: HostedEngineSnapshot) {
  let eventCount = 0;
  for (const candidate of snapshot.events) {
    if (candidate === null || typeof candidate !== "object") {
      continue;
    }
    const projected = toPublicEvent(candidate as InternalEveEvent);
    if (projected === null) {
      continue;
    }
    const parsed = publicEveEventSchema.safeParse({ ...projected, index: eventCount });
    if (parsed.success) {
      eventCount += 1;
      yield parsed.data;
    }
  }
}

// eslint-disable-next-line eslint/func-style -- Capture the absolute public tail before dispatch, including retained legacy offsets.
function mutationEventCursor(record: HostedSessionRecord) {
  const durable = toDurableHostedSessionRecord(record);
  return (
    durable.checkpointRef?.eventCount ??
    (durable.checkpoint?.truncatedBeforeIndex ?? 0) + (durable.checkpoint?.events.length ?? 0)
  );
}

// eslint-disable-next-line eslint/func-style -- Count public history without materializing a second copy.
function publicSnapshotEventCount(snapshot: HostedEngineSnapshot) {
  let count = 0;
  for (const event of publicSnapshotEvents(snapshot)) {
    count = event.index + 1;
  }
  return count;
}

// eslint-disable-next-line eslint/func-style -- The spool is consumed only after Eve's durable tail is verified.
async function spoolObservedSession(input: {
  transport: NonNullable<HostedEveTransport["observe"]>;
  store: HostedEveStore;
  principal: HostedPrincipal;
  sessionId: string;
  adapterSessionId: string;
  nativeObservationState?: NativeObservationState;
  privateApprovalCaptureState?: PrivateHostedApprovalCaptureState;
  allowPartialObservation?: boolean;
}): Promise<PagedObservationSpool> {
  let directory: string;
  try {
    directory = await mkdtemp(nodePath.join(tmpdir(), "app-builder-checkpoint-"));
  } catch (error) {
    throw new Error(
      "Builder could not create private Eve checkpoint material. Check available local disk space and retry this saved session.",
      { cause: error },
    );
  }
  const path = nodePath.join(directory, "events.ndjson");
  const privateApprovals = createPrivateHostedApprovalRecorder({
    principal: input.principal,
    sessionId: input.sessionId,
    store: input.store,
    ...(input.privateApprovalCaptureState === undefined
      ? {}
      : { state: input.privateApprovalCaptureState }),
  });
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "wx", 0o600);
    const handle = file;
    const hash = createHash("sha256");
    let eventCount = 0;
    const eventStartIndex = input.nativeObservationState?.publicEventCount ?? 0;
    const observation = await input.transport({
      adapterSessionId: input.adapterSessionId,
      allowPartialObservation: input.allowPartialObservation ?? false,
      ...(input.nativeObservationState === undefined
        ? {}
        : { nativeObservationState: input.nativeObservationState }),
      onEvent: async (candidate) => {
        const projected = toPublicEvent(candidate);
        if (projected === null) {
          return;
        }
        const parsed = publicEveEventSchema.safeParse({
          ...projected,
          index: eventStartIndex + eventCount,
        });
        if (!parsed.success) {
          return;
        }
        const line = `${JSON.stringify(parsed.data)}\n`;
        try {
          await handle.writeFile(line);
        } catch (error) {
          throw new Error(
            `Builder could not write private Eve checkpoint material at ${path}. Free local disk space and retry this saved session.`,
            { cause: error },
          );
        }
        hash.update(line);
        eventCount += 1;
      },
      onPrivateEvent: privateApprovals.observe,
      principal: input.principal,
      sessionId: input.sessionId,
    });
    await handle.sync();
    await handle.close();
    file = null;
    return {
      digest: hash.digest("hex"),
      directory,
      eventCount,
      eventStartIndex,
      observation,
      path,
      privateApprovalCaptureState: privateApprovals.snapshot(),
    };
  } catch (error) {
    if (file !== null) {
      try {
        await file.close();
      } catch {
        // The original spool or stream error remains authoritative.
      }
    }
    await rm(directory, { force: true, recursive: true });
    throw error;
  }
}

// eslint-disable-next-line eslint/func-style -- Each verified line is released after staging.
async function* readSpoolEvents(spool: PagedEventSpool) {
  const hash = createHash("sha256");
  let count = 0;
  const lines = createInterface({ crlfDelay: Infinity, input: createReadStream(spool.path) });
  try {
    for await (const line of lines) {
      hash.update(`${line}\n`);
      const event = publicEveEventSchema.parse(JSON.parse(line));
      if (event.index !== count + (spool.eventStartIndex ?? 0)) {
        throw new Error("Private Eve checkpoint spool has nonconsecutive event indexes.");
      }
      count += 1;
      yield event;
    }
  } finally {
    lines.close();
  }
  if (count !== spool.eventCount || hash.digest("hex") !== spool.digest) {
    throw new Error("Private Eve checkpoint spool changed before durable publication.");
  }
}

const assertCompletePrivateBatch = (state: PrivateInputState, result: EveSessionResult) => {
  const ids = state.pending.flatMap((batch) => batch.requests.map((request) => request.requestId));
  const pending = (result.inputRequests ?? []).filter(
    (request) => request.kind !== "authorization",
  );
  if (
    pending.length !== ids.length ||
    pending.some((request, index) => request.requestId !== ids[index])
  ) {
    throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
  }
};
const guardClientRequestId = (
  session: HostedSessionRecord,
  batch: NativeInputBatch,
  decision: "continue" | "stop" = "continue",
) =>
  stableId(decision === "stop" ? "framework_stop" : "framework_usage", {
    adapterGeneration: toDurableHostedSessionRecord(session).adapterGeneration,
    adapterSessionId: session.adapterSessionId,
    batch,
    sessionId: session.sessionId,
  });
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
  assertSendDeliveryOwner?: typeof assertHostedBuildDecisionOwner;
  assertSessionLimitOwner?: typeof assertHostedBuildDecisionOwner;
  now?: () => number;
  onSubmissionDiagnostic?: HostedSubmissionDiagnosticSink;
  sessionTimeoutPolicy?: HostedSessionTimeoutPolicy;
}): EveSessionService {
  // Presentation reuses private state already captured by this owned read/mutation. It never
  // causes a second checkpoint read or changes the requested public cursor.
  const presentationInputs = new Map<string, PrivateInputState | undefined>();
  const capturedInputs = new Map<
    string,
    {
      adapterGeneration: number;
      adapterSessionId: string;
      checkpointDigest?: string;
      deliveryState?: NativeDeliveryState;
      state?: PrivateInputState;
    }
  >();
  const rememberCheckpointInputs = (
    record: HostedSessionRecord,
    metadata: HostedPagedCheckpointMetadata,
  ) => {
    const durable = toDurableHostedSessionRecord(record);
    const state = metadata.nativeObservationState?.privateInputState ?? metadata.privateInputState;
    capturedInputs.set(durable.sessionId, {
      adapterGeneration: durable.adapterGeneration,
      adapterSessionId: durable.adapterSessionId,
      checkpointDigest: durable.checkpointDigest,
      deliveryState:
        metadata.nativeObservationState?.nativeDeliveryState ?? metadata.nativeDeliveryState,
      state,
    });
    presentationInputs.set(durable.sessionId, state);
  };
  const projectSnapshot = (
    sessionId: string,
    snapshot: HostedEngineSnapshot,
    cursor = 0,
    limit = 100,
  ) => {
    const result = projectHostedSnapshot(sessionId, snapshot, cursor, limit);
    presentationInputs.set(sessionId, snapshot.privateInputState);
    return result;
  };
  const principal = hostedPrincipalSchema.parse(input.principal);
  const now = input.now ?? Date.now;
  const sessionTimeoutPolicy = hostedSessionTimeoutPolicySchema.parse(
    input.sessionTimeoutPolicy ?? DEFAULT_HOSTED_SESSION_TIMEOUT_POLICY,
  );

  const readStartOperation = async (
    clientRequestId: string,
    phase: "start_lookup" | "start_alias_lookup",
  ): Promise<HostedOperationRecord | null | undefined> => {
    try {
      return await input.store.getStartOperation?.(principal, clientRequestId);
    } catch (error) {
      reportHostedSubmissionDiagnostic({
        clientRequestId,
        error,
        operationKind: "start",
        phase,
        sink: input.onSubmissionDiagnostic,
      });
      throw error;
    }
  };

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

  const assertSessionLimitOwner = async (session: HostedSessionRecord) => {
    await (input.assertSessionLimitOwner ?? assertHostedBuildDecisionOwner)(
      toDurableHostedSessionRecord(session),
    );
  };
  const privateInputsForSession = async (
    session: HostedSessionRecord,
  ): Promise<PrivateInputState | undefined> => {
    const durable = toDurableHostedSessionRecord(session);
    if (durable.checkpointRef === undefined) {
      presentationInputs.set(durable.sessionId, durable.checkpoint?.privateInputState);
      return durable.checkpoint?.privateInputState;
    }
    const captured = capturedInputs.get(durable.sessionId);
    if (
      captured?.adapterSessionId === durable.adapterSessionId &&
      captured.adapterGeneration === durable.adapterGeneration &&
      captured.checkpointDigest === durable.checkpointDigest
    ) {
      return captured.state;
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- The checkpoint reader is initialized before any service call.
    const metadata = await readCheckpointMetadata(session);
    return metadata?.nativeObservationState?.privateInputState ?? metadata?.privateInputState;
  };
  const nativeDeliveriesForSession = async (
    session: HostedSessionRecord,
  ): Promise<NativeDeliveryState | undefined> => {
    const durable = toDurableHostedSessionRecord(session);
    if (durable.checkpointRef === undefined) {
      return durable.checkpoint?.nativeDeliveryState;
    }
    const captured = capturedInputs.get(durable.sessionId);
    if (
      captured?.adapterSessionId === durable.adapterSessionId &&
      captured.adapterGeneration === durable.adapterGeneration &&
      captured.checkpointDigest === durable.checkpointDigest
    ) {
      return captured.deliveryState;
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- The observer reader is initialized before any public service call.
    const metadata = await readCheckpointMetadata(session);
    return metadata?.nativeObservationState?.nativeDeliveryState ?? metadata?.nativeDeliveryState;
  };
  const assertSendOwner = (session: HostedSessionRecord) =>
    (input.assertSendDeliveryOwner ?? assertHostedBuildDecisionOwner)(
      toDurableHostedSessionRecord(session),
    );
  const reconcileSendOperation = async (
    operation: HostedOperationRecord,
  ): Promise<EveSessionResult | undefined> => {
    if (operation.sendDelivery === undefined || operation.sessionId === undefined) {
      return undefined;
    }
    const session = await requireSession(operation.sessionId);
    await assertSendOwner(session);
    const binding = toDurableHostedSessionRecord(session);
    if (
      binding.adapterSessionId !== operation.sendDelivery.adapterSessionId ||
      binding.adapterGeneration !== operation.sendDelivery.adapterGeneration
    ) {
      return undefined;
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- Reconciliation uses the initialized canonical observer without sending again.
    const result = await readSession(
      {
        continueWork: false,
        cursor: 0,
        limit: 100,
        recoverUnavailable: false,
        sessionId: operation.sessionId,
      },
      operation.operationId,
    );
    const current = await requireSession(operation.sessionId);
    const proof = await nativeDeliveriesForSession(current);
    if (!isProvedSendDelivery(operation, current, proof)) {
      return undefined;
    }
    await assertSendOwner(current);
    const settled = await input.store.settleSucceeded({
      nowEpochMs: now(),
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      result,
      sendDeliveryResolution: proof,
    });
    const verified = requireOwnedOperation(settled, {
      clientRequestId: operation.clientRequestId,
      kind: "send",
      operationId: operation.operationId,
      requestDigest: operation.requestDigest,
      sessionId: operation.sessionId,
    });
    return verified.state === "succeeded" ? verified.result : undefined;
  };
  const reconcileResourceApprovalOperation = async (
    operation: HostedOperationRecord,
    request: unknown,
  ): Promise<EveSessionResult | undefined> => {
    const parsed = resourceApprovalResponseProofSchema.shape.request.safeParse(request);
    if (
      !parsed.success ||
      operation.sessionId === undefined ||
      operation.internalSessionLimitResponse !== undefined
    ) {
      return undefined;
    }
    const before = toDurableHostedSessionRecord(await requireSession(operation.sessionId));
    if (
      operation.resourceApprovalResponse === undefined &&
      (before.adapterGeneration !== 1 || before.adapterSessionId !== before.originAdapterSessionId)
    ) {
      return undefined;
    }
    await assertSendOwner(before);
    // oxlint-disable-next-line eslint/no-use-before-define -- Reconciliation observes only and never dispatches RESPOND again.
    const result = await readSession({
      continueWork: false,
      recoverUnavailable: false,
      cursor: 0,
      limit: 100,
      sessionId: operation.sessionId,
    });
    const current = toDurableHostedSessionRecord(await requireSession(operation.sessionId));
    const proof = resourceApprovalResponseProofSchema.safeParse({
      adapterGeneration: current.adapterGeneration,
      adapterSessionId: current.adapterSessionId,
      checkpointDigest: current.checkpointDigest,
      request: parsed.data,
    });
    if (!proof.success) {
      return undefined;
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- The initialized checkpoint reader is used only during a service call.
    const metadata = await readCheckpointMetadata(current);
    if (!isProvedResourceApprovalResponse(operation, current, proof.data, metadata)) {
      return undefined;
    }
    await assertSendOwner(current);
    const settled = await input.store.settleSucceeded({
      principal,
      operationId: operation.operationId,
      requestDigest: operation.requestDigest,
      result,
      resourceApprovalResolution: proof.data,
      nowEpochMs: now(),
    });
    const verified = requireOwnedOperation(settled, {
      clientRequestId: operation.clientRequestId,
      kind: "respond",
      operationId: operation.operationId,
      requestDigest: operation.requestDigest,
      sessionId: operation.sessionId,
    });
    return verified.state === "succeeded" ? verified.result : undefined;
  };
  const respondOperationId = (clientRequestId: string) =>
    stableId("op", {
      clientRequestId,
      kind: "respond",
      tenant: [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
    });
  const reconcileSessionLimitOperation = async (
    operation: HostedOperationRecord,
    result: EveSessionResult,
  ): Promise<EveSessionResult | undefined> => {
    const marker = operation.internalSessionLimitResponse;
    if (
      operation.kind !== "respond" ||
      marker === undefined ||
      operation.sessionId !== result.sessionId ||
      tenantKeyFor(operation.principal) !== tenantKeyFor(principal) ||
      !["reserved", "submission_unknown"].includes(operation.state)
    ) {
      return undefined;
    }
    const session = toDurableHostedSessionRecord(await requireSession(result.sessionId));
    await assertSessionLimitOwner(session);
    const state = await privateInputsForSession(session);
    if (
      session.adapterSessionId !== marker.adapterSessionId ||
      session.adapterGeneration !== marker.adapterGeneration ||
      state === undefined ||
      !provesSessionLimitResponse(marker, state)
    ) {
      return undefined;
    }
    const settled = await input.store.settleSucceeded({
      nowEpochMs: now(),
      operationId: operation.operationId,
      principal,
      requestDigest: operation.requestDigest,
      result,
      sessionLimitResolution: state,
    });
    const verified = requireOwnedOperation(settled, {
      clientRequestId: operation.clientRequestId,
      kind: "respond",
      operationId: operation.operationId,
      requestDigest: operation.requestDigest,
      sessionId: operation.sessionId,
    });
    return verified.state === "succeeded" ? verified.result : undefined;
  };
  const continueSessionLimitGuard = async (
    sessionId: string,
    result: EveSessionResult,
  ): Promise<EveSessionResult> => {
    const session = await requireSession(sessionId);
    const state = await privateInputsForSession(session);
    if (state === undefined || input.store.getPrivateOperation === undefined) {
      return result;
    }
    const ids = guardRequestIds(state);
    const controlledIds = resolvedGuardRequestIds(state);
    const reconciliation = state.resolved.flatMap((resolved) =>
      resolved.batch.requests.every(isLegacySessionLimitRequest)
        ? guardDecisions.map((decision) => ({ batch: resolved.batch, decision }))
        : [],
    );
    for (const { batch, decision } of reconciliation) {
      // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Settle canonical responses in the observed native order.
      const operation = await input.store.getPrivateOperation(
        principal,
        respondOperationId(guardClientRequestId(session, batch, decision)),
      );
      if (operation?.internalSessionLimitResponse === undefined) {
        continue;
      }
      const settled =
        operation.state === "succeeded"
          ? operation.result
          : // oxlint-disable-next-line eslint/no-await-in-loop -- Settle this exact native cancellation before advancing.
            await reconcileSessionLimitOperation(operation, result);
      if (
        settled === undefined &&
        operation.internalSessionLimitResponse.decision === "stop" &&
        (operation.state === "reserved" || operation.state === "submission_unknown")
      ) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- Retain current ownership while waiting for this exact stop operation.
        await assertSessionLimitOwner(session);
        return {
          ...omitControlledGuardQuestions(
            result,
            guardRequestIds({
              pending: operation.internalSessionLimitResponse.batches,
              resolved: [],
              version: 1,
            }),
          ),
          error: {
            code: "framework_stop_settling",
            message:
              "Builder is reconciling your stop request. Keep this session and read it again; no product decision is required.",
          },
          status: "working",
        };
      }
      if (settled !== undefined) {
        controlledIds.push(
          ...guardRequestIds({
            pending: operation.internalSessionLimitResponse.batches,
            resolved: [],
            version: 1,
          }),
        );
      }
    }
    if (["cancelled", "completed", "failed"].includes(result.status)) {
      if (controlledIds.length > 0) {
        await assertSessionLimitOwner(session);
      }
      return omitControlledGuardQuestions(result, controlledIds);
    }
    if (controlledIds.length > 0) {
      await assertSessionLimitOwner(session);
      const filtered = omitControlledGuardQuestions(result, controlledIds);
      return ids.length === 0
        ? filtered
        : // oxlint-disable-next-line eslint/no-use-before-define -- The continuation helper is initialized before public service calls.
          await continuePendingSessionLimitGuard(session, state, filtered, ids);
    }
    if (ids.length === 0) {
      return result;
    }
    // oxlint-disable-next-line eslint/no-use-before-define -- The continuation helper is initialized before public service calls.
    return await continuePendingSessionLimitGuard(session, state, result, ids);
  };
  const continuePendingSessionLimitGuard = async (
    session: HostedSessionRecord,
    state: PrivateInputState,
    result: EveSessionResult,
    ids: string[],
  ): Promise<EveSessionResult> => {
    const { sessionId } = session;
    await assertSessionLimitOwner(session);
    const [firstGuardBatch] = frameworkGuardBatches(state);
    if (firstGuardBatch !== undefined && input.store.getPrivateOperation !== undefined) {
      const stop = await input.store.getPrivateOperation(
        principal,
        respondOperationId(guardClientRequestId(session, firstGuardBatch, "stop")),
      );
      if (stop?.internalSessionLimitResponse?.decision === "stop") {
        if (stop.state === "succeeded") {
          return omitControlledGuardQuestions(
            {
              ...result,
              inputRequests: stop.result.inputRequests ?? [],
              status: stop.result.status,
            },
            ids,
          );
        }
        return {
          ...omitControlledGuardQuestions(result, ids),
          error: {
            code: "framework_stop_settling",
            message:
              "Builder is reconciling your stop request. Keep this session and read it again; no product decision is required.",
          },
          status: "working",
        };
      }
    }
    assertCompletePrivateBatch(state, result);
    if (result.inputRequests?.some((request) => request.kind === "authorization") === true) {
      return omitControlledGuardQuestions(result, ids);
    }
    if (
      state.pending.some((batch) =>
        batch.requests.some((request) => !isLegacySessionLimitRequest(request)),
      )
    ) {
      return omitControlledGuardQuestions(result, ids);
    }
    const [batch] = state.pending;
    if (batch === undefined) {
      return result;
    }
    try {
      // oxlint-disable-next-line eslint/no-use-before-define -- Shared hoisted canonical RESPOND path.
      const next = await respondRequest(
        {
          clientRequestId: guardClientRequestId(session, batch),
          responses: mergeSessionLimitResponses(state, []),
          sessionId,
        },
        {
          adapterGeneration: toDurableHostedSessionRecord(session).adapterGeneration,
          adapterSessionId: session.adapterSessionId,
          batches: state.pending,
        },
      );
      // Preserve this read's public cursor and event page; the continuation's pending state is current.
      return omitControlledGuardQuestions(
        {
          ...result,
          inputRequests: next.inputRequests ?? [],
          status: next.status,
          ...(next.error === undefined ? {} : { error: next.error }),
        },
        ids,
      );
    } catch (error) {
      if (!(error instanceof HostedSubmissionUnknownError)) {
        throw error;
      }
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

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  const continueApprovedWork = async (
    sessionId: string,
    result: EveSessionResult,
  ): Promise<EveSessionResult> => {
    try {
      const controlled = await continueSessionLimitGuard(sessionId, result);
      const current = toDurableHostedSessionRecord(await requireSession(sessionId));
      const inputs = await privateInputsForSession(current);
      if (inputs !== undefined && pendingFrameworkGuardIds(inputs).length > 0) {
        return presentSessionLimitState(controlled, inputs);
      }
      const stoppedTurns = inputs === undefined ? [] : sessionLimitCancelledTurns(inputs);
      if (current.privateBuildDecision !== undefined && inputs !== undefined) {
        for (const resolved of inputs.resolved) {
          if (resolved.stopSettled !== true) {
            continue;
          }
          // oxlint-disable-next-line eslint/no-await-in-loop, react-doctor/async-await-in-loop -- Reconcile ordered cancellation receipts under current ownership.
          const stop = await input.store.getPrivateOperation?.(
            principal,
            respondOperationId(guardClientRequestId(current, resolved.batch, "stop")),
          );
          if (stop?.internalSessionLimitResponse?.stoppedBuildTurnId !== undefined) {
            stoppedTurns.push(stop.internalSessionLimitResponse.stoppedBuildTurnId);
          }
        }
        if (stoppedTurns.includes(current.privateBuildDecision.turnId)) {
          return controlled;
        }
      }
      return await continueApprovedHostedBuild({
        assertCurrentOwner: assertHostedBuildDecisionOwner,
        now,
        principal,
        result: controlled,
        sessionId,
        store: input.store,
        transport: input.transport,
      });
    } catch {
      return {
        ...result,
        error: {
          code: "approved_build_continuation_unavailable",
          message:
            "The approved build continuation could not verify current ownership or canonical settlement. Preserve this session and restore that boundary.",
        },
      };
    }
  };

  // oxlint-disable-next-line eslint/func-style -- Preserve the existing hoisted canonical mutation helper.
  async function mutate<T extends { clientRequestId: string }>(options: {
    kind: HostedOperationKind;
    request: T;
    sessionId?: string;
    resumeSessionId?: string;
    internalSessionLimitResponse?: InternalSessionLimitResponse;
    resourceApprovalResponse?: ResourceApprovalResponseMarker;
    dispatch: (operationId: string) => Promise<{
      result: EveSessionResult;
      sendDeliveryResolution?: NativeDeliveryState;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
      newSessionPaged?: {
        session: HostedPagedSessionBase;
        metadata: HostedPagedCheckpointMetadata;
        events: AsyncIterable<z.infer<typeof publicEveEventSchema>>;
        cleanup: () => Promise<void>;
      };
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
      ...(options.internalSessionLimitResponse === undefined
        ? {}
        : { internalSessionLimitResponse: options.internalSessionLimitResponse }),
      ...(options.resourceApprovalResponse === undefined
        ? {}
        : { resourceApprovalResponse: options.resourceApprovalResponse }),
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
    let recoveringStart = false;
    const diagnose = (
      phase: HostedSubmissionPhase,
      error: unknown,
      adapterSessionId?: string,
    ): void => {
      reportHostedSubmissionDiagnostic({
        adapterSessionId,
        clientRequestId: options.request.clientRequestId,
        error,
        operationId,
        operationKind: options.kind,
        phase,
        sink: input.onSubmissionDiagnostic,
      });
    };
    try {
      reservation = reserveOperationResultSchema.parse(
        await input.store.reserveOperation(principal, candidate),
      );
    } catch (error) {
      diagnose("reservation", error);
      throw new HostedSubmissionUnknownError();
    }
    try {
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
              if (operation.kind === "send" && operation.sendDelivery !== undefined) {
                const settled = await reconcileSendOperation(operation);
                if (settled !== undefined) {
                  return settled;
                }
              }
              if (
                operation.kind === "respond" &&
                operation.internalSessionLimitResponse !== undefined
              ) {
                // oxlint-disable-next-line eslint/no-use-before-define -- Canonical reconciliation calls the hoisted observer without continuing work.
                const result = await readSession({
                  continueWork: false,
                  cursor: 0,
                  limit: 100,
                  sessionId: operation.sessionId ?? "",
                });
                const settled = await reconcileSessionLimitOperation(operation, result);
                if (settled !== undefined) {
                  return settled;
                }
              }
              if (
                operation.kind === "respond" &&
                operation.internalSessionLimitResponse === undefined
              ) {
                const settled = await reconcileResourceApprovalOperation(
                  operation,
                  options.request,
                );
                if (settled !== undefined) {
                  return settled;
                }
              }
              // Canonical Eve session creation is idempotent for this principal
              // and operationId while its first run remains resumable. Once Eve
              // expires that ownership, an exact retry may begin a new run.
              // Only starts may retry; send/respond remain non-replayable.
              if (
                options.kind !== "start" ||
                (operation.state === "reserved" &&
                  now() - operation.updatedAtEpochMs < HOSTED_START_REQUEST_TIMEOUT_MS)
              ) {
                throw new HostedSubmissionUnknownError();
              }
              recoveringStart = true;
              break;
            }
            case "rejected": {
              throw new HostedRejectedOperationError(operation.safeErrorCode);
            }
            default: {
              return assertNever(operation);
            }
          }
          break;
        }
        default: {
          return assertNever(reservation);
        }
      }
    } catch (error) {
      if (
        !(error instanceof HostedIdempotencyConflictError) &&
        !(error instanceof HostedRejectedOperationError) &&
        !(error instanceof HostedSessionBusyError)
      ) {
        diagnose("reservation_verification", error);
      }
      throw error;
    }

    let dispatched: {
      result: EveSessionResult;
      sendDeliveryResolution?: NativeDeliveryState;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
      newSessionPaged?: {
        session: HostedPagedSessionBase;
        metadata: HostedPagedCheckpointMetadata;
        events: AsyncIterable<z.infer<typeof publicEveEventSchema>>;
        cleanup: () => Promise<void>;
      };
    };
    try {
      dispatched = await options.dispatch(operationId);
    } catch (error) {
      diagnose("dispatch", error);
      if (recoveringStart) {
        // An earlier request may have accepted the create. Retain its
        // uncertain record so another exact retry can adopt the same run.
        throw new HostedSubmissionUnknownError();
      }
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
      } catch (settlementError) {
        diagnose("unsuccessful_settlement", settlementError);
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

    let settlementPhase: HostedSubmissionPhase = "settlement_verification";
    try {
      const dispatchedResult = eveSessionResultSchema.parse(dispatched.result);
      const dispatchedSession =
        dispatched.newSession === undefined
          ? undefined
          : hostedSessionRecordSchema.parse(dispatched.newSession);
      const dispatchedPagedSession = dispatched.newSessionPaged;
      const dispatchedSessionId =
        dispatchedSession?.sessionId ?? dispatchedPagedSession?.session.sessionId;
      if (
        (dispatchedSession !== undefined && dispatchedPagedSession !== undefined) ||
        (options.kind === "start" && dispatchedSessionId === undefined) ||
        (options.kind !== "start" && dispatchedSessionId !== undefined) ||
        (dispatchedSession !== undefined &&
          dispatchedResult.sessionId !== dispatchedSession.sessionId) ||
        (dispatchedPagedSession !== undefined &&
          dispatchedResult.sessionId !== dispatchedPagedSession.session.sessionId)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      let settled: HostedOperationRecord;
      settlementPhase = "settlement";
      if (dispatchedPagedSession === undefined) {
        settled = await input.store.settleSucceeded({
          nowEpochMs: now(),
          operationId,
          principal,
          requestDigest,
          result: dispatchedResult,
          ...(dispatched.sendDeliveryResolution === undefined
            ? {}
            : { sendDeliveryResolution: dispatched.sendDeliveryResolution }),
          ...(dispatchedSession === undefined ? {} : { session: dispatchedSession }),
        });
      } else {
        if (input.store.settleSucceededPaged === undefined) {
          throw new HostedSubmissionUnknownError();
        }
        settled = await input.store.settleSucceededPaged({
          events: dispatchedPagedSession.events,
          metadata: dispatchedPagedSession.metadata,
          nowEpochMs: now(),
          operationId,
          principal,
          requestDigest,
          result: dispatchedResult,
          session: dispatchedPagedSession.session,
        });
      }
      settlementPhase = "settlement_verification";
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
        const verifiedSession = toDurableHostedSessionRecord(
          await requireBoundSucceededStartSession(verified),
        );
        if (
          hostedSessionRecordDigest(verifiedSession) !==
            hostedSessionRecordDigest(dispatchedSession) ||
          canonical(verifiedSession) !== canonical(dispatchedSession)
        ) {
          throw new HostedSubmissionUnknownError();
        }
      }
      if (dispatchedPagedSession !== undefined) {
        if (verifiedResult.sessionId !== dispatchedPagedSession.session.sessionId) {
          throw new HostedSubmissionUnknownError();
        }
        const verifiedSession = toDurableHostedSessionRecord(
          await requireBoundSucceededStartSession(verified),
        );
        const {
          checkpoint: _checkpoint,
          checkpointDigest: _checkpointDigest,
          checkpointProgressDigest: _checkpointProgressDigest,
          checkpointRef: _checkpointRef,
          ...verifiedBase
        } = verifiedSession;
        void _checkpoint;
        void _checkpointDigest;
        void _checkpointProgressDigest;
        void _checkpointRef;
        if (
          verifiedSession.checkpointRef === undefined ||
          canonical(verifiedBase) !== canonical(dispatchedPagedSession.session)
        ) {
          throw new HostedSubmissionUnknownError();
        }
      }
      return options.sessionId === undefined
        ? verifiedResult
        : await continueApprovedWork(options.sessionId, verifiedResult);
    } catch (error) {
      diagnose(
        settlementPhase,
        error,
        dispatched.newSession?.adapterSessionId ??
          dispatched.newSessionPaged?.session.adapterSessionId,
      );
      if (recoveringStart) {
        try {
          const replayed = reserveOperationResultSchema.parse(
            await input.store.reserveOperation(principal, candidate),
          );
          if (replayed.disposition === "existing") {
            const winner = requireOwnedOperation(replayed.operation, {
              clientRequestId: options.request.clientRequestId,
              kind: options.kind,
              operationId,
              requestDigest,
              resumeSessionId: options.resumeSessionId,
              sessionId: options.sessionId,
            });
            if (winner.state === "succeeded") {
              await requireBoundSucceededStartSession(winner);
              return eveSessionResultSchema.parse(winner.result);
            }
          }
        } catch (recoveryError) {
          diagnose("recovery", recoveryError);
          // The durable outcome is still unknown.
        }
      }
      // Eve may have accepted the mutation even if durable settlement failed.
      // Mutations other than start remain non-replayable. If the transaction
      // committed and only its response was lost, exact retry reads the result.
      throw new HostedSubmissionUnknownError();
    } finally {
      if (dispatched.newSessionPaged !== undefined) {
        try {
          await dispatched.newSessionPaged.cleanup();
        } catch (error) {
          diagnose("checkpoint_cleanup", error);
          // oxlint-disable-next-line eslint/no-unsafe-finally -- Preserve the existing cleanup rejection behavior; diagnostics do not change outcomes.
          throw error;
        }
      }
    }
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function observeSnapshot(
    sessionId: string,
    snapshot: HostedEngineSnapshot,
    resumability: "live" | "terminal" | "checkpoint" = [
      "completed",
      "failed",
      "cancelled",
    ].includes(snapshot.status)
      ? "terminal"
      : "live",
    capturedAtEpochMs = now(),
    cursor = 0,
    explicitSendOperationId?: string,
  ) {
    const completeResult = projectSnapshot(sessionId, snapshot, cursor, 100);
    if (
      input.store.observeSessionPaged !== undefined &&
      input.store.readCheckpointPage !== undefined
    ) {
      const current = toDurableHostedSessionRecord(await requireSession(sessionId));
      let truncatedBeforeIndex = current.checkpoint?.truncatedBeforeIndex;
      if (current.checkpointRef !== undefined) {
        const priorPage = await input.store.readCheckpointPage({
          checkpointRef: current.checkpointRef,
          cursor: 0,
          limit: 1,
          principal,
          sessionId,
        });
        ({ truncatedBeforeIndex } = priorPage.metadata);
      }
      const metadata = checkpointMetadataForSnapshot(
        snapshot,
        capturedAtEpochMs,
        truncatedBeforeIndex,
      );
      const spool = await spoolSnapshotEvents(snapshot);
      try {
        const summary = eveSessionResultSchema.parse({
          cursor: 0,
          events: [],
          ...(metadata.inputRequests === undefined
            ? {}
            : { inputRequests: metadata.inputRequests }),
          ...(metadata.prototype === undefined ? {} : { prototype: metadata.prototype }),
          sessionId,
          status: metadata.status,
          ...(metadata.uiPreview === undefined ? {} : { uiPreview: metadata.uiPreview }),
          ...(metadata.workingPreview === undefined
            ? {}
            : { workingPreview: metadata.workingPreview }),
        });
        const observed = await input.store.observeSessionPaged({
          ...(summary.uiPreview?.appId === undefined ? {} : { appId: summary.uiPreview.appId }),
          ...(explicitSendOperationId === undefined ? {} : { explicitSendOperationId }),
          events: readSpoolEvents(spool),
          expectedCheckpointDigest: current.checkpointDigest,
          metadata,
          nowEpochMs: capturedAtEpochMs,
          principal,
          resumability,
          sessionId,
          stage: stageForResult(summary),
        });
        if (observed.status === "cancelled" && explicitSendOperationId !== undefined) {
          // oxlint-disable-next-line eslint/no-use-before-define -- The initialized canonical reader preserves a newer Stop over this SEND snapshot.
          return resultFromDurableCheckpoint(sessionId, observed, cursor, 100);
        }
        return completeResult;
      } finally {
        await rm(spool.directory, { force: true, recursive: true });
      }
    }
    const checkpoint = checkpointForSnapshot(sessionId, snapshot, capturedAtEpochMs);
    const observed = await input.store.observeSession?.({
      checkpoint,
      ...(explicitSendOperationId === undefined ? {} : { explicitSendOperationId }),
      ...(completeResult.uiPreview?.appId === undefined
        ? {}
        : { appId: completeResult.uiPreview.appId }),
      nowEpochMs: capturedAtEpochMs,
      principal,
      resumability,
      sessionId,
      stage: stageForResult(completeResult),
    });
    if (observed?.status === "cancelled") {
      const durable = toDurableHostedSessionRecord(observed);
      if (durable.checkpoint) {
        return resultFromHostedCheckpoint(sessionId, durable.checkpoint, cursor, 100);
      }
    }
    return completeResult;
  }

  // eslint-disable-next-line eslint/func-style -- Paged reads preserve the active tenant-bound manifest reference.
  async function resultFromDurableCheckpoint(
    sessionId: string,
    record: HostedSessionRecord,
    cursor: number,
    limit: number,
  ): Promise<EveSessionResult> {
    const durable = toDurableHostedSessionRecord(record);
    if (durable.checkpointRef !== undefined && input.store.readCheckpointPage !== undefined) {
      const page = await input.store.readCheckpointPage({
        checkpointRef: durable.checkpointRef,
        cursor,
        limit,
        principal,
        sessionId,
      });
      const { metadata } = page;
      rememberCheckpointInputs(record, metadata);
      return eveSessionResultSchema.parse({
        cursor: page.cursor,
        events: page.events,
        ...(metadata.inputRequests === undefined ? {} : { inputRequests: metadata.inputRequests }),
        ...(metadata.prototype === undefined ? {} : { prototype: metadata.prototype }),
        ...(metadata.prototypeRef === undefined ? {} : { prototypeRef: metadata.prototypeRef }),
        sessionId,
        status:
          metadata.status === "working" && durable.resumability === "checkpoint"
            ? "waiting"
            : metadata.status,
        ...(metadata.uiPreview === undefined ? {} : { uiPreview: metadata.uiPreview }),
        ...(metadata.workingPreview === undefined
          ? {}
          : {
              workingPreview:
                metadata.status === "failed" || metadata.status === "cancelled"
                  ? null
                  : currentWorkingPreview(metadata.workingPreview),
            }),
      });
    }
    if (durable.checkpoint !== undefined) {
      return resultFromHostedCheckpoint(sessionId, durable.checkpoint, cursor, limit);
    }
    throw new HostedSessionRecoveryUnavailableError();
  }

  // eslint-disable-next-line eslint/func-style -- Keep local checkpoint readers adjacent to the observer flow.
  const readCheckpointMetadata = async (
    record: HostedSessionRecord,
  ): Promise<HostedPagedCheckpointMetadata | null> => {
    const durable = toDurableHostedSessionRecord(record);
    if (durable.checkpointRef === undefined || input.store.readCheckpointPage === undefined) {
      return null;
    }
    const page = await input.store.readCheckpointPage({
      checkpointRef: durable.checkpointRef,
      cursor: 0,
      limit: 1,
      principal,
      sessionId: durable.sessionId,
    });
    if (
      page.checkpointDigest !== durable.checkpointRef.digest ||
      page.totalEvents !== durable.checkpointRef.eventCount ||
      page.cursor !== page.events.length ||
      page.events.some((event, index) => event.index !== index)
    ) {
      throw new HostedSessionRecoveryUnavailableError();
    }
    rememberCheckpointInputs(record, page.metadata);
    return page.metadata;
  };

  // eslint-disable-next-line eslint/func-style -- Keep local checkpoint readers adjacent to the observer flow.
  const readCheckpointEvents = async function* readCheckpointEvents(record: HostedSessionRecord) {
    const durable = toDurableHostedSessionRecord(record);
    const ref = durable.checkpointRef;
    if (ref === undefined || input.store.readCheckpointPage === undefined) {
      throw new HostedSessionRecoveryUnavailableError();
    }
    let cursor = 0;
    while (cursor < ref.eventCount) {
      // oxlint-disable-next-line eslint/no-await-in-loop -- Pages are read in cursor order under one checkpoint digest.
      const page = await input.store.readCheckpointPage({
        checkpointRef: ref,
        cursor,
        limit: Math.min(250, ref.eventCount - cursor),
        principal,
        sessionId: durable.sessionId,
      });
      if (
        page.checkpointDigest !== ref.digest ||
        page.totalEvents !== ref.eventCount ||
        page.cursor !== cursor + page.events.length ||
        page.events.length === 0
      ) {
        throw new HostedSessionRecoveryUnavailableError();
      }
      for (const event of page.events) {
        if (event.index !== cursor) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        yield event;
        cursor += 1;
      }
    }
  };

  // eslint-disable-next-line eslint/func-style -- Keep local checkpoint readers adjacent to the observer flow.
  const readCheckpointPrefixAndDelta = async function* readCheckpointPrefixAndDelta(
    record: HostedSessionRecord,
    spool: PagedObservationSpool,
  ) {
    yield* readCheckpointEvents(record);
    yield* readSpoolEvents(spool);
  };

  // eslint-disable-next-line eslint/func-style -- A timeout leaves the saved checkpoint readable without authorizing a response.
  async function delayedCheckpointResult(
    sessionId: string,
    record: HostedSessionRecord,
    cursor: number,
    limit: number,
  ): Promise<EveSessionResult> {
    const checkpoint = await resultFromDurableCheckpoint(sessionId, record, cursor, limit);
    return eveSessionResultSchema.parse({
      ...checkpoint,
      error: {
        code: "session_read_delayed",
        message:
          "Builder could not finish reading Eve's durable session history within 30 seconds. This does not mean the build stopped or failed. The events shown are the last saved checkpoint. Retry autograph_get with this same session ID and cursor; wait for a read without this warning before responding to an approval or reviewing a final diff. If it repeats, report the session ID and this read operation to the Builder operator.",
      },
      inputRequests: [],
      status: "working",
    });
  }

  // eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
  async function readSession(
    inputValue: {
      sessionId: string;
      cursor: number;
      limit: number;
      recoverUnavailable?: boolean;
      continueWork?: boolean;
    },
    explicitSendOperationId?: string,
  ) {
    const { sessionId, cursor, limit } = inputValue;
    const session = toDurableHostedSessionRecord(await requireSession(sessionId));
    await input.beforeRead?.({
      adapterSessionId: session.adapterSessionId,
      principal,
      sessionId,
      sourceHandoffId: session.sourceHandoffId,
    });
    if (
      input.transport.observe !== undefined &&
      input.store.observeSessionPaged !== undefined &&
      input.store.readCheckpointPage !== undefined
    ) {
      let spool: PagedObservationSpool | undefined;
      try {
        const checkpointMetadata = await readCheckpointMetadata(session);
        const candidateColdProgress = checkpointMetadata?.coldReadProgress;
        if (
          candidateColdProgress !== undefined &&
          checkpointMetadata?.nativeObservationState !== undefined
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const coldReadProgress =
          candidateColdProgress?.nativeObservationState.adapterSessionId ===
          session.adapterSessionId
            ? candidateColdProgress
            : undefined;
        if (
          coldReadProgress !== undefined &&
          (coldReadProgress.events.length !==
            coldReadProgress.nativeObservationState.publicEventCount ||
            coldReadProgress.events.some((event, index) => event.index !== index) ||
            coldReadProgress.privateApprovalCaptureState.sessionId !== sessionId)
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const storedNativeState =
          coldReadProgress?.nativeObservationState ?? checkpointMetadata?.nativeObservationState;
        const parsedNativeState =
          storedNativeState === undefined
            ? undefined
            : nativeObservationStateSchema.parse(storedNativeState);
        const nativeObservationState =
          parsedNativeState?.adapterSessionId === session.adapterSessionId &&
          !(
            parsedNativeState.pendingRequests.some((request) => request.kind === "question") &&
            parsedNativeState.privateInputState === undefined
          )
            ? parsedNativeState
            : undefined;
        if (
          coldReadProgress === undefined &&
          nativeObservationState !== undefined &&
          nativeObservationState.publicEventCount !== session.checkpointRef?.eventCount
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const storedPrivateApprovalCaptureState =
          (coldReadProgress?.privateApprovalCaptureState ??
            checkpointMetadata?.privateApprovalCaptureState) === undefined
            ? undefined
            : privateHostedApprovalCaptureStateSchema.parse(
                coldReadProgress?.privateApprovalCaptureState ??
                  checkpointMetadata?.privateApprovalCaptureState,
              );
        if (
          storedPrivateApprovalCaptureState !== undefined &&
          storedPrivateApprovalCaptureState.sessionId !== sessionId
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const privateApprovalCaptureState =
          storedPrivateApprovalCaptureState === undefined
            ? undefined
            : privateHostedApprovalCaptureStateSchema.parse({
                ...storedPrivateApprovalCaptureState,
                // Pending settlements are meaningful only for the adapter whose native reducer
                // checkpoint captured them. Keep canonicalized receipts, but never bind a
                // replacement adapter's settlement to an old request ID.
                pendingRequests:
                  nativeObservationState === undefined
                    ? []
                    : storedPrivateApprovalCaptureState.pendingRequests,
              });
        spool = await spoolObservedSession({
          adapterSessionId: session.adapterSessionId,
          allowPartialObservation:
            checkpointMetadata?.nativeObservationState === undefined ||
            coldReadProgress !== undefined,
          ...(nativeObservationState === undefined ? {} : { nativeObservationState }),
          ...(privateApprovalCaptureState === undefined ? {} : { privateApprovalCaptureState }),
          principal,
          sessionId,
          store: input.store,
          transport: input.transport.observe,
        });
        const observedNativeState = spool.observation.nativeObservationState;
        if (
          nativeObservationState !== undefined &&
          (observedNativeState === undefined ||
            spool.observation.nextNativeIndex !== observedNativeState.nextNativeIndex)
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        if (
          observedNativeState !== undefined &&
          (observedNativeState.adapterSessionId !== session.adapterSessionId ||
            observedNativeState.publicEventCount !== spool.eventStartIndex + spool.eventCount)
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        if (spool.observation.observationComplete === false) {
          if (
            checkpointMetadata === null ||
            observedNativeState === undefined ||
            session.checkpointRef === undefined
          ) {
            throw new HostedSessionReadTimeoutError();
          }
          if (
            observedNativeState.nextNativeIndex <=
            (coldReadProgress?.nativeObservationState.nextNativeIndex ?? 0)
          ) {
            throw new HostedSessionReadTimeoutError();
          }
          const events = [...(coldReadProgress?.events ?? [])];
          for await (const event of readSpoolEvents(spool)) {
            events.push(event);
          }
          if (
            events.length !== observedNativeState.publicEventCount ||
            events.some((event, index) => event.index !== index)
          ) {
            throw new HostedSessionRecoveryUnavailableError();
          }
          const stored = await input.store.observeSessionPaged({
            ...(explicitSendOperationId === undefined ? {} : { explicitSendOperationId }),
            events: readCheckpointEvents(session),
            expectedCheckpointDigest: session.checkpointDigest,
            metadata: {
              ...checkpointMetadata,
              coldReadProgress: {
                events,
                nativeObservationState: observedNativeState,
                privateApprovalCaptureState: spool.privateApprovalCaptureState,
                version: 1,
              },
            },
            nowEpochMs: now(),
            principal,
            resumability: session.resumability,
            sessionId,
            stage: session.stage,
          });
          return delayedCheckpointResult(sessionId, stored, cursor, limit);
        }
        if (
          coldReadProgress !== undefined &&
          observedNativeState !== undefined &&
          observedNativeState.publicEventCount < (session.checkpointRef?.eventCount ?? 0)
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const completedSpool = spool;
        const readColdPrefixAndDelta = async function* readColdPrefixAndDelta() {
          yield* coldReadProgress?.events ?? [];
          yield* readSpoolEvents(completedSpool);
        };
        let orderedEvents = readSpoolEvents(spool);
        if (coldReadProgress === undefined) {
          if (nativeObservationState !== undefined) {
            orderedEvents = readCheckpointPrefixAndDelta(session, spool);
          }
        } else {
          orderedEvents = readColdPrefixAndDelta();
        }
        if (
          !spool.observation.artifactProjectionRequiresLegacyReadback ||
          spool.observation.prototype !== undefined ||
          spool.observation.prototypeRef !== undefined ||
          observedNativeState !== undefined
        ) {
          const capturedAtEpochMs = now();
          const metadata: HostedPagedCheckpointMetadata = {
            capturedAtEpochMs,
            ...(spool.observation.activeTurnId === undefined
              ? {}
              : { activeTurnId: spool.observation.activeTurnId }),
            ...(spool.observation.pendingRequests.length === 0
              ? {}
              : { inputRequests: spool.observation.pendingRequests }),
            ...(spool.observation.prototypeRef === undefined
              ? {}
              : { prototypeRef: spool.observation.prototypeRef }),
            ...(observedNativeState === undefined
              ? {}
              : { nativeObservationState: observedNativeState }),
            privateApprovalCaptureState: spool.privateApprovalCaptureState,
            ...(spool.observation.prototype === undefined
              ? {}
              : { prototype: spool.observation.prototype }),
            status: spool.observation.status,
            ...(spool.observation.uiPreview === undefined
              ? {}
              : { uiPreview: spool.observation.uiPreview }),
            version: 1,
            ...(spool.observation.workingPreview === undefined
              ? {}
              : { workingPreview: spool.observation.workingPreview }),
          };
          const summary = eveSessionResultSchema.parse({
            cursor: 0,
            events: [],
            ...(metadata.inputRequests === undefined
              ? {}
              : { inputRequests: metadata.inputRequests }),
            ...(metadata.prototypeRef === undefined ? {} : { prototypeRef: metadata.prototypeRef }),
            ...(metadata.prototype === undefined ? {} : { prototype: metadata.prototype }),
            sessionId,
            status: metadata.status,
            ...(metadata.uiPreview === undefined ? {} : { uiPreview: metadata.uiPreview }),
            ...(metadata.workingPreview === undefined
              ? {}
              : { workingPreview: metadata.workingPreview }),
          });
          const stored = await input.store.observeSessionPaged({
            ...(explicitSendOperationId === undefined ? {} : { explicitSendOperationId }),
            ...(summary.uiPreview?.appId === undefined ? {} : { appId: summary.uiPreview.appId }),
            events: orderedEvents,
            expectedCheckpointDigest: session.checkpointDigest,
            metadata,
            nowEpochMs: capturedAtEpochMs,
            principal,
            resumability: ["completed", "failed", "cancelled"].includes(summary.status)
              ? "terminal"
              : "live",
            sessionId,
            stage: stageForResult(summary),
          });
          const result = await resultFromDurableCheckpoint(sessionId, stored, cursor, limit);
          return inputValue.continueWork === false
            ? result
            : continueApprovedWork(sessionId, result);
        }
      } catch (error) {
        if (error instanceof HostedCheckpointObservationConflictError) {
          // The losing spool is discarded by the store and this read's finally.
          // Read the committed owner-scoped winner without replaying its loser.
          const winner = await requireSession(sessionId);
          const result = await resultFromDurableCheckpoint(sessionId, winner, cursor, limit);
          return inputValue.continueWork === false
            ? result
            : continueApprovedWork(sessionId, result);
        }
        if (error instanceof HostedSessionReadTimeoutError) {
          if (session.checkpoint === undefined && session.checkpointRef === undefined) {
            throw error;
          }
          return delayedCheckpointResult(sessionId, session, cursor, limit);
        }
        if (
          inputValue.recoverUnavailable !== false &&
          error instanceof HostedAdapterSessionUnavailableError &&
          session.checkpointRef
        ) {
          const retained = await resultFromDurableCheckpoint(sessionId, session, cursor, limit);
          return retained.status === "working"
            ? eveSessionResultSchema.parse({ ...retained, status: "waiting" })
            : retained;
        }
        throw error;
      } finally {
        if (spool !== undefined) {
          await rm(spool.directory, { force: true, recursive: true });
        }
      }
    }
    try {
      const snapshot = await input.transport.get({
        adapterSessionId: session.adapterSessionId,
        principal,
      });
      const observedAt = now();
      const canPageCheckpoint =
        input.store.observeSessionPaged !== undefined &&
        input.store.readCheckpointPage !== undefined;
      const legacyCheckpoint = canPageCheckpoint
        ? undefined
        : checkpointForSnapshot(sessionId, snapshot, observedAt);
      let resumability: "live" | "terminal" | "checkpoint" = "live";
      if (["completed", "failed", "cancelled"].includes(snapshot.status)) {
        resumability = "terminal";
      } else if (session.resumability === "checkpoint" && snapshot.status === "working") {
        resumability = "checkpoint";
      }
      const observed = await observeSnapshot(
        sessionId,
        snapshot,
        resumability,
        observedAt,
        0,
        explicitSendOperationId,
      );
      const current = toDurableHostedSessionRecord(await requireSession(sessionId));
      const progressUnchanged = canPageCheckpoint
        ? current.checkpointProgressDigest !== undefined &&
          current.checkpointProgressDigest === session.checkpointProgressDigest
        : legacyCheckpoint !== undefined &&
          session.checkpointProgressDigest ===
            hostedSessionCheckpointProgressDigest(legacyCheckpoint);
      const idleCheckpointDue =
        snapshot.status === "working" &&
        progressUnchanged &&
        observedAt >= session.lastProgressAtEpochMs + sessionTimeoutPolicy.idleTimeoutMs;
      if (idleCheckpointDue && canPageCheckpoint) {
        await observeSnapshot(sessionId, snapshot, "checkpoint", observedAt);
        const checkpointed = toDurableHostedSessionRecord(await requireSession(sessionId));
        return resultFromDurableCheckpoint(sessionId, checkpointed, cursor, limit);
      }
      if (idleCheckpointDue && legacyCheckpoint !== undefined) {
        const checkpoint = session.checkpoint ?? legacyCheckpoint;
        const checkpointed = await input.store.observeSession?.({
          ...(session.appId === undefined ? {} : { appId: session.appId }),
          checkpoint,
          nowEpochMs: observedAt,
          principal,
          resumability: "checkpoint",
          sessionId,
          stage: session.stage,
        });
        const retained = checkpointed && toDurableHostedSessionRecord(checkpointed).checkpoint;
        return resultFromHostedCheckpoint(sessionId, retained ?? checkpoint, cursor, limit);
      }
      if (observed.status === "cancelled") {
        const durable = toDurableHostedSessionRecord(await requireSession(sessionId));
        if (durable.checkpoint) {
          const result = resultFromHostedCheckpoint(sessionId, durable.checkpoint, cursor, limit);
          return inputValue.continueWork === false
            ? result
            : await continueApprovedWork(sessionId, result);
        }
        if (durable.checkpointRef !== undefined) {
          const result = await resultFromDurableCheckpoint(sessionId, durable, cursor, limit);
          return inputValue.continueWork === false
            ? result
            : await continueApprovedWork(sessionId, result);
        }
      }
      const result = projectSnapshot(sessionId, snapshot, cursor, limit);
      if (
        result.status !== "working" ||
        !progressUnchanged ||
        observedAt - session.lastProgressAtEpochMs < HOSTED_PROGRESS_NOTICE_MS
      ) {
        return inputValue.continueWork === false
          ? result
          : await continueApprovedWork(sessionId, result);
      }
      const operation = pendingBuilderOperation(publicSnapshotEvents(snapshot));
      const elapsedMinutes = Math.max(
        1,
        Math.floor((observedAt - session.lastProgressAtEpochMs) / 60_000),
      );
      return eveSessionResultSchema.parse({
        ...result,
        error: {
          code: "builder_operation_still_running",
          message: `${operation} has produced no new result for ${elapsedMinutes} minute${elapsedMinutes === 1 ? "" : "s"}. Builder has not reported a failure. Keep this saved session and retry autograph_get with the same session ID and cursor. If this continues beyond the command's expected duration, report the session ID and operation so the Builder operator can inspect or recover the stalled run.`,
        },
      });
    } catch (error) {
      if (error instanceof HostedSessionReadTimeoutError) {
        if (session.checkpoint === undefined && session.checkpointRef === undefined) {
          throw error;
        }
        return delayedCheckpointResult(sessionId, session, cursor, limit);
      }
      if (!(error instanceof HostedAdapterSessionUnavailableError)) {
        throw error;
      }
      if (inputValue.recoverUnavailable === false) {
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

  // eslint-disable-next-line eslint/func-style -- Mutation settlement must observe a new durable checkpoint.
  async function readAcceptedMutation(
    sessionId: string,
    previousCheckpointDigest: string | undefined,
    cursor: number,
    sendDelivery?: SendDelivery,
    sendDiagnostic?: { clientRequestId: string; operationId: string },
  ): Promise<EveSessionResult> {
    let phase: HostedSubmissionPhase = "send_accepted_readback";
    let failureCategory: SendReadFailureCategory = "native_read_failed";
    try {
      const result = await readSession(
        {
          continueWork: false,
          cursor,
          limit: 100,
          sessionId,
        },
        sendDelivery === undefined ? undefined : sendDiagnostic?.operationId,
      );
      const current = toDurableHostedSessionRecord(await requireSession(sessionId));
      if (sendDelivery !== undefined) {
        const proof = await nativeDeliveriesForSession(current);
        const bindingChanged =
          current.adapterSessionId !== sendDelivery.adapterSessionId ||
          current.adapterGeneration !== sendDelivery.adapterGeneration;
        if (bindingChanged || !provesNativeDelivery(sendDelivery, proof)) {
          phase = "send_delivery_boundary";
          failureCategory = "delivery_boundary_unobserved";
          if (bindingChanged) {
            failureCategory = "delivery_binding_changed";
          } else if (result.error?.code === "session_read_delayed") {
            phase = "send_accepted_readback";
            failureCategory = "native_read_delayed";
          }
          throw new HostedSubmissionUnknownError();
        }
        return result;
      }
      if (
        result.error?.code === "session_read_delayed" ||
        current.checkpointDigest === undefined ||
        current.checkpointDigest === previousCheckpointDigest
      ) {
        throw new HostedSubmissionUnknownError();
      }
      return result;
    } catch (error) {
      if (sendDiagnostic !== undefined && sendDelivery !== undefined) {
        reportHostedSubmissionDiagnostic({
          ...sendDiagnostic,
          adapterSessionId: sendDelivery.adapterSessionId,
          error,
          failureCategory,
          operationKind: "send",
          phase,
          sink: input.onSubmissionDiagnostic,
        });
      }
      throw error;
    }
  }

  const observeSettledSend = async (
    sessionId: string,
    cursor: number,
  ): Promise<EveSessionResult> => {
    await assertSendOwner(await requireSession(sessionId));
    const result = await readSession({
      continueWork: false,
      cursor,
      limit: 100,
      recoverUnavailable: false,
      sessionId,
    });
    await assertSendOwner(await requireSession(sessionId));
    return result;
  };

  // eslint-disable-next-line eslint/func-style -- Mutation preflight shares local session-service state.
  const readMutationPreflight = async (sessionId: string) => {
    const before = toDurableHostedSessionRecord(await requireSession(sessionId));
    const result = await readSession({
      continueWork: false,
      cursor: 0,
      limit: 100,
      sessionId,
    });
    const session = toDurableHostedSessionRecord(await requireSession(sessionId));
    const metadata = await readCheckpointMetadata(session);
    if (result.error?.code === "session_read_delayed") {
      throw new HostedSessionRecoveryUnavailableError();
    }
    return {
      activeTurnId: metadata?.activeTurnId,
      nativeObservationState:
        metadata?.coldReadProgress === undefined &&
        metadata?.nativeObservationState?.adapterSessionId === session.adapterSessionId &&
        metadata.nativeObservationState.publicEventCount === session.checkpointRef?.eventCount
          ? metadata.nativeObservationState
          : undefined,
      persisted: session.checkpointDigest !== before.checkpointDigest,
      result,
      session,
    };
  };

  // oxlint-disable-next-line eslint/func-style -- Native response preflight and controller share this hoisted canonical helper.
  async function respondRequest(
    request: Parameters<EveSessionService["respond"]>[0],
    expectedBinding?: Pick<
      InternalSessionLimitResponse,
      "adapterGeneration" | "adapterSessionId" | "batches"
    >,
    stopGuardOnly = false,
  ) {
    requireHostedOperationScope(principal, "respond");
    let session = await requireSession(request.sessionId);
    const retainedState = await privateInputsForSession(session);
    const initial =
      retainedState !== undefined && guardRequestIds(retainedState).length > 0
        ? await readMutationPreflight(request.sessionId)
        : undefined;
    if (initial !== undefined) {
      ({ session } = initial);
    }
    const state = initial === undefined ? retainedState : await privateInputsForSession(session);
    const guardIds = state === undefined ? [] : guardRequestIds(state);
    if (
      expectedBinding !== undefined &&
      (session.adapterSessionId !== expectedBinding.adapterSessionId ||
        toDurableHostedSessionRecord(session).adapterGeneration !==
          expectedBinding.adapterGeneration ||
        state === undefined ||
        digest(stopGuardOnly ? frameworkGuardBatches(state) : state.pending) !==
          digest(expectedBinding.batches))
    ) {
      throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
    }
    let { responses } = request;
    let marker: InternalSessionLimitResponse | undefined;
    if (state !== undefined && guardIds.length > 0) {
      await assertSessionLimitOwner(session);
      if (initial === undefined) {
        throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
      }
      assertCompletePrivateBatch(state, initial.result);
      if (
        initial.result.inputRequests?.some((pending) => pending.kind === "authorization") === true
      ) {
        throw new SubmissionRejectedBeforeDispatchError("authorization_required");
      }
      // Already explicit native guard responses remain compatible; normal public replies omit them.
      if (
        !stopGuardOnly &&
        !guardIds.every((id) => responses.some((response) => response.requestId === id))
      ) {
        responses = mergeSessionLimitResponses(state, responses);
      }
      if (
        stopGuardOnly ||
        guardIds.every((id) =>
          responses.some(
            (entry) =>
              entry.requestId === id &&
              entry.response.kind === "answer" &&
              entry.response.optionId === "continue",
          ),
        )
      ) {
        marker = internalSessionLimitResponseSchema.parse({
          adapterGeneration: toDurableHostedSessionRecord(session).adapterGeneration,
          adapterSessionId: session.adapterSessionId,
          batches: stopGuardOnly ? frameworkGuardBatches(state) : state.pending,
          decision: stopGuardOnly ? "stop" : "continue",
          ...(stopGuardOnly &&
          toDurableHostedSessionRecord(session).privateBuildDecision !== undefined
            ? {
                stoppedBuildTurnId:
                  toDurableHostedSessionRecord(session).privateBuildDecision?.turnId,
              }
            : {}),
          responses: nativeResponses(responses),
        });
      }
    }
    // Preserve original resource approval authority before dispatch when the full private batch is available.
    const approvalRequest = resourceApprovalResponseProofSchema.shape.request.safeParse(request);
    const approvalMetadata =
      marker === undefined && approvalRequest.success && (state?.pending.length ?? 0) > 0
        ? await readCheckpointMetadata(session)
        : null;
    const resourceApprovalResponse =
      marker === undefined && approvalRequest.success
        ? captureResourceApprovalResponse(
            toDurableHostedSessionRecord(session),
            state,
            approvalMetadata?.privateApprovalCaptureState,
            approvalRequest.data,
          )
        : undefined;
    return mutate({
      ...(resourceApprovalResponse === undefined ? {} : { resourceApprovalResponse }),
      ...(marker === undefined ? {} : { internalSessionLimitResponse: marker }),
      async dispatch(operationId) {
        const paged =
          input.transport.observe !== undefined &&
          input.transport.respondAccepted !== undefined &&
          input.store.observeSessionPaged !== undefined &&
          input.store.readCheckpointPage !== undefined;
        const preflight = paged ? await readMutationPreflight(request.sessionId) : undefined;
        if (preflight) {
          ({ session } = preflight);
        }
        if (marker !== undefined) {
          const current = toDurableHostedSessionRecord(session);
          const actual = await privateInputsForSession(session);
          if (
            current.adapterSessionId !== marker.adapterSessionId ||
            current.adapterGeneration !== marker.adapterGeneration ||
            actual === undefined ||
            !matchesReservedGuardResponse(actual, marker, responses)
          ) {
            throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
          }
          await assertSessionLimitOwner(session);
        }
        const before = preflight?.persisted
          ? undefined
          : await input.transport.get({
              adapterSessionId: session.adapterSessionId,
              principal,
            });
        if (
          marker !== undefined &&
          before !== undefined &&
          (before.privateInputState === undefined ||
            !matchesReservedGuardResponse(before.privateInputState, marker, responses))
        ) {
          throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
        }
        const pendingRequests = preflight?.persisted
          ? (preflight?.result.inputRequests ?? [])
          : outstandingInternalEveRequests(
              (before?.events ?? []).filter(
                (event): event is InternalEveEvent => event !== null && typeof event === "object",
              ),
            );
        const expected =
          stopGuardOnly && marker !== undefined
            ? marker.responses.map((response) => response.requestId)
            : pendingRequests.flatMap((pending) =>
                pending.kind === "authorization" ? [] : [pending.requestId],
              );
        if (
          expected.length !== responses.length ||
          expected.some((requestId, index) => responses[index]?.requestId !== requestId)
        ) {
          throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
        }
        const responseCursor =
          before === undefined ? mutationEventCursor(session) : publicSnapshotEventCount(before);
        const responseInput = {
          adapterSessionId: session.adapterSessionId,
          ...(marker === undefined ? {} : { internalSessionLimitResponse: marker }),
          ...(preflight?.nativeObservationState === undefined
            ? {}
            : {
                nativeObservationState: preflight.nativeObservationState,
              }),
          operationId,
          principal,
          responses,
          ...(session.version === 2 && session.sourceHandoffId
            ? { sourceHandoffId: session.sourceHandoffId }
            : {}),
        };
        if (preflight?.persisted) {
          await input.transport.respondAccepted?.(responseInput);
          const result = await readAcceptedMutation(
            request.sessionId,
            session.version === 2 ? session.checkpointDigest : undefined,
            responseCursor,
          );
          const actual = await privateInputsForSession(await requireSession(request.sessionId));
          if (
            marker?.decision === "stop" &&
            (actual === undefined || !provesSessionLimitResponse(marker, actual))
          ) {
            throw new HostedSubmissionUnknownError();
          }
          return { result };
        }
        const snapshot = await input.transport.respond(responseInput);
        const result = await observeSnapshot(
          request.sessionId,
          snapshot,
          undefined,
          undefined,
          responseCursor,
        );
        if (
          marker?.decision === "stop" &&
          (snapshot.privateInputState === undefined ||
            !provesSessionLimitResponse(marker, snapshot.privateInputState))
        ) {
          throw new HostedSubmissionUnknownError();
        }
        return { result };
      },
      kind: "respond",
      request,
      sessionId: request.sessionId,
    });
  }

  // oxlint-disable-next-line eslint/func-style -- Cancel uses the same canonical RESPOND journal without answering other requests.
  async function stopParkedSessionLimitGuard(
    sessionId: string,
    turnId: string | undefined,
    preflight: Awaited<ReturnType<typeof readMutationPreflight>>,
  ): Promise<EveSessionResult | undefined> {
    const { session } = preflight;
    const state = await privateInputsForSession(session);
    if (state === undefined) {
      return undefined;
    }
    const batches = frameworkGuardBatches(state);
    const [batch] = batches;
    if (batch === undefined) {
      return undefined;
    }
    if (turnId !== undefined && batches.some((entry) => entry.turnId !== turnId)) {
      throw new SubmissionRejectedBeforeDispatchError("turn_changed");
    }
    if (
      batches.some((entry) => entry.requests.some((request) => !request.optionIds.includes("stop")))
    ) {
      throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
    }
    await assertSessionLimitOwner(session);
    assertCompletePrivateBatch(state, preflight.result);
    return await respondRequest(
      {
        clientRequestId: guardClientRequestId(session, batch, "stop"),
        responses: batches.flatMap((entry) =>
          entry.requests.map((request) => ({
            requestId: request.requestId,
            response: { kind: "answer", optionId: "stop", value: "stop" },
          })),
        ),
        sessionId,
      },
      {
        adapterGeneration: toDurableHostedSessionRecord(session).adapterGeneration,
        adapterSessionId: session.adapterSessionId,
        batches,
      },
      true,
    );
  }

  const service = {
    async bindStartAlias(request) {
      requireHostedOperationScope(principal, "start");
      if (request.clientRequestId === request.canonicalClientRequestId) {
        return;
      }
      const timestamp = now();
      const candidate = hostedOperationRecordSchema.parse({
        clientRequestId: request.clientRequestId,
        createdAtEpochMs: timestamp,
        kind: "start",
        operationId: stableId("op", {
          clientRequestId: request.clientRequestId,
          kind: "start",
          tenant: [
            principal.issuer,
            principal.audience,
            principal.workspaceId,
            principal.ownerUserId,
          ],
        }),
        principal,
        requestDigest: digest(
          Object.fromEntries([
            ["kind", "start"],
            [
              "request",
              { clientRequestId: request.clientRequestId, handoffId: request.sourceHandoffId },
            ],
            ["sessionId", undefined],
          ]),
        ),
        startAlias: {
          canonicalClientRequestId: request.canonicalClientRequestId,
          sourceHandoffId: request.sourceHandoffId,
        },
        state: "reserved",
        updatedAtEpochMs: timestamp,
        version: 1,
      });
      const reservation = reserveOperationResultSchema.parse(
        await input.store.reserveOperation(principal, candidate),
      );
      if (reservation.disposition !== "reserved" && reservation.disposition !== "existing") {
        throw new HostedIdempotencyConflictError();
      }
    },
    async cancel({ sessionId, turnId }) {
      requireHostedOperationScope(principal, "cancel");
      let session = await requireSession(sessionId);
      if (input.store.recordCancellationIntent !== undefined) {
        session = await input.store.recordCancellationIntent({
          principal,
          sessionId,
          nowEpochMs: now(),
        });
      }
      const paged =
        input.transport.observe !== undefined &&
        input.transport.cancelAccepted !== undefined &&
        input.store.observeSessionPaged !== undefined &&
        input.store.readCheckpointPage !== undefined;
      let snapshot: HostedEngineSnapshot;
      try {
        const retainedInputs = await privateInputsForSession(session);
        const preflight =
          paged ||
          session.status === "input_required" ||
          (retainedInputs !== undefined && guardRequestIds(retainedInputs).length > 0)
            ? await readMutationPreflight(sessionId)
            : undefined;
        if (!paged && preflight !== undefined && preflight.activeTurnId === undefined) {
          const stopped = await stopParkedSessionLimitGuard(sessionId, turnId, preflight);
          if (stopped !== undefined) {
            return stopped;
          }
        }
        if (preflight && (preflight.persisted || preflight.nativeObservationState !== undefined)) {
          ({ session } = preflight);
          if (preflight.activeTurnId === undefined) {
            const stopped = await stopParkedSessionLimitGuard(sessionId, turnId, preflight);
            if (stopped !== undefined) {
              return stopped;
            }
            if (turnId !== undefined) {
              throw new SubmissionRejectedBeforeDispatchError("no_active_turn");
            }
            const observedAt = now();
            const settledCount = await input.store.settleIdleReservations?.({
              beforeEpochMs: observedAt - HOSTED_IDLE_RESERVATION_GRACE_MS,
              nowEpochMs: observedAt,
              principal,
              sessionId,
            });
            const result = await readSession({
              continueWork: false,
              cursor: 0,
              limit: 100,
              sessionId,
            });
            return settledCount
              ? eveSessionResultSchema.parse({
                  ...result,
                  error: {
                    code: "idle_continuation_recovered",
                    message: `Builder found no active turn and released ${settledCount} old unfinished continuation${settledCount === 1 ? "" : "s"}. Their outcomes remain unknown. Review the current app and PR state before sending a new continuation.`,
                  },
                })
              : result;
          }
          await input.transport.cancelAccepted?.({
            adapterSessionId: session.adapterSessionId,
            nativeObservationState: preflight.nativeObservationState,
            principal,
            ...(turnId === undefined ? {} : { turnId }),
          });
          return readAcceptedMutation(sessionId, session.checkpointDigest, 0);
        }
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
    async getStart({ clientRequestId, cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      if (input.store.getStartOperation === undefined) {
        throw new HostedSubmissionUnknownError();
      }
      const stored = (await readStartOperation(clientRequestId, "start_lookup")) ?? null;
      if (stored === null) {
        return {
          cursor: 0,
          error: {
            code: "start_request_not_found",
            message:
              "No start result is saved for this account and clientRequestId. Check the original request ID and signed-in account. If they are correct, retry autograph_start with exactly the original ID and input.",
          },
          events: [],
          sessionId: "",
          status: "failed" as const,
        };
      }
      let operation = hostedOperationRecordSchema.parse(stored);
      if (
        (operation.kind !== "start" && operation.kind !== "resume") ||
        operation.clientRequestId !== clientRequestId ||
        tenantKeyFor(operation.principal) !== tenantKeyFor(principal)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      const { startAlias } = operation;
      if (startAlias !== undefined && operation.state !== "succeeded") {
        const canonicalStart = await readStartOperation(
          startAlias.canonicalClientRequestId,
          "start_alias_lookup",
        );
        if (canonicalStart === null || canonicalStart === undefined) {
          throw new HostedSubmissionUnknownError();
        }
        operation = hostedOperationRecordSchema.parse(canonicalStart);
        if (
          operation.kind !== "start" ||
          operation.clientRequestId !== startAlias.canonicalClientRequestId ||
          operation.startAlias !== undefined ||
          tenantKeyFor(operation.principal) !== tenantKeyFor(principal)
        ) {
          throw new HostedSubmissionUnknownError();
        }
      }
      if (operation.state === "rejected") {
        throw new HostedRejectedOperationError(operation.safeErrorCode);
      }
      if (operation.state !== "succeeded") {
        reportHostedSubmissionDiagnostic({
          clientRequestId,
          operationId: operation.operationId,
          operationKind: operation.kind,
          phase: "recovery",
          savedState: operation.state,
          sink: input.onSubmissionDiagnostic,
        });
        throw new HostedSubmissionUnknownError();
      }
      const session =
        operation.kind === "start"
          ? await requireBoundSucceededStartSession(operation)
          : await requireSession(operation.sessionId);
      if (
        startAlias !== undefined &&
        (session.version !== 2 || session.sourceHandoffId !== startAlias.sourceHandoffId)
      ) {
        throw new HostedSubmissionUnknownError();
      }
      return readSession({ cursor, limit, sessionId: session.sessionId });
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
    respond: respondRequest,
    async send({ observationCursor, ...request }) {
      requireHostedOperationScope(principal, "send");
      let session = await requireSession(request.sessionId);
      const initialBinding = toDurableHostedSessionRecord(session);
      const resumeCancellationRevision =
        session.status === "cancelled" && input.store.recordCancellationIntent !== undefined
          ? (initialBinding.cancellationRevision ?? 0)
          : undefined;
      const settledResult = await mutate({
        async dispatch(operationId) {
          const paged =
            input.transport.observe !== undefined &&
            input.transport.sendAccepted !== undefined &&
            input.store.observeSessionPaged !== undefined &&
            input.store.readCheckpointPage !== undefined;
          let preflight: Awaited<ReturnType<typeof readMutationPreflight>> | undefined;
          if (paged) {
            try {
              preflight = await readMutationPreflight(request.sessionId);
              ({ session } = preflight);
            } catch {
              // This read precedes both mutation paths. No message POST has run.
              throw new SubmissionRejectedBeforeDispatchError("send_preflight_unavailable");
            }
          }
          if (input.store.recordSendDelivery === undefined) {
            throw new SubmissionRejectedBeforeDispatchError("send_delivery_store_unavailable");
          }
          try {
            await assertSendOwner(session);
          } catch {
            throw new SubmissionRejectedBeforeDispatchError("send_owner_unavailable");
          }
          const binding = toDurableHostedSessionRecord(session);
          if (
            resumeCancellationRevision !== undefined &&
            (binding.adapterSessionId !== initialBinding.adapterSessionId ||
              binding.adapterGeneration !== initialBinding.adapterGeneration)
          ) {
            throw new SubmissionRejectedBeforeDispatchError("send_owner_unavailable");
          }
          // Snapshot transports need a fresh native tail; accepted transports already persisted preflight.
          let responseCursor = mutationEventCursor(session);
          if (!preflight?.persisted) {
            let before: HostedEngineSnapshot;
            try {
              before = await input.transport.get({
                adapterSessionId: session.adapterSessionId,
                principal,
              });
            } catch {
              throw new SubmissionRejectedBeforeDispatchError("send_preflight_unavailable");
            }
            responseCursor = publicSnapshotEventCount(before);
          }
          const requestDigest = digest({ kind: "send", request, sessionId: request.sessionId });
          let sendDelivery: SendDelivery | undefined;
          const sendInput = {
            adapterSessionId: session.adapterSessionId,
            message: request.message,
            onAccepted: async (deliveryId: string) => {
              const marker: SendDelivery = {
                ...(resumeCancellationRevision === undefined ? {} : { resumeCancellationRevision }),
                adapterGeneration: binding.adapterGeneration,
                adapterSessionId: binding.adapterSessionId,
                deliveryId,
                requestDigest,
                sessionId: request.sessionId,
              };
              const recorded = await input.store.recordSendDelivery?.({
                delivery: marker,
                nowEpochMs: now(),
                operationId,
                principal,
              });
              const verified = requireOwnedOperation(recorded, {
                clientRequestId: request.clientRequestId,
                kind: "send",
                operationId,
                requestDigest,
                sessionId: request.sessionId,
              });
              if (
                verified.sendDelivery === undefined ||
                digest(verified.sendDelivery) !== digest(marker)
              ) {
                throw new HostedSubmissionUnknownError();
              }
              sendDelivery = marker;
            },
            operationId,
            principal,
            ...(session.version === 2 && session.sourceHandoffId
              ? { sourceHandoffId: session.sourceHandoffId }
              : {}),
          };
          if (preflight?.persisted) {
            await input.transport.sendAccepted?.(sendInput);
            if (sendDelivery === undefined) {
              throw new HostedSubmissionUnknownError();
            }
            const result = await readAcceptedMutation(
              request.sessionId,
              session.version === 2 ? session.checkpointDigest : undefined,
              responseCursor,
              sendDelivery,
              { clientRequestId: request.clientRequestId, operationId },
            );
            return {
              result,
              sendDeliveryResolution: await nativeDeliveriesForSession(
                await requireSession(request.sessionId),
              ),
            };
          }
          const snapshot = await input.transport.send(sendInput);
          const result = await observeSnapshot(
            request.sessionId,
            snapshot,
            undefined,
            undefined,
            responseCursor,
            operationId,
          );
          // oxlint-disable-next-line react-doctor/server-sequential-independent-await -- Ownership must be re-read after the preceding native snapshot was durably observed.
          const current = await requireSession(request.sessionId);
          const proof = snapshot.nativeDeliveryState;
          if (
            sendDelivery === undefined ||
            current.adapterSessionId !== sendDelivery.adapterSessionId ||
            toDurableHostedSessionRecord(current).adapterGeneration !==
              sendDelivery.adapterGeneration ||
            !provesNativeDelivery(sendDelivery, proof)
          ) {
            if (sendDelivery !== undefined) {
              reportHostedSubmissionDiagnostic({
                adapterSessionId: sendDelivery.adapterSessionId,
                clientRequestId: request.clientRequestId,
                failureCategory:
                  current.adapterSessionId !== sendDelivery.adapterSessionId ||
                  toDurableHostedSessionRecord(current).adapterGeneration !==
                    sendDelivery.adapterGeneration
                    ? "delivery_binding_changed"
                    : "delivery_boundary_unobserved",
                operationId,
                operationKind: "send",
                phase: "send_delivery_boundary",
                sink: input.onSubmissionDiagnostic,
              });
            }
            throw new HostedSubmissionUnknownError();
          }
          await assertSendOwner(current);
          return { result, sendDeliveryResolution: proof };
        },
        kind: "send",
        request,
        sessionId: request.sessionId,
      });
      return observationCursor === undefined
        ? settledResult
        : await observeSettledSend(request.sessionId, observationCursor);
    },
    async settleStartAlias(request) {
      requireHostedOperationScope(principal, "start");
      if (request.clientRequestId === request.canonicalClientRequestId) {
        return;
      }
      if (input.store.settleStartAlias === undefined) {
        throw new HostedSubmissionUnknownError();
      }
      await input.store.settleStartAlias({ ...request, principal });
    },

    async start(request) {
      requireHostedOperationScope(principal, "start");
      const prior = await readStartOperation(request.clientRequestId, "start_lookup");
      if (prior !== undefined && prior !== null) {
        const operation = hostedOperationRecordSchema.parse(prior);
        const expectedDigest = digest(
          Object.fromEntries([
            ["kind", operation.kind],
            ["request", request],
            ["sessionId", operation.kind === "resume" ? request.resumeSessionId : undefined],
          ]),
        );
        if (
          (operation.kind !== "start" && operation.kind !== "resume") ||
          operation.clientRequestId !== request.clientRequestId ||
          tenantKeyFor(operation.principal) !== tenantKeyFor(principal) ||
          operation.requestDigest !== expectedDigest
        ) {
          throw new HostedIdempotencyConflictError();
        }
        if (operation.state === "succeeded") {
          await (operation.kind === "start"
            ? requireBoundSucceededStartSession(operation)
            : requireSession(operation.sessionId));
          return operation.result;
        }
      }
      if (request.resumeSessionId !== undefined) {
        const stored = await requireSession(request.resumeSessionId);
        let existing = toDurableHostedSessionRecord(stored);
        if (stored.version === 1 && ["completed", "failed", "cancelled"].includes(stored.status)) {
          try {
            await readSession({ cursor: 0, limit: 100, sessionId: stored.sessionId });
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
          if (existing.checkpoint === undefined && existing.checkpointRef === undefined) {
            throw new HostedSessionRecoveryUnavailableError();
          }
          return mutate({
            async dispatch(operationId) {
              const response = await input.transport.start({
                operationId,
                principal,
                prompt: await recoveryPrompt({ principal, record: existing, store: input.store }),
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
              const sessionBase: HostedPagedSessionBase = {
                adapterGeneration: 1,
                adapterSessionId: response.adapterSessionId,
                ...(result.uiPreview?.appId === undefined && existing.appId === undefined
                  ? {}
                  : { appId: result.uiPreview?.appId ?? existing.appId }),
                createdAtEpochMs: timestamp,
                lastProgressAtEpochMs: timestamp,
                originAdapterSessionId: response.adapterSessionId,
                parentSessionId: existing.sessionId,
                principal,
                resumability: ["completed", "failed", "cancelled"].includes(result.status)
                  ? "terminal"
                  : "live",
                sessionId,
                ...(existing.sourceHandoffId ? { sourceHandoffId: existing.sourceHandoffId } : {}),
                stage: stageForResult(result),
                status: result.status,
                title: existing.title,
                updatedAtEpochMs: timestamp,
                version: 2,
              };
              if (
                input.store.settleSucceededPaged !== undefined &&
                input.store.readCheckpointPage !== undefined
              ) {
                const spool = await spoolSnapshotEvents(response.snapshot);
                return {
                  newSessionPaged: {
                    cleanup: () => rm(spool.directory, { force: true, recursive: true }),
                    events: readSpoolEvents(spool),
                    metadata: checkpointMetadataForSnapshot(response.snapshot, timestamp),
                    session: sessionBase,
                  },
                  result,
                };
              }
              const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
              const { appId: existingAppId } = existing;
              const { appId: implementationAppId } = result.uiPreview ?? {};
              const appId = implementationAppId ?? existingAppId;
              return {
                newSession: durableHostedSessionRecordSchema.parse({
                  ...sessionBase,
                  ...(appId === undefined ? {} : { appId }),
                  checkpoint,
                  checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
                  checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
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
            const result = await readSession({
              cursor: 0,
              limit: 100,
              recoverUnavailable: false,
              sessionId: existing.sessionId,
            });
            if (input.store.bindExistingStart === undefined) {
              throw new HostedSubmissionUnknownError();
            }
            const boundSession = await requireSession(existing.sessionId);
            const timestamp = now();
            const candidate = hostedOperationRecordSchema.parse({
              clientRequestId: request.clientRequestId,
              createdAtEpochMs: timestamp,
              kind: "start",
              operationId: stableId("op", {
                clientRequestId: request.clientRequestId,
                kind: "start",
                tenant: [
                  principal.issuer,
                  principal.audience,
                  principal.workspaceId,
                  principal.ownerUserId,
                ],
              }),
              principal,
              requestDigest: digest(
                Object.fromEntries([
                  ["kind", "start"],
                  ["request", request],
                  ["sessionId", undefined],
                ]),
              ),
              result,
              sessionId: existing.sessionId,
              sessionRecordDigest: hostedSessionCreationDigest(boundSession),
              state: "succeeded",
              updatedAtEpochMs: timestamp,
              version: 1,
            });
            await input.store.bindExistingStart(principal, candidate);
            return result;
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError)) {
              throw error;
            }
          }
        }
        if (
          (existing.checkpoint === undefined && existing.checkpointRef === undefined) ||
          existing.checkpointDigest === undefined ||
          (input.store.replaceSessionAdapter === undefined &&
            input.store.replaceSessionAdapterPaged === undefined)
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        const { replaceSessionAdapter } = input.store;
        if (
          replaceSessionAdapter === undefined &&
          input.store.replaceSessionAdapterPaged === undefined
        ) {
          throw new HostedSessionRecoveryUnavailableError();
        }
        return mutate({
          async dispatch(operationId) {
            const response = await input.transport.start({
              operationId,
              principal,
              prompt: await recoveryPrompt({ principal, record: existing, store: input.store }),
              ...(existing.sourceHandoffId ? { sourceHandoffId: existing.sourceHandoffId } : {}),
            });
            if (
              input.transport.observeStarted !== undefined &&
              input.store.replaceSessionAdapterPaged !== undefined &&
              input.store.readCheckpointPage !== undefined
            ) {
              const spool = await spoolObservedSession({
                adapterSessionId: response.adapterSessionId,
                principal,
                sessionId: existing.sessionId,
                store: input.store,
                transport: input.transport.observeStarted,
              });
              try {
                if (
                  !spool.observation.artifactProjectionRequiresLegacyReadback ||
                  spool.observation.prototype !== undefined ||
                  spool.observation.prototypeRef !== undefined
                ) {
                  const timestamp = now();
                  const metadata: HostedPagedCheckpointMetadata = {
                    capturedAtEpochMs: timestamp,
                    ...(spool.observation.pendingRequests.length === 0
                      ? {}
                      : { inputRequests: spool.observation.pendingRequests }),
                    ...(spool.observation.prototype === undefined
                      ? {}
                      : { prototype: spool.observation.prototype }),
                    ...(spool.observation.prototypeRef === undefined
                      ? {}
                      : { prototypeRef: spool.observation.prototypeRef }),
                    status: spool.observation.status,
                    ...(spool.observation.uiPreview === undefined
                      ? {}
                      : { uiPreview: spool.observation.uiPreview }),
                    version: 1,
                    ...(spool.observation.workingPreview === undefined
                      ? {}
                      : { workingPreview: spool.observation.workingPreview }),
                  };
                  const summary = eveSessionResultSchema.parse({
                    cursor: 0,
                    events: [],
                    ...(metadata.inputRequests === undefined
                      ? {}
                      : { inputRequests: metadata.inputRequests }),
                    ...(metadata.prototype === undefined ? {} : { prototype: metadata.prototype }),
                    ...(metadata.prototypeRef === undefined
                      ? {}
                      : { prototypeRef: metadata.prototypeRef }),
                    sessionId: existing.sessionId,
                    status: metadata.status,
                    ...(metadata.uiPreview === undefined ? {} : { uiPreview: metadata.uiPreview }),
                    ...(metadata.workingPreview === undefined
                      ? {}
                      : { workingPreview: metadata.workingPreview }),
                  });
                  const replaced = await input.store.replaceSessionAdapterPaged({
                    adapterSessionId: response.adapterSessionId,
                    ...(summary.uiPreview?.appId === undefined
                      ? {}
                      : { appId: summary.uiPreview.appId }),
                    events: readSpoolEvents(spool),
                    expectedAdapterGeneration: existing.adapterGeneration,
                    expectedCheckpointDigest: existing.checkpointDigest,
                    metadata,
                    nowEpochMs: timestamp,
                    principal,
                    resumability: ["completed", "failed", "cancelled"].includes(summary.status)
                      ? "terminal"
                      : "live",
                    sessionId: existing.sessionId,
                    stage: stageForResult(summary),
                  });
                  const durable = toDurableHostedSessionRecord(replaced);
                  if (
                    durable.adapterSessionId !== response.adapterSessionId ||
                    durable.adapterGeneration !== existing.adapterGeneration + 1 ||
                    durable.checkpointRef === undefined
                  ) {
                    throw new HostedSubmissionUnknownError();
                  }
                  return {
                    result: await resultFromDurableCheckpoint(existing.sessionId, replaced, 0, 100),
                  };
                }
              } finally {
                await rm(spool.directory, { force: true, recursive: true });
              }
            }
            const result = projectSnapshot(existing.sessionId, response.snapshot);
            const timestamp = now();
            if (
              input.store.replaceSessionAdapterPaged !== undefined &&
              input.store.readCheckpointPage !== undefined
            ) {
              let truncatedBeforeIndex = existing.checkpoint?.truncatedBeforeIndex;
              if (existing.checkpointRef !== undefined) {
                const priorPage = await input.store.readCheckpointPage({
                  checkpointRef: existing.checkpointRef,
                  cursor: 0,
                  limit: 1,
                  principal,
                  sessionId: existing.sessionId,
                });
                ({ truncatedBeforeIndex } = priorPage.metadata);
              }
              const metadata = checkpointMetadataForSnapshot(
                response.snapshot,
                timestamp,
                truncatedBeforeIndex,
              );
              const spool = await spoolSnapshotEvents(response.snapshot);
              try {
                const replaced = await input.store.replaceSessionAdapterPaged({
                  adapterSessionId: response.adapterSessionId,
                  ...(result.uiPreview?.appId === undefined
                    ? {}
                    : { appId: result.uiPreview.appId }),
                  events: readSpoolEvents(spool),
                  expectedAdapterGeneration: existing.adapterGeneration,
                  expectedCheckpointDigest: existing.checkpointDigest,
                  metadata,
                  nowEpochMs: timestamp,
                  principal,
                  resumability: ["completed", "failed", "cancelled"].includes(result.status)
                    ? "terminal"
                    : "live",
                  sessionId: existing.sessionId,
                  stage: stageForResult(result),
                });
                const durable = toDurableHostedSessionRecord(replaced);
                if (
                  durable.adapterSessionId !== response.adapterSessionId ||
                  durable.adapterGeneration !== existing.adapterGeneration + 1 ||
                  durable.checkpointRef === undefined
                ) {
                  throw new HostedSubmissionUnknownError();
                }
                return {
                  result: await resultFromDurableCheckpoint(existing.sessionId, replaced, 0, 100),
                };
              } finally {
                await rm(spool.directory, { force: true, recursive: true });
              }
            }
            if (replaceSessionAdapter === undefined) {
              throw new HostedSessionRecoveryUnavailableError();
            }
            const checkpoint = checkpointForSnapshot(
              existing.sessionId,
              response.snapshot,
              timestamp,
            );
            const replaced = hostedSessionRecordSchema.parse(
              await replaceSessionAdapter.call(input.store, {
                adapterSessionId: response.adapterSessionId,
                ...(result.uiPreview?.appId === undefined ? {} : { appId: result.uiPreview.appId }),
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
          const sessionBase: HostedPagedSessionBase = {
            adapterGeneration: 1,
            adapterSessionId: response.adapterSessionId,
            ...(result.uiPreview?.appId === undefined ? {} : { appId: result.uiPreview.appId }),
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
          };
          if (
            input.store.settleSucceededPaged !== undefined &&
            input.store.readCheckpointPage !== undefined
          ) {
            const spool = await spoolSnapshotEvents(response.snapshot);
            return {
              newSessionPaged: {
                cleanup: () => rm(spool.directory, { force: true, recursive: true }),
                events: readSpoolEvents(spool),
                metadata: checkpointMetadataForSnapshot(response.snapshot, timestamp),
                session: sessionBase,
              },
              result,
            };
          }
          const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
          return {
            newSession: durableHostedSessionRecordSchema.parse({
              ...sessionBase,
              checkpoint,
              checkpointDigest: hostedSessionCheckpointDigest(checkpoint),
              checkpointProgressDigest: hostedSessionCheckpointProgressDigest(checkpoint),
            }),
            result,
          };
        },
        kind: "start",
        request,
      });
    },
  } satisfies EveSessionService;
  const present = (result: EveSessionResult): EveSessionResult =>
    presentSessionLimitState(result, presentationInputs.get(result.sessionId));
  // Keep canonical mutation/preflight results complete privately; sanitize every public result.
  return {
    ...service,
    cancel: async (request) => present(await service.cancel(request)),
    get: async (request) => present(await service.get(request)),
    getStart: async (request) => present(await service.getStart(request)),
    recoverStart: async (request) => present(await service.recoverStart(request)),
    respond: async (request) => present(await service.respond(request)),
    send: async (request) => present(await service.send(request)),
    start: async (request) => present(await service.start(request)),
  };
}

export { projectHostedSnapshot as hostedEveProjectionForTesting } from "./hosted-projection";
