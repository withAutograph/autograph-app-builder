import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import type { HostedRuntimeApprovalEnvelope } from "./prepare-app-hosted-runtime-step";
import type {
  HostedRuntimeApprovalReceiptState,
  HostedRuntimeApprovalWaitSnapshot,
} from "./hosted-runtime-approval-receipt";

type WaitContext = Pick<WorkflowToolContext, "abortSignal" | "session" | "callId">;
export interface HostedRuntimeApprovalWaitPorts<Context extends WaitContext> {
  read: (
    input: HostedRuntimeApprovalEnvelope,
    ctx: Context,
    snapshot: HostedRuntimeApprovalWaitSnapshot | undefined,
    delayMs: number,
    catchUp: boolean,
  ) => Promise<HostedRuntimeApprovalReceiptState>;
  sleepUntil: (deadline: Date) => Promise<void>;
}

/** Keep the original tool invocation alive; absence never becomes approval or another model turn. */
export const waitForHostedRuntimeApprovalReceipt = async <Context extends WaitContext>(
  input: HostedRuntimeApprovalEnvelope,
  ctx: Context,
  ports: HostedRuntimeApprovalWaitPorts<Context>,
) => {
  const { read, sleepUntil } = ports;
  let delayMs = 1000;
  let state = await read(input, ctx, undefined, delayMs, true);
  while (state.status === "pending") {
    // oxlint-disable-next-line eslint/no-await-in-loop -- Workflow sleep releases compute while the canonical receipt commits.
    await sleepUntil(new Date(state.checkAfter));
    delayMs = Math.min(delayMs * 2, 30_000);
    // oxlint-disable-next-line eslint/no-await-in-loop -- Subsequent ticks re-read cached approval only under the original invocation snapshot.
    state = await read(input, ctx, state.snapshot, delayMs, false);
  }
  return state;
};

// oxlint-disable-next-line eslint/func-style -- Workflow requires a top-level async step boundary.
export async function readHostedRuntimeApprovalReceiptStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  expected: HostedRuntimeApprovalWaitSnapshot | undefined,
  delayMs: number,
  catchUp: boolean,
): Promise<HostedRuntimeApprovalReceiptState> {
  "use step";
  const [approval, client, receipt] = await Promise.all([
    import("./hosted-runtime-prior-approval"),
    import("../provisioning/hosted-operator-client"),
    import("./hosted-runtime-approval-receipt"),
  ]);
  ctx.abortSignal.throwIfAborted();
  const [operator, store] = await Promise.all([
    client.hostedOperatorClientForSession(ctx.session.auth, ctx.session.id),
    approval.openHostedRuntimeApprovalStore(),
  ]);
  const read = receipt.createHostedRuntimeApprovalReceiptReader({ store, now: Date.now });
  const state = await read(input, ctx, operator, expected, delayMs);
  if (state.status === "approved" || !catchUp) {
    return state;
  }
  try {
    await approval.captureHostedRuntimeExecutionApproval(ctx, operator);
  } catch {
    // Catch-up is redundant: the parent observer may still commit the receipt independently.
    // The fresh cached read below remains authoritative, including owner/cancellation/read failures.
  }
  return await read(input, ctx, operator, state.snapshot, delayMs);
}
