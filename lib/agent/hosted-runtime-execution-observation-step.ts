import type { PreparedRuntimeSelection } from "./prepared-runtime-selection";
import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import type {
  HostedRuntimeApprovalEnvelope,
  prepareHostedRuntimeStep,
} from "./prepare-app-hosted-runtime-step";
import type { HostedRuntimeApprovalWaitSnapshot } from "./hosted-runtime-approval-receipt";
import type { OperatorPublicResult } from "../provisioning/hosted-operator-contract";
import type { HostedRuntimeExecutionState } from "./hosted-runtime-execution-wait";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
  operatorPlanDigest,
  sameOperatorSelection,
} from "../provisioning/hosted-operator-contract";
import {
  hostedOperatorCallbackExecution,
  readHostedOperatorCallbackOwner,
} from "../provisioning/hosted-operator-callback-owner";
import type { HostedEveStore } from "../eve/hosted-store";
import {
  matchesHostedRuntimePreparationReceipt,
  hostedRuntimePreparationInputSchema,
} from "./hosted-runtime-prior-approval";
import { tenantKeyFor } from "../eve/hosted-auth";
import type { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";

type Preparation = Awaited<ReturnType<typeof prepareHostedRuntimeStep>>;
type Context = Pick<WorkflowToolContext, "session" | "callId" | "abortSignal">;
type Operator = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "ownerContext" | "sessionId"
>;

/** Verify the original invocation's authority without planning or granting another effect. */
// oxlint-disable-next-line eslint/complexity -- Verify the original session and human receipt together without resnapshotting authority.
export const assertHostedRuntimeExecutionObservationAuthority = async (input: {
  approved: HostedRuntimeApprovalEnvelope;
  context: Context;
  operator: Operator;
  snapshot: HostedRuntimeApprovalWaitSnapshot;
  store: Pick<HostedEveStore, "getSession"> &
    Partial<Pick<HostedEveStore, "readCurrentBuildSession">>;
}) => {
  const { context: ctx, snapshot, operator } = input;
  const approved = hostedRuntimePreparationInputSchema.parse(input.approved);
  ctx.abortSignal.throwIfAborted();
  const owner = operatorOwnerContextSchema.parse(operator.ownerContext);
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Original invocation identity must match every authority dimension.
    operatorPlanDigest(approved.plan) !== approved.planDigest ||
    snapshot.operationRef !== approved.operationRef ||
    snapshot.planDigest !== approved.planDigest ||
    snapshot.callId !== ctx.callId ||
    snapshot.sessionId !== operator.sessionId ||
    snapshot.sessionId !== owner.sessionId ||
    snapshot.adapterSessionId !== owner.adapterSessionId ||
    snapshot.adapterGeneration !== owner.adapterGeneration ||
    !sameOperatorSelection(approved.plan.selection, {
      ...approved.plan.selection,
      sessionId: owner.sessionId,
    })
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  const { authoritySession: session, currentSession } = await readHostedOperatorCallbackOwner({
    store: input.store,
    owner,
    execution: hostedOperatorCallbackExecution(ctx.session),
  });
  ctx.abortSignal.throwIfAborted();
  if (
    // oxlint-disable-next-line sonarjs/expression-complexity -- Reject owner, generation, and cancellation drift together.
    session.sessionId !== snapshot.sessionId ||
    currentSession.adapterSessionId !== snapshot.adapterSessionId ||
    currentSession.adapterGeneration !== snapshot.adapterGeneration ||
    (currentSession.cancellationRevision ?? 0) !== snapshot.cancellationRevision ||
    tenantKeyFor(session.principal) !== tenantKeyFor(owner.principal) ||
    currentSession.status === "cancelled" ||
    currentSession.status === "completed"
  ) {
    throw new HostedOperatorError("authorization_required");
  }
  const matching = (session.privateApprovalReceipts ?? [])
    .filter((receipt) => matchesHostedRuntimePreparationReceipt(receipt, approved))
    .toSorted((a, b) => a.sequence - b.sequence);
  if (
    matching.at(-1)?.outcome === "cancelled" ||
    !matching.some(
      (receipt) =>
        receipt.outcome === "approved" &&
        receipt.responderPrincipalId === owner.principal.ownerUserId,
    )
  ) {
    throw new HostedOperatorError("authorization_required");
  }
};

/** Unknown evidence remains pending; it never authorizes another execute or plan. */
export const observedHostedRuntimeExecutionIsSettled = (
  input: HostedRuntimeApprovalEnvelope,
  result: OperatorPublicResult,
) => {
  if (result.status === "blocked" && result.operationRef === undefined) {
    throw new HostedOperatorError(result.code ?? "reconciliation_required");
  }
  if (
    result.appId !== input.appId ||
    result.operationRef !== input.operationRef ||
    result.planDigest !== input.planDigest
  ) {
    throw new HostedOperatorError("resource_mismatch");
  }
  if (result.execution?.state === "settled") {
    if (
      (result.status !== "pending" && result.status !== result.execution.outcome.status) ||
      (result.code !== undefined && result.code !== result.execution.outcome.code)
    ) {
      throw new HostedOperatorError("resource_mismatch");
    }
    return true;
  }
  if (result.execution !== undefined) {
    return false;
  }
  return [
    "prepared",
    "auth-schema-prepared",
    "participants-prepared",
    "waiting_for_signup",
    "ready",
    "cleaned",
  ].includes(result.status);
};

export const createHostedRuntimeExecutionObserver =
  (ports: {
    assertAuthority: (
      input: HostedRuntimeApprovalEnvelope,
      ctx: Context,
      snapshot: HostedRuntimeApprovalWaitSnapshot,
    ) => Promise<void>;
    readStatus: (
      input: HostedRuntimeApprovalEnvelope,
      ctx: Context,
    ) => Promise<OperatorPublicResult>;
    prepareObserved: (
      input: HostedRuntimeApprovalEnvelope,
      ctx: Context,
      result: OperatorPublicResult,
    ) => Promise<Preparation>;
    // oxlint-disable-next-line anti-slop/no-unknown-parameters -- A caught exception is untrusted until the private transport-error guard narrows it.
    isTransportUnknown: (error: unknown) => boolean;
    now: () => number;
    commitObserved?: (preparation: Preparation) => void;
  }) =>
  async (
    input: HostedRuntimeApprovalEnvelope,
    ctx: Context,
    snapshot: HostedRuntimeApprovalWaitSnapshot,
    delayMs: number,
  ): Promise<HostedRuntimeExecutionState> => {
    const waiting = () => ({
      status: "waiting" as const,
      checkAfter: new Date(ports.now() + delayMs).toISOString(),
    });
    await ports.assertAuthority(input, ctx, snapshot);
    let result: OperatorPublicResult;
    try {
      result = await ports.readStatus(input, ctx);
    } catch (error) {
      ctx.abortSignal.throwIfAborted();
      if (ports.isTransportUnknown(error)) {
        await ports.assertAuthority(input, ctx, snapshot);
        return waiting();
      }
      throw error;
    }
    await ports.assertAuthority(input, ctx, snapshot);
    if (!observedHostedRuntimeExecutionIsSettled(input, result)) {
      return waiting();
    }
    const terminal =
      result.execution?.state === "settled" ? { ...result, ...result.execution.outcome } : result;
    const preparation = await ports.prepareObserved(input, ctx, terminal);
    await ports.assertAuthority(input, ctx, snapshot);
    ports.commitObserved?.(preparation);
    return { status: "done", preparation };
  };

export const readHostedRuntimeExecution = async (
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  snapshot: HostedRuntimeApprovalWaitSnapshot,
  delayMs: number,
): Promise<HostedRuntimeExecutionState> => {
  const [client, approval, preparation, contract, state] = await Promise.all([
    import("../provisioning/hosted-operator-client"),
    import("./hosted-runtime-prior-approval"),
    import("./prepare-app-hosted-runtime-step"),
    import("../provisioning/hosted-operator-contract"),
    import("./prepared-runtime-selection"),
  ]);
  const [operator, store] = await Promise.all([
    client.hostedOperatorClientForSession(
      ctx.session.auth,
      ctx.session.id,
      process.env,
      hostedOperatorCallbackExecution(ctx.session),
    ),
    approval.openHostedRuntimeApprovalStore(),
  ]);
  let selected: PreparedRuntimeSelection | undefined;
  const read = createHostedRuntimeExecutionObserver({
    now: Date.now,
    isTransportUnknown: client.isHostedOperatorTransportUnknown,
    commitObserved: () => {
      if (selected !== undefined) {
        const committed = selected;
        state.preparedRuntimeSelections.update((selections) => ({
          ...selections,
          [input.appId]: committed,
        }));
      }
    },
    assertAuthority: async (approved, context, expected) => {
      await assertHostedRuntimeExecutionObservationAuthority({
        approved,
        context,
        operator,
        snapshot: expected,
        store,
      });
    },
    readStatus: async (approved, context) =>
      await operator.request(
        {
          action: "status",
          operationRef: approved.operationRef,
          selection: approval.hostedRuntimePreparationInputSchema.parse(approved).plan.selection,
        },
        context.abortSignal,
      ),
    prepareObserved: async (approved, context, result) =>
      await preparation.prepareHostedRuntimeWithOperator(
        approval.hostedRuntimePreparationInputSchema.parse(approved),
        context,
        operator,
        (selection) => {
          selected = selection;
        },
        {
          createResourceMismatch: () => new contract.HostedOperatorError("resource_mismatch"),
          digest: contract.operatorPlanDigest,
          isOperatorError: (error): error is InstanceType<typeof contract.HostedOperatorError> =>
            error instanceof contract.HostedOperatorError,
          sameSelection: contract.sameOperatorSelection,
        },
        result,
      ),
  });
  return await read(input, ctx, snapshot, delayMs);
};
