import { createHash } from "node:crypto";
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
  hostedSessionRecordDigest,
  hostedSessionRecordSchema,
  reserveOperationResultSchema,
  type HostedEveStore,
  type HostedOperationKind,
  type HostedOperationRecord,
} from "./hosted-store";
import { toPublicEvent, type InternalEveEvent } from "./public-events";
import {
  eveSessionResultSchema,
  publicEveEventSchema,
  sessionStatusSchema,
  type EveSessionResult,
} from "../mcp/contracts";

const hostedSnapshotSchema = z
  .object({
    status: sessionStatusSchema,
    events: z.array(z.unknown()).max(100_000),
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
    requestId: string;
    response:
      | { kind: "approve" }
      | { kind: "deny" }
      | { kind: "answer"; value: string; optionId?: string };
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

export class HostedRejectedOperationError extends Error {
  readonly code: string;

  constructor(code = "operation_rejected") {
    super("The hosted Eve operation was rejected before a durable result.");
    this.name = "HostedRejectedOperationError";
    this.code = code;
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

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function digest(value: unknown): string {
  return `sha256:${createHash("sha256").update(canonical(value)).digest("hex")}`;
}

function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice("sha256:".length)}`;
}

function projectSnapshot(
  sessionId: string,
  snapshotInput: unknown,
  cursor = 0,
  limit = 100,
): EveSessionResult {
  const snapshot = hostedSnapshotSchema.parse(snapshotInput);
  const candidates = snapshot.events.slice(cursor, cursor + limit);
  const events = candidates.flatMap((candidate) => {
    if (candidate === null || typeof candidate !== "object") return [];
    const projected = toPublicEvent(candidate as InternalEveEvent);
    if (projected === null) return [];
    const parsed = publicEveEventSchema.safeParse(projected);
    return parsed.success ? [parsed.data] : [];
  });
  const inputRequests = events.flatMap((event) =>
    event.type === "input_required" ? [event.request] : [],
  );
  return eveSessionResultSchema.parse({
    sessionId,
    status: snapshot.status,
    cursor: Math.min(cursor + candidates.length, snapshot.events.length),
    events,
    ...(inputRequests.length === 0 ? {} : { inputRequests }),
  });
}

export function createHostedEveSessionService(input: {
  principal: HostedPrincipal;
  store: HostedEveStore;
  transport: HostedEveTransport;
  now?: () => number;
}): EveSessionService {
  const principal = hostedPrincipalSchema.parse(input.principal);
  const now = input.now ?? Date.now;

  function requireOwnedOperation(
    operationInput: unknown,
    expected: {
      operationId: string;
      requestDigest: string;
      kind: HostedOperationKind;
      clientRequestId: string;
      sessionId?: string;
    },
  ) {
    const operation = hostedOperationRecordSchema.parse(operationInput);
    if (
      tenantKeyFor(operation.principal) !== tenantKeyFor(principal) ||
      operation.operationId !== expected.operationId ||
      operation.requestDigest !== expected.requestDigest ||
      operation.kind !== expected.kind ||
      operation.clientRequestId !== expected.clientRequestId ||
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
        hostedSessionRecordDigest(verifiedSession) !==
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
    dispatch(operationId: string): Promise<{
      result: EveSessionResult;
      newSession?: z.infer<typeof hostedSessionRecordSchema>;
    }>;
  }): Promise<EveSessionResult> {
    const requestDigest = digest({
      kind: options.kind,
      request: options.request,
      sessionId: options.sessionId,
    });
    const operationId = stableId("op", {
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
      createdAtEpochMs: timestamp,
      updatedAtEpochMs: timestamp,
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
      case "conflict":
        throw new HostedIdempotencyConflictError();
      case "reserved": {
        const operation = requireOwnedOperation(reservation.operation, {
          operationId,
          requestDigest,
          kind: options.kind,
          clientRequestId: options.request.clientRequestId,
          sessionId: options.sessionId,
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
        if (
          verified.sessionRecordDigest !==
          hostedSessionRecordDigest(dispatchedSession)
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

  return {
    async start(request) {
      requireHostedOperationScope(principal, "start");
      return mutate({
        kind: "start",
        request,
        async dispatch(operationId) {
          const response = await input.transport.start({
            principal,
            operationId,
            prompt: request.prompt,
          });
          const sessionId = stableId("ses", {
            operationId,
            adapterSessionId: response.adapterSessionId,
          });
          const result = projectSnapshot(sessionId, response.snapshot);
          const timestamp = now();
          return {
            result,
            newSession: hostedSessionRecordSchema.parse({
              version: 1,
              sessionId,
              principal,
              adapterSessionId: response.adapterSessionId,
              status: result.status,
              createdAtEpochMs: timestamp,
              updatedAtEpochMs: timestamp,
            }),
          };
        },
      });
    },
    async get({ sessionId, cursor, limit }) {
      requireHostedOperationScope(principal, "get");
      const session = await requireSession(sessionId);
      const snapshot = await input.transport.get({
        principal,
        adapterSessionId: session.adapterSessionId,
      });
      return projectSnapshot(sessionId, snapshot, cursor, limit);
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
          return {
            result: projectSnapshot(request.sessionId, snapshot),
          };
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
          const snapshot = await input.transport.respond({
            principal,
            operationId,
            adapterSessionId: session.adapterSessionId,
            requestId: request.requestId,
            response: request.response,
          });
          return {
            result: projectSnapshot(request.sessionId, snapshot),
          };
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
      return projectSnapshot(sessionId, snapshot);
    },
  };
}

export const hostedEveProjectionForTesting = projectSnapshot;
