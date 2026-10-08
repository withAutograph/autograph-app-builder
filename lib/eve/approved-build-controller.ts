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
import { internalBuildMessage } from "../agent/approved-build-continuation";
import type { ApprovedBuildDecision } from "../agent/approved-build-continuation";
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
interface ReadyBuild {
  decision: ApprovedBuildDecision;
  session: DurableHostedSessionRecord;
}
const waitingForWork = (result: EveSessionResult) =>
  result.status === "waiting" || result.error?.code === "approved_build_continuation_pending";
const readyBuild = async (input: ControllerInput): Promise<ReadyBuild | undefined> => {
  const stored = await input.store.getSession(input.principal, input.sessionId);
  if (stored === null) {
    return undefined;
  }
  const session = toDurableHostedSessionRecord(stored);
  const decision = session.privateBuildDecision;
  const unavailable =
    session.resumability !== "live" ||
    session.status === "cancelled" ||
    decision?.decision !== "runnable";
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
  ready: ReadyBuild,
  operation: HostedOperationRecord,
): Promise<EveSessionResult> => {
  const marker = operation.internalBuildContinuation;
  if (
    marker === undefined ||
    operation.sessionId !== ready.session.sessionId ||
    marker.decision.turnId !== ready.decision.turnId
  ) {
    throw new Error("Approved build continuation identity conflicts.");
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
const preflight = async (input: ControllerInput, ready: ReadyBuild) => {
  const { session, decision } = ready;
  const current = await input.store.getSession(session.principal, session.sessionId);
  if (current === null) {
    throw new Error("Approved build session is unavailable.");
  }
  const fresh = toDurableHostedSessionRecord(current);
  if (fresh.status === "cancelled" || fresh.resumability !== "live") {
    throw new Error("Approved build session is no longer resumable.");
  }
  const changed =
    fresh.privateBuildDecision?.turnId !== decision.turnId ||
    fresh.privateBuildDecision?.decision !== "runnable" ||
    fresh.adapterSessionId !== session.adapterSessionId;
  if (changed) {
    throw new Error("Approved build continuation changed before dispatch.");
  }
  await input.assertCurrentOwner(fresh);
  if (input.transport.observe === undefined) {
    return;
  }
  const observed = await input.transport.observe({
    adapterSessionId: session.adapterSessionId,
    onEvent() {
      /* Preflight consumes only the authoritative summary. */
    },
    principal: session.principal,
    sessionId: session.sessionId,
  });
  if (observed.status !== "waiting" || observed.pendingRequests.length > 0) {
    throw new Error("Approved build cannot continue across an active input or turn.");
  }
};
const dispatch = async (
  input: ControllerInput,
  ready: ReadyBuild,
  candidate: HostedOperationRecord,
  message: string,
): Promise<EveSessionResult> => {
  let dispatched = false;
  const { session } = ready;
  try {
    await preflight(input, ready);
    if (input.transport.sendAccepted === undefined) {
      throw new Error("Continuation transport unavailable.");
    }
    const request: Parameters<NonNullable<HostedEveTransport["sendAccepted"]>>[0] = {
      adapterSessionId: session.adapterSessionId,
      message,
      operationId: candidate.operationId,
      principal: session.principal,
    };
    if (session.sourceHandoffId !== undefined) {
      request.sourceHandoffId = session.sourceHandoffId;
    }
    dispatched = true;
    await input.transport.sendAccepted(request);
    const accepted = await input.store.settleSucceeded({
      nowEpochMs: input.now(),
      operationId: candidate.operationId,
      principal: session.principal,
      requestDigest: candidate.requestDigest,
      result: { ...input.result, status: "working" },
    });
    if (accepted.state !== "succeeded") {
      throw new Error("Approved build continuation was not durably accepted.");
    }
    return { ...input.result, status: "working" };
  } catch (error) {
    const rejected = !dispatched || error instanceof SubmissionRejectedBeforeDispatchError;
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
          ? "approved_build_continuation_blocked"
          : "approved_build_continuation_unknown",
        message: rejected
          ? "Current ownership, input or dispatch authority blocks the approved build continuation. Preserve this session."
          : "The continuation may have been accepted. Preserve this session and observe its unknown outcome without resending.",
      },
      status: rejected ? "waiting" : "working",
    };
  }
};
/** Canonical reservation is the only dispatch authority. Unknown submissions are observed, never sent again. */
export const continueApprovedHostedBuild = async (
  input: ControllerInput,
): Promise<EveSessionResult> => {
  const missing =
    input.transport.sendAccepted === undefined || input.store.getPrivateOperation === undefined;
  if (missing || !waitingForWork(input.result) || (input.result.inputRequests?.length ?? 0) > 0) {
    return input.result;
  }
  const ready = await readyBuild(input);
  if (ready === undefined || input.store.getPrivateOperation === undefined) {
    return input.result;
  }
  const { decision, session } = ready;
  const { principal } = session;
  const clientRequestId = stableId("approved_build", {
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
  const message = internalBuildMessage(operationId, nonce);
  const requestDigest = digest({ clientRequestId, decision, sessionId: session.sessionId });
  const now = input.now();
  const candidate = hostedOperationRecordSchema.parse({
    clientRequestId,
    createdAtEpochMs: now,
    internalBuildContinuation: { decision, nonce },
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
        code: "approved_build_continuation_pending",
        message:
          "Approved private work awaits canonical operation settlement; keep this original session.",
      },
      status: "working",
    };
  }
  return await dispatch(input, ready, candidate, message);
};
