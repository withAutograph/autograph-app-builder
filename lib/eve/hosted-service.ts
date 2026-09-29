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

const projectSnapshot = projectHostedSnapshot;
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
    onEvent: (event: InternalEveEvent) => Promise<void> | void;
  }) => Promise<{
    activeTurnId?: string;
    artifactProjectionRequiresLegacyReadback: boolean;
    installedEventCount: number;
    pendingRequests: PublicInputRequest[];
    prototype?: z.infer<typeof publicPrototypeSchema>;
    prototypeRef?: PublicPrototypeReference;
    publicEventCount: number;
    status: HostedEngineSnapshot["status"];
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
    sourceHandoffId?: string;
  }) => Promise<HostedEngineSnapshot>;
  /** Resolves after Eve accepts the message, without exporting its complete history. */
  sendAccepted?: (input: Parameters<HostedEveTransport["send"]>[0]) => Promise<void>;
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
  /** Resolves after Eve accepts and verifies settlement of the response batch. */
  respondAccepted?: (input: Parameters<HostedEveTransport["respond"]>[0]) => Promise<void>;
  cancel: (input: {
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

interface PagedObservationSpool {
  directory: string;
  path: string;
  eventCount: number;
  digest: string;
  observation: Awaited<ReturnType<NonNullable<HostedEveTransport["observe"]>>>;
}

// eslint-disable-next-line eslint/func-style -- The spool is consumed only after Eve's durable tail is verified.
async function spoolObservedSession(input: {
  transport: NonNullable<HostedEveTransport["observe"]>;
  principal: HostedPrincipal;
  sessionId: string;
  adapterSessionId: string;
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
  let file: Awaited<ReturnType<typeof open>> | null = null;
  try {
    file = await open(path, "wx", 0o600);
    const handle = file;
    const hash = createHash("sha256");
    let eventCount = 0;
    const observation = await input.transport({
      adapterSessionId: input.adapterSessionId,
      onEvent: async (candidate) => {
        const projected = toPublicEvent(candidate);
        if (projected === null) {
          return;
        }
        const parsed = publicEveEventSchema.safeParse({ ...projected, index: eventCount });
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
      observation,
      path,
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
async function* readSpoolEvents(spool: PagedObservationSpool) {
  const hash = createHash("sha256");
  let count = 0;
  const lines = createInterface({ crlfDelay: Infinity, input: createReadStream(spool.path) });
  try {
    for await (const line of lines) {
      hash.update(`${line}\n`);
      const event = publicEveEventSchema.parse(JSON.parse(line));
      if (event.index !== count) {
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
    let recoveringStart = false;
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

    let dispatched: {
      result: EveSessionResult;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
    };
    try {
      dispatched = await options.dispatch(operationId);
    } catch (error) {
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
        } catch {
          // The durable outcome is still unknown.
        }
      }
      // Eve may have accepted the mutation even if durable settlement failed.
      // Mutations other than start remain non-replayable. If the transaction
      // committed and only its response was lost, exact retry reads the result.
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
      ...(completeResult.uiPreview?.appId === undefined
        ? {}
        : { appId: completeResult.uiPreview.appId }),
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
  async function readSession(inputValue: {
    sessionId: string;
    cursor: number;
    limit: number;
    recoverUnavailable?: boolean;
  }) {
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
        spool = await spoolObservedSession({
          adapterSessionId: session.adapterSessionId,
          principal,
          sessionId,
          transport: input.transport.observe,
        });
        if (
          !spool.observation.artifactProjectionRequiresLegacyReadback ||
          spool.observation.prototype !== undefined ||
          spool.observation.prototypeRef !== undefined
        ) {
          const capturedAtEpochMs = now();
          const metadata: HostedPagedCheckpointMetadata = {
            capturedAtEpochMs,
            ...(spool.observation.pendingRequests.length === 0
              ? {}
              : { inputRequests: spool.observation.pendingRequests }),
            ...(spool.observation.prototypeRef === undefined
              ? {}
              : { prototypeRef: spool.observation.prototypeRef }),
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
            ...(summary.uiPreview?.appId === undefined ? {} : { appId: summary.uiPreview.appId }),
            events: readSpoolEvents(spool),
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
          return resultFromDurableCheckpoint(sessionId, stored, cursor, limit);
        }
      } catch (error) {
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
      const result = projectSnapshot(sessionId, snapshot, cursor, limit);
      if (
        result.status !== "working" ||
        session.checkpointProgressDigest !==
          hostedSessionCheckpointProgressDigest(observedCheckpoint) ||
        observedAt - session.lastProgressAtEpochMs < HOSTED_PROGRESS_NOTICE_MS
      ) {
        return result;
      }
      const recentEvents = snapshot.events.slice(-512).flatMap((event) => {
        if (event === null || typeof event !== "object") {
          return [];
        }
        const projected = toPublicEvent(event as InternalEveEvent);
        return projected === null ? [] : [projected];
      });
      const operation = pendingBuilderOperation(recentEvents);
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
  ): Promise<EveSessionResult> {
    const result = await readSession({ cursor: 0, limit: 100, sessionId });
    const current = toDurableHostedSessionRecord(await requireSession(sessionId));
    if (
      result.error?.code === "session_read_delayed" ||
      current.checkpointDigest === undefined ||
      current.checkpointDigest === previousCheckpointDigest
    ) {
      throw new HostedSubmissionUnknownError();
    }
    return result;
  }

  return {
    async cancel({ sessionId, turnId }) {
      requireHostedOperationScope(principal, "cancel");
      const session = await requireSession(sessionId);
      const paged =
        input.transport.observe !== undefined &&
        input.transport.cancelAccepted !== undefined &&
        input.store.observeSessionPaged !== undefined &&
        input.store.readCheckpointPage !== undefined;
      let snapshot: HostedEngineSnapshot;
      try {
        const observed = paged
          ? await input.transport.observe?.({
              adapterSessionId: session.adapterSessionId,
              onEvent: (event) => {
                void event;
              },
              principal,
              sessionId,
            })
          : undefined;
        if (observed && !observed.artifactProjectionRequiresLegacyReadback) {
          if (observed.activeTurnId === undefined) {
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
            const result = await readSession({ cursor: 0, limit: 100, sessionId });
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
            principal,
            ...(turnId === undefined ? {} : { turnId }),
          });
          return readAcceptedMutation(
            sessionId,
            toDurableHostedSessionRecord(session).checkpointDigest,
          );
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
          const paged =
            input.transport.observe !== undefined &&
            input.transport.respondAccepted !== undefined &&
            input.store.observeSessionPaged !== undefined &&
            input.store.readCheckpointPage !== undefined;
          const observed = paged
            ? await input.transport.observe?.({
                adapterSessionId: session.adapterSessionId,
                onEvent() {
                  // Preflight needs only the bounded observation summary.
                },
                principal,
                sessionId: request.sessionId,
              })
            : undefined;
          const before = observed
            ? undefined
            : await input.transport.get({
                adapterSessionId: session.adapterSessionId,
                principal,
              });
          const expected = (
            observed
              ? observed.pendingRequests
              : outstandingInternalEveRequests(
                  (before?.events ?? []).filter(
                    (event): event is InternalEveEvent =>
                      event !== null && typeof event === "object",
                  ),
                )
          ).flatMap((pending) => (pending.kind === "authorization" ? [] : [pending.requestId]));
          if (
            expected.length !== request.responses.length ||
            expected.some((requestId, index) => request.responses[index]?.requestId !== requestId)
          ) {
            throw new SubmissionRejectedBeforeDispatchError("input_batch_changed");
          }
          const responseInput = {
            adapterSessionId: session.adapterSessionId,
            operationId,
            principal,
            responses: request.responses,
            ...(session.version === 2 && session.sourceHandoffId
              ? { sourceHandoffId: session.sourceHandoffId }
              : {}),
          };
          if (observed && !observed.artifactProjectionRequiresLegacyReadback) {
            await input.transport.respondAccepted?.(responseInput);
            return {
              result: await readAcceptedMutation(
                request.sessionId,
                toDurableHostedSessionRecord(session).checkpointDigest,
              ),
            };
          }
          const snapshot = await input.transport.respond(responseInput);
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
          const paged =
            input.transport.observe !== undefined &&
            input.transport.sendAccepted !== undefined &&
            input.store.observeSessionPaged !== undefined &&
            input.store.readCheckpointPage !== undefined;
          const observed = paged
            ? await input.transport.observe?.({
                adapterSessionId: session.adapterSessionId,
                onEvent() {
                  // Preflight needs only the bounded observation summary.
                },
                principal,
                sessionId: request.sessionId,
              })
            : undefined;
          const sendInput = {
            adapterSessionId: session.adapterSessionId,
            message: request.message,
            operationId,
            principal,
            ...(session.version === 2 && session.sourceHandoffId
              ? { sourceHandoffId: session.sourceHandoffId }
              : {}),
          };
          if (observed && !observed.artifactProjectionRequiresLegacyReadback) {
            await input.transport.sendAccepted?.(sendInput);
            return {
              result: await readAcceptedMutation(
                request.sessionId,
                toDurableHostedSessionRecord(session).checkpointDigest,
              ),
            };
          }
          const snapshot = await input.transport.send(sendInput);
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
              const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
              const { appId: existingAppId } = existing;
              const { appId: implementationAppId } = result.uiPreview ?? {};
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
            return await readSession({
              cursor: 0,
              limit: 100,
              recoverUnavailable: false,
              sessionId: existing.sessionId,
            });
          } catch (error) {
            if (!(error instanceof HostedAdapterSessionUnavailableError)) {
              throw error;
            }
          }
        }
        if (
          (existing.checkpoint === undefined && existing.checkpointRef === undefined) ||
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
          const checkpoint = checkpointForSnapshot(sessionId, response.snapshot, timestamp);
          return {
            newSession: durableHostedSessionRecordSchema.parse({
              adapterGeneration: 1,
              adapterSessionId: response.adapterSessionId,
              ...(result.uiPreview?.appId === undefined ? {} : { appId: result.uiPreview.appId }),
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
