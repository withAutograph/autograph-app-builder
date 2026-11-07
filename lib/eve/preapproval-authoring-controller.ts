import { isDeepStrictEqual } from "node:util";
import { randomBytes } from "node:crypto";
import { SubmissionRejectedBeforeDispatchError } from "./hosted-errors";
import type { EveSessionResult } from "../mcp/contracts";
import type { HostedPrincipal } from "./hosted-auth";
import type {
  DurableHostedSessionRecord,
  HostedEveStore,
  HostedOperationRecord,
} from "./hosted-store";
import { hostedOperationRecordSchema, toDurableHostedSessionRecord } from "./hosted-store";
import { digest, stableId } from "./hosted-operation-identifiers";
import { internalAuthoringMessage } from "../agent/preapproval-authoring";
import type { PreapprovalAuthoringDecision } from "../agent/preapproval-authoring";
import type { HostedEveTransport } from "./hosted-service";

interface ControllerInput {
  assertCurrentOwner: (session: DurableHostedSessionRecord) => Promise<void>;
  now: () => number;
  principal: HostedPrincipal;
  result: EveSessionResult;
  sessionId: string;
  store: HostedEveStore;
  transport: HostedEveTransport;
}
interface ReadyAuthoring {
  decision: PreapprovalAuthoringDecision;
  session: DurableHostedSessionRecord;
}
const waitingForWork = (result: EveSessionResult) =>
  result.status === "waiting" ||
  result.error?.code === "preapproval_authoring_continuation_pending";
const sameAuthoringEpoch = (current: DurableHostedSessionRecord, ready: ReadyAuthoring): boolean =>
  isDeepStrictEqual(
    [
      current.adapterSessionId,
      current.cancellationRevision,
      current.resumedCancellationRevision,
      current.privateAuthoringDecision,
    ],
    [
      ready.session.adapterSessionId,
      ready.session.cancellationRevision,
      ready.session.resumedCancellationRevision,
      ready.decision,
    ],
  );
const readyAuthoring = async (input: ControllerInput): Promise<ReadyAuthoring | undefined> => {
  const stored = await input.store.getSession(input.principal, input.sessionId);
  if (stored === null) {
    return undefined;
  }
  const session = toDurableHostedSessionRecord(stored);
  const decision = session.privateAuthoringDecision;
  const cancelled =
    session.status === "cancelled" ||
    (session.cancellationRevision ?? 0) !== (session.resumedCancellationRevision ?? 0);
  const unavailable =
    session.resumability !== "live" || cancelled || decision?.decision !== "runnable";
  if (unavailable || decision === undefined) {
    return undefined;
  }
  if (decision.scope === undefined || decision.adapterSessionId !== session.adapterSessionId) {
    return undefined;
  }
  await input.assertCurrentOwner(session);
  return { decision, session };
};
const restoreExisting = async (
  input: ControllerInput,
  ready: ReadyAuthoring,
  operation: HostedOperationRecord,
): Promise<EveSessionResult> => {
  const marker = operation.internalAuthoringContinuation;
  if (
    marker === undefined ||
    operation.sessionId !== ready.session.sessionId ||
    !isDeepStrictEqual(marker.decision, ready.decision)
  ) {
    throw new Error("Preapproval authoring continuation identity conflicts.");
  }
  const unknown = operation.state === "reserved" || operation.state === "submission_unknown";
  if (unknown && marker.deliveredTurnId !== undefined) {
    await input.store.settleSucceeded({
      nowEpochMs: input.now(),
      operationId: operation.operationId,
      principal: ready.session.principal,
      requestDigest: operation.requestDigest,
      result: { ...input.result, status: "working" },
    });
  }
  return operation.state === "rejected" ? input.result : { ...input.result, status: "working" };
};
type ContinuationStage =
  | "session_preflight"
  | "owner_preflight"
  | "transport_observation"
  | "dispatch"
  | "settlement";
type ContinuationPreflightReason =
  | "session_unavailable"
  | "session_not_resumable"
  | "decision_changed"
  | "active_input_or_turn"
  | "transport_unavailable";
class ContinuationPreflightError extends Error {
  readonly reason: ContinuationPreflightReason;
  constructor(reason: ContinuationPreflightReason) {
    super("Preapproval authoring continuation preflight rejected.");
    this.name = "ContinuationPreflightError";
    this.reason = reason;
  }
}
const transportRejectionReasons = new Set([
  "workload_identity_unavailable",
  "session_access_denied",
  "eve_request_rejected",
  "turn_changed",
  "no_active_turn",
  "input_batch_changed",
  "send_preflight_unavailable",
]);
// oxlint-disable-next-line anti-slop/no-unknown-parameters -- JavaScript catch values are unknown; only typed internal errors and allowlisted transport codes reach diagnostics.
const rejectionReason = (error: unknown, stage: ContinuationStage): string => {
  if (error instanceof ContinuationPreflightError) {
    return error.reason;
  }
  if (error instanceof SubmissionRejectedBeforeDispatchError) {
    return transportRejectionReasons.has(error.code) ? error.code : "transport_rejected";
  }
  return stage === "owner_preflight" ? "owner_verification_failed" : "boundary_unavailable";
};
const preflight = async (
  input: ControllerInput,
  ready: ReadyAuthoring,
  enter: (stage: ContinuationStage) => void,
) => {
  const { session } = ready;
  const current = await input.store.getSession(session.principal, session.sessionId);
  if (current === null) {
    throw new ContinuationPreflightError("session_unavailable");
  }
  const fresh = toDurableHostedSessionRecord(current);
  if (fresh.status === "cancelled" || fresh.resumability !== "live") {
    throw new ContinuationPreflightError("session_not_resumable");
  }
  const changed = !sameAuthoringEpoch(fresh, ready);
  if (changed) {
    throw new ContinuationPreflightError("decision_changed");
  }
  enter("owner_preflight");
  await input.assertCurrentOwner(fresh);
  if (input.transport.observe === undefined) {
    throw new ContinuationPreflightError("transport_unavailable");
  }
  enter("transport_observation");
  const observed = await input.transport.observe({
    adapterSessionId: session.adapterSessionId,
    onEvent() {
      /* Preflight consumes only the authoritative summary. */
    },
    principal: session.principal,
    sessionId: session.sessionId,
  });
  if (observed.status !== "waiting" || observed.pendingRequests.length > 0) {
    throw new ContinuationPreflightError("active_input_or_turn");
  }
  const after = await input.store.getSession(session.principal, session.sessionId);
  if (after === null) {
    throw new ContinuationPreflightError("session_unavailable");
  }
  const latest = toDurableHostedSessionRecord(after);
  if (
    !sameAuthoringEpoch(latest, ready) ||
    latest.status === "cancelled" ||
    latest.resumability !== "live"
  ) {
    throw new ContinuationPreflightError("decision_changed");
  }
  await input.assertCurrentOwner(toDurableHostedSessionRecord(after));
};
const dispatch = async (
  input: ControllerInput,
  ready: ReadyAuthoring,
  candidate: HostedOperationRecord,
  message: string,
): Promise<EveSessionResult> => {
  let dispatched = false;
  let stage: ContinuationStage = "session_preflight";
  const { session } = ready;
  try {
    await preflight(input, ready, (next) => {
      stage = next;
    });
    if (input.transport.sendAccepted === undefined) {
      throw new ContinuationPreflightError("transport_unavailable");
    }
    const identity: Pick<
      Parameters<NonNullable<HostedEveTransport["sendAccepted"]>>[0],
      "adapterSessionId" | "logicalSessionId"
    > = { adapterSessionId: session.adapterSessionId };
    if (session.nativeRecoveryBinding !== undefined) {
      identity.logicalSessionId = session.nativeRecoveryBinding.logicalSessionId;
    }
    const request: Parameters<NonNullable<HostedEveTransport["sendAccepted"]>>[0] = {
      ...identity,
      message,
      operationId: candidate.operationId,
      principal: session.principal,
    };
    if (session.sourceHandoffId !== undefined) {
      request.sourceHandoffId = session.sourceHandoffId;
    }
    stage = "dispatch";
    dispatched = true;
    await input.transport.sendAccepted(request);
    stage = "settlement";
    const accepted = await input.store.settleSucceeded({
      nowEpochMs: input.now(),
      operationId: candidate.operationId,
      principal: session.principal,
      requestDigest: candidate.requestDigest,
      result: { ...input.result, status: "working" },
    });
    if (accepted.state !== "succeeded") {
      throw new Error("Preapproval authoring continuation was not durably accepted.");
    }
    return { ...input.result, status: "working" };
  } catch (error) {
    const rejected = !dispatched || error instanceof SubmissionRejectedBeforeDispatchError;
    console.info(
      JSON.stringify({
        event: "app_builder.preapproval_authoring_continuation_dispatch_boundary",
        reason: rejectionReason(error, stage),
        rejected,
        stage,
      }),
    );
    await input.store.settleUnsuccessful({
      nowEpochMs: input.now(),
      operationId: candidate.operationId,
      principal: session.principal,
      requestDigest: candidate.requestDigest,
      safeErrorCode: rejected
        ? "internal_continuation_blocked"
        : "internal_continuation_submission_unknown",
      state: rejected ? "rejected" : "submission_unknown",
    });
    return {
      ...input.result,
      error: {
        code: rejected
          ? "preapproval_authoring_continuation_blocked"
          : "preapproval_authoring_continuation_unknown",
        message: rejected
          ? "Current ownership, input or dispatch authority blocks the accepted app drafting continuation. Preserve this session."
          : "The continuation may have been accepted. Preserve this session and observe its unknown outcome without resending.",
      },
      status: rejected ? "waiting" : "working",
    };
  }
};
/** Canonical reservation is the only dispatch authority. Unknown submissions are observed, never sent again. */
export const continueHostedPreapprovalAuthoring = async (
  input: ControllerInput,
): Promise<EveSessionResult> => {
  const missing =
    input.transport.sendAccepted === undefined || input.store.getPrivateOperation === undefined;
  if (missing || !waitingForWork(input.result) || (input.result.inputRequests?.length ?? 0) > 0) {
    return input.result;
  }
  const ready = await readyAuthoring(input);
  if (ready === undefined || input.store.getPrivateOperation === undefined) {
    const current = await input.store.getSession(input.principal, input.sessionId);
    const decision =
      current === null ? undefined : toDurableHostedSessionRecord(current).privateAuthoringDecision;
    return decision?.decision === "blocked" && decision.reason === "authoring_no_progress"
      ? {
          ...input.result,
          error: {
            code: "preapproval_authoring_no_progress",
            message:
              "Builder completed the drafting continuation without producing a proposal. The accepted app is unfinished; continue through an ordinary user turn to revise the plan.",
          },
        }
      : input.result;
  }
  const { decision, session } = ready;
  const { principal } = session;
  const clientRequestId = stableId("preapproval_authoring", {
    scope: decision.scope,
    sessionId: session.sessionId,
    turnId: decision.turnId,
  });
  const operationId = stableId("op", {
    clientRequestId,
    kind: "send",
    tenant: [principal.issuer, principal.audience, principal.workspaceId, principal.ownerUserId],
  });
  const existing = await input.store.getPrivateOperation(principal, operationId);
  if (existing !== null) {
    return await restoreExisting(input, ready, existing);
  }
  const nonce = randomBytes(32).toString("hex");
  const message = internalAuthoringMessage(operationId, nonce);
  const requestDigest = digest({ clientRequestId, decision, sessionId: session.sessionId });
  const now = input.now();
  const candidate = hostedOperationRecordSchema.parse({
    clientRequestId,
    createdAtEpochMs: now,
    internalAuthoringContinuation: { decision, nonce },
    kind: "send",
    operationId,
    principal,
    requestDigest,
    sessionId: session.sessionId,
    state: "reserved",
    updatedAtEpochMs: now,
    version: 1,
  });
  const reserved = await input.store.reserveOperation(principal, candidate);
  if (reserved.disposition !== "reserved") {
    return {
      ...input.result,
      error: {
        code: "preapproval_authoring_continuation_pending",
        message:
          "Accepted app drafting awaits canonical operation settlement; keep this original session.",
      },
      status: "working",
    };
  }
  return await dispatch(input, ready, candidate, message);
};
