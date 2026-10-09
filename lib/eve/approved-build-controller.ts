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
const knownWorkflowPhases = new Set([
  "empty",
  "prepared",
  "ui_previewed",
  "ui_accepted",
  "app_spec_accepted",
  "dependencies_prepared",
  "identity_resolved",
  "planned",
  "apply_failed",
  "applied",
  "validation_pending",
  "validation_failed",
  "validated",
  "reviewed",
  "publication_pending",
  "publication_failed",
  "published_local",
  "branch_publication_pending",
  "branch_publication_failed",
  "published_branch_worktree",
  "fresh_bootstrap_pending",
  "fresh_bootstrap_failed",
  "published_fresh_bootstrap",
]);
const continuationDecisionReason = (session: DurableHostedSessionRecord): string => {
  if (session.status === "cancelled") {
    return "cancelled";
  }
  if (session.resumability !== "live") {
    return "not_live";
  }
  const decision = session.privateBuildDecision;
  if (decision === undefined) {
    return "projection_missing";
  }
  if (decision.decision !== "runnable") {
    return "decision_not_runnable";
  }
  if (decision.scope === undefined) {
    return "approved_scope_missing";
  }
  if (decision.adapterSessionId !== session.adapterSessionId) {
    return "adapter_mismatch";
  }
  return "runnable";
};
/** Called only after the canonical store's tenant-scoped session read. Never logs retained source or authority. */
const logContinuationDecision = (session: DurableHostedSessionRecord): void => {
  const decision = session.privateBuildDecision;
  const workflowPhase = decision?.workflowPhase;
  console.info(
    JSON.stringify({
      adapterGeneration: session.adapterGeneration,
      currentSpecPresent: decision?.currentSpec !== undefined,
      decision: decision?.decision ?? "absent",
      event: "app_builder.approved_build_continuation_decision",
      projectionPresent: decision !== undefined,
      reason: continuationDecisionReason(session),
      scopePresent: decision?.scope !== undefined,
      sessionIdentity: stableId("session", session.sessionId),
      turnIdentity: decision === undefined ? null : stableId("turn", decision.turnId),
      workflowPhase:
        workflowPhase !== undefined && knownWorkflowPhases.has(workflowPhase)
          ? workflowPhase
          : "unknown",
    }),
  );
};
const readyBuild = async (input: ControllerInput): Promise<ReadyBuild | undefined> => {
  const stored = await input.store.getSession(input.principal, input.sessionId);
  if (stored === null) {
    return undefined;
  }
  const session = toDurableHostedSessionRecord(stored);
  logContinuationDecision(session);
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
type ContinuationStage =
  | "session_preflight"
  | "owner_preflight"
  | "transport_observation"
  | "dispatch"
  | "settlement";
class ContinuationPreflightError extends Error {
  constructor(
    readonly reason:
      | "session_unavailable"
      | "session_not_resumable"
      | "decision_changed"
      | "active_input_or_turn"
      | "transport_unavailable",
  ) {
    super("Approved build continuation preflight rejected.");
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
const rejectionReason = (error: unknown, stage: ContinuationStage): string => {
  if (error instanceof ContinuationPreflightError) return error.reason;
  if (error instanceof SubmissionRejectedBeforeDispatchError) {
    return transportRejectionReasons.has(error.code) ? error.code : "transport_rejected";
  }
  return stage === "owner_preflight" ? "owner_verification_failed" : "boundary_unavailable";
};
const preflight = async (
  input: ControllerInput,
  ready: ReadyBuild,
  enter: (stage: ContinuationStage) => void,
) => {
  const { session, decision } = ready;
  const current = await input.store.getSession(session.principal, session.sessionId);
  if (current === null) {
    throw new ContinuationPreflightError("session_unavailable");
  }
  const fresh = toDurableHostedSessionRecord(current);
  if (fresh.status === "cancelled" || fresh.resumability !== "live") {
    throw new ContinuationPreflightError("session_not_resumable");
  }
  const changed =
    fresh.privateBuildDecision?.turnId !== decision.turnId ||
    fresh.privateBuildDecision?.decision !== "runnable" ||
    fresh.adapterSessionId !== session.adapterSessionId;
  if (changed) {
    throw new ContinuationPreflightError("decision_changed");
  }
  enter("owner_preflight");
  await input.assertCurrentOwner(fresh);
  if (input.transport.observe === undefined) {
    return;
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
};
const dispatch = async (
  input: ControllerInput,
  ready: ReadyBuild,
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
    const request: Parameters<NonNullable<HostedEveTransport["sendAccepted"]>>[0] = {
      adapterSessionId: session.adapterSessionId,
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
      throw new Error("Approved build continuation was not durably accepted.");
    }
    return { ...input.result, status: "working" };
  } catch (error) {
    const rejected = !dispatched || error instanceof SubmissionRejectedBeforeDispatchError;
    console.info(
      JSON.stringify({
        event: "app_builder.approved_build_continuation_dispatch_boundary",
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
