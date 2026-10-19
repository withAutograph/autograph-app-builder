import type { WorkflowStepToolContext, WorkflowToolContext } from "eve/tools";
import type {
  HostedRuntimeApprovalEnvelope,
  prepareHostedRuntimeStep,
} from "./prepare-app-hosted-runtime-step";
import type { HostedRuntimeApprovalWaitSnapshot } from "./hosted-runtime-approval-receipt";

type Preparation = Awaited<ReturnType<typeof prepareHostedRuntimeStep>>;
export type HostedRuntimeExecutionState =
  | { status: "waiting"; checkAfter: string }
  | { status: "done"; preparation: Preparation };
export interface HostedRuntimeExecutionWaitPorts {
  snapshot: HostedRuntimeApprovalWaitSnapshot;
  read: (
    input: HostedRuntimeApprovalEnvelope,
    ctx: WorkflowToolContext,
    snapshot: HostedRuntimeApprovalWaitSnapshot,
    delayMs: number,
  ) => Promise<HostedRuntimeExecutionState>;
  sleepUntil: (deadline: Date) => Promise<void>;
}

/** @yields {object} One pending public result while the original Workflow remains active. */
// oxlint-disable-next-line eslint/func-style -- The async generator emits pending once and separately returns the terminal preparation.
export async function* continueHostedRuntimeExecutionObservation(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowToolContext,
  prepared: Preparation,
  ports: HostedRuntimeExecutionWaitPorts,
) {
  // Step proxies serialize thisVal; pass only data, never the function-bearing ports receiver.
  const { read, sleepUntil, snapshot } = ports;
  yield prepared.result;
  let delayMs = 1000;
  for (;;) {
    ctx.abortSignal.throwIfAborted();
    // oxlint-disable-next-line eslint/no-await-in-loop -- Each canonical observation follows its preceding durable wait.
    const state = await read(input, ctx, snapshot, delayMs);
    if (state.status === "done") {
      return state.preparation;
    }
    // oxlint-disable-next-line eslint/no-await-in-loop -- Workflow sleep releases compute; no provider request is dispatched.
    await sleepUntil(new Date(state.checkAfter));
    delayMs = Math.min(delayMs * 2, 30_000);
  }
}

// oxlint-disable-next-line eslint/func-style -- Workflow requires a top-level step declaration.
export async function readHostedRuntimeExecutionStep(
  input: HostedRuntimeApprovalEnvelope,
  ctx: WorkflowStepToolContext,
  snapshot: HostedRuntimeApprovalWaitSnapshot,
  delayMs: number,
): Promise<HostedRuntimeExecutionState> {
  "use step";
  const observation = await import("./hosted-runtime-execution-observation-step");
  return await observation.readHostedRuntimeExecution(input, ctx, snapshot, delayMs);
}
