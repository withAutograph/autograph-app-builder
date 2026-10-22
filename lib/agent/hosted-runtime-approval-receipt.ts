import type { WorkflowStepToolContext } from "eve/tools";
import type { HostedEveStore } from "../eve/hosted-store";
import {
  hostedOperatorCallbackExecution,
  readHostedOperatorCallbackOwner,
} from "../provisioning/hosted-operator-callback-owner";
import { tenantKeyFor } from "../eve/hosted-auth";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import type { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";
import {
  hostedRuntimePreparationInputSchema,
  matchesHostedRuntimePreparationReceipt,
} from "./hosted-runtime-prior-approval";

export interface HostedRuntimeApprovalWaitSnapshot {
  sessionId: string;
  adapterSessionId: string;
  adapterGeneration: number;
  cancellationRevision: number;
  callId: string;
  operationRef: string;
  planDigest: string;
}
export type HostedRuntimeApprovalReceiptState = {
  snapshot: HostedRuntimeApprovalWaitSnapshot;
} & ({ status: "approved" } | { status: "pending"; checkAfter: string });
type Context = Pick<WorkflowStepToolContext, "abortSignal" | "session" | "callId">;
type Operator = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "ownerContext" | "sessionId"
>;
const denied = () => new HostedOperatorError("authorization_required");

/** Only canonical owner-scoped session/receipt reads; never provider, status, plan or stream calls. */
export const createHostedRuntimeApprovalReceiptReader =
  (ports: {
    store: Pick<HostedEveStore, "getSession"> &
      Partial<Pick<HostedEveStore, "readCurrentBuildSession">>;
    now: () => number;
  }) =>
  async (
    input: HostedRuntimeApprovalEnvelope,
    ctx: Context,
    operator: Operator,
    expected?: HostedRuntimeApprovalWaitSnapshot,
    delayMs = 1000,
  ): Promise<HostedRuntimeApprovalReceiptState> => {
    ctx.abortSignal.throwIfAborted();
    const parsed = hostedRuntimePreparationInputSchema.parse(input);
    const owner = operatorOwnerContextSchema.parse(operator.ownerContext);
    const selection = { ...parsed.plan.selection, sessionId: owner.sessionId };
    const now = ports.now();
    const expiresAt = Date.parse(parsed.plan.retention.expiresAt);
    if (
      ![
        parsed.plan.action === "prepare",
        operatorPlanDigest(parsed.plan) === parsed.planDigest,
        sameOperatorSelection(parsed.plan.selection, selection),
        parsed.appId === selection.appId,
        parsed.branch === selection.branch,
        parsed.projectId === selection.projectId,
        parsed.environment === selection.environment,
        operator.sessionId === owner.sessionId,
        ctx.callId.length > 0,
        Number.isFinite(now),
        expiresAt > now,
        Number.isFinite(delayMs) && delayMs > 0,
      ].every(Boolean)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    const { authoritySession: session, currentSession } = await readHostedOperatorCallbackOwner({
      store: ports.store,
      owner,
      execution: hostedOperatorCallbackExecution(ctx.session),
    });
    ctx.abortSignal.throwIfAborted();
    const snapshot: HostedRuntimeApprovalWaitSnapshot = {
      sessionId: session.sessionId,
      adapterSessionId: currentSession.adapterSessionId,
      adapterGeneration: currentSession.adapterGeneration,
      cancellationRevision: currentSession.cancellationRevision ?? 0,
      callId: ctx.callId,
      operationRef: parsed.operationRef,
      planDigest: parsed.planDigest,
    };
    const validSession = [
      session.sessionId === owner.sessionId,
      currentSession.adapterSessionId === owner.adapterSessionId,
      currentSession.adapterGeneration === owner.adapterGeneration,
      tenantKeyFor(session.principal) === tenantKeyFor(owner.principal),
      expected === undefined ||
        (
          [
            "sessionId",
            "adapterSessionId",
            "adapterGeneration",
            "cancellationRevision",
            "callId",
            "operationRef",
            "planDigest",
          ] as const
        ).every((key) => snapshot[key] === expected[key]),
    ].every(Boolean);
    if (!validSession) {
      throw denied();
    }
    const matching = (session.privateApprovalReceipts ?? [])
      .filter((receipt) => matchesHostedRuntimePreparationReceipt(receipt, parsed))
      .toSorted((left, right) => left.sequence - right.sequence);
    if (matching.at(-1)?.outcome === "cancelled") {
      throw denied();
    }
    const approved = matching.find((receipt) => receipt.outcome === "approved");
    if (approved !== undefined) {
      if (approved.responderPrincipalId !== owner.principal.ownerUserId) {
        throw denied();
      }
      return { snapshot, status: "approved" };
    }
    return {
      snapshot,
      status: "pending",
      checkAfter: new Date(Math.min(now + delayMs, expiresAt)).toISOString(),
    };
  };
