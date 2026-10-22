import type { HostedEveStore } from "../eve/hosted-store";
import {
  hostedOperatorCallbackExecution,
  readHostedOperatorCallbackOwner,
} from "../provisioning/hosted-operator-callback-owner";
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
interface Context {
  abortSignal: AbortSignal;
  session: {
    id: string;
    auth: unknown;
    readonly ownerRunId?: string;
    readonly ownerAnchorRunId?: string;
  };
}
type Operator = Pick<
  Awaited<ReturnType<typeof hostedOperatorClientForSession>>,
  "ownerContext" | "request" | "sessionId"
>;
interface ReferencePorts {
  store: Pick<HostedEveStore, "getSession"> &
    Partial<Pick<HostedEveStore, "readCurrentBuildSession">>;
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
    const { authoritySession: session, currentSession } = await readHostedOperatorCallbackOwner({
      store: ports.store,
      owner,
      execution: hostedOperatorCallbackExecution(ctx.session),
    });
    ctx.abortSignal.throwIfAborted();
    const matches = [
      session.sessionId === owner.sessionId,
      currentSession.adapterSessionId === owner.adapterSessionId,
      currentSession.adapterGeneration === owner.adapterGeneration,
      ...(["audience", "issuer", "ownerUserId", "workspaceId"] as const).map(
        (key) => session.principal[key] === owner.principal[key],
      ),
      currentSession.status !== "cancelled",
      currentSession.status !== "completed",
    ].every(Boolean);
    const snapshotMatches =
      expected === undefined ||
      [
        expected.sessionId === session.sessionId,
        expected.adapterSessionId === currentSession.adapterSessionId,
        expected.adapterGeneration === currentSession.adapterGeneration,
        expected.cancellationRevision === (currentSession.cancellationRevision ?? 0),
      ].every(Boolean);
    if (!matches || !snapshotMatches) {
      throw denied();
    }
    return { session, currentSession };
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
    const { session, currentSession } = await readOwned(ctx, owner);
    const snapshot: HostedRuntimeResumeSnapshot = {
      sessionId: session.sessionId,
      adapterSessionId: currentSession.adapterSessionId,
      adapterGeneration: currentSession.adapterGeneration,
      cancellationRevision: currentSession.cancellationRevision ?? 0,
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
  const operator = await client.hostedOperatorClientForSession(
    ctx.session.auth,
    ctx.session.id,
    process.env,
    hostedOperatorCallbackExecution(ctx.session),
  );
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
