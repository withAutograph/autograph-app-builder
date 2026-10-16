import type { WorkflowStepToolContext } from "eve/tools";

import type { HostedEveStore } from "../eve/hosted-store";
import { hostedSessionRecordSchema, toDurableHostedSessionRecord } from "../eve/hosted-store";
import {
  HostedOperatorError,
  operatorOwnerContextSchema,
} from "../provisioning/hosted-operator-contract";
import type { OperatorOwnerContext } from "../provisioning/hosted-operator-contract";
import type { hostedOperatorClientForSession } from "../provisioning/hosted-operator-client";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";
import { hostedRuntimePreparationInputSchema } from "./hosted-runtime-prior-approval";
import type { HostedRuntimePriorApproval } from "./hosted-runtime-prior-approval";

export interface HostedRuntimeOperationReference {
  appId: string;
  operationRef: string;
}
export type HostedRuntimePreparationRequest =
  | HostedRuntimeApprovalEnvelope
  | HostedRuntimeOperationReference;
export interface HostedRuntimeResumeSnapshot {
  sessionId: string;
  adapterSessionId: string;
  adapterGeneration: number;
  cancellationRevision: number;
}
type Context = Pick<WorkflowStepToolContext, "abortSignal" | "session">;
type Operator = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "ownerContext" | "request" | "sessionId"
>;
interface ReferencePorts {
  store: Pick<HostedEveStore, "getSession">;
  readPrior: (
    input: HostedRuntimeApprovalEnvelope,
    ctx: Context,
    operator: Operator,
  ) => Promise<HostedRuntimePriorApproval | null>;
}
const denied = () => new HostedOperatorError("authorization_required");

export const createHostedRuntimeApprovedReferenceReader = (ports: ReferencePorts) => {
  const readOwned = async (
    ctx: Context,
    owner: OperatorOwnerContext,
    expected?: HostedRuntimeResumeSnapshot,
  ) => {
    ctx.abortSignal.throwIfAborted();
    const raw = await ports.store.getSession(owner.principal, owner.sessionId);
    ctx.abortSignal.throwIfAborted();
    if (raw === null) {
      throw denied();
    }
    const session = toDurableHostedSessionRecord(hostedSessionRecordSchema.parse(raw));
    const matches = [
      session.sessionId === owner.sessionId,
      session.adapterSessionId === ctx.session.id,
      session.adapterSessionId === owner.adapterSessionId,
      session.adapterGeneration === owner.adapterGeneration,
      ...(["audience", "issuer", "ownerUserId", "workspaceId"] as const).map(
        (key) => session.principal[key] === owner.principal[key],
      ),
      session.status !== "cancelled",
      session.status !== "completed",
    ].every(Boolean);
    if (
      !matches ||
      (expected !== undefined &&
        (expected.sessionId !== session.sessionId ||
          expected.adapterSessionId !== session.adapterSessionId ||
          expected.adapterGeneration !== session.adapterGeneration ||
          expected.cancellationRevision !== (session.cancellationRevision ?? 0)))
    ) {
      throw denied();
    }
    return session;
  };
  const assertCurrent = async (
    snapshot: HostedRuntimeResumeSnapshot,
    ctx: Context,
    operator: Operator,
  ) => {
    const owner = operatorOwnerContextSchema.parse(operator.ownerContext);
    if (operator.sessionId !== owner.sessionId) {
      throw denied();
    }
    await readOwned(ctx, owner, snapshot);
  };
  const load = async (
    reference: HostedRuntimeOperationReference,
    ctx: Context,
    operator: Operator,
  ) => {
    const owner = operatorOwnerContextSchema.parse(operator.ownerContext);
    if (operator.sessionId !== owner.sessionId) {
      throw denied();
    }
    const session = await readOwned(ctx, owner);
    const snapshot: HostedRuntimeResumeSnapshot = {
      sessionId: session.sessionId,
      adapterSessionId: session.adapterSessionId,
      adapterGeneration: session.adapterGeneration,
      cancellationRevision: session.cancellationRevision ?? 0,
    };
    const matching = (session.privateApprovalReceipts ?? [])
      .filter(
        (receipt) =>
          receipt.toolName === "prepare-app-hosted-runtime" &&
          receipt.toolInput.appId === reference.appId &&
          receipt.toolInput.operationRef === reference.operationRef,
      )
      .toSorted((left, right) => left.sequence - right.sequence);
    const seedReceipt = matching.at(-1);
    if (seedReceipt === undefined) {
      throw denied();
    }
    const seed = hostedRuntimePreparationInputSchema.parse(seedReceipt.toolInput);
    const current = await operator.request(
      {
        action: "status",
        operationRef: reference.operationRef,
        selection: { ...seed.plan.selection, sessionId: owner.sessionId },
      },
      ctx.abortSignal,
    );
    ctx.abortSignal.throwIfAborted();
    await assertCurrent(snapshot, ctx, operator);
    if (
      current.status === "blocked" ||
      current.appId !== reference.appId ||
      current.operationRef !== reference.operationRef ||
      current.planDigest === undefined
    ) {
      throw new HostedOperatorError(current.code ?? "resource_mismatch");
    }
    const receipt = matching.find(
      (value) => value.outcome === "approved" && value.toolInput.planDigest === current.planDigest,
    );
    if (receipt === undefined) {
      throw denied();
    }
    const input = hostedRuntimePreparationInputSchema.parse(receipt.toolInput);
    await assertCurrent(snapshot, ctx, operator);
    const prior = await ports.readPrior(input, ctx, operator);
    ctx.abortSignal.throwIfAborted();
    if (prior === null) {
      throw denied();
    }
    await assertCurrent(snapshot, ctx, operator);
    return { input, snapshot };
  };
  return { assertCurrent, load };
};

const deployedReferenceReader = async (ctx: Context) => {
  const [approval, client] = await Promise.all([
    import("./hosted-runtime-prior-approval"),
    import("../provisioning/hosted-operator-client"),
  ]);
  ctx.abortSignal.throwIfAborted();
  const operator = await client.hostedOperatorClientForSession(ctx.session.auth, ctx.session.id);
  ctx.abortSignal.throwIfAborted();
  const store = await approval.openHostedRuntimeApprovalStore();
  ctx.abortSignal.throwIfAborted();
  const readPrior = approval.createHostedRuntimePriorApprovalReader({
    store,
    now: Date.now,
    recoverOriginalPlan: false,
  });
  return { operator, reader: createHostedRuntimeApprovedReferenceReader({ store, readPrior }) };
};

export const loadHostedRuntimeApprovedReference = async (
  reference: HostedRuntimeOperationReference,
  ctx: Context,
) => {
  const { reader, operator } = await deployedReferenceReader(ctx);
  return await reader.load(reference, ctx, operator);
};
export const assertHostedRuntimeApprovedReference = async (
  snapshot: HostedRuntimeResumeSnapshot,
  ctx: Context,
) => {
  const { reader, operator } = await deployedReferenceReader(ctx);
  await reader.assertCurrent(snapshot, ctx, operator);
};
