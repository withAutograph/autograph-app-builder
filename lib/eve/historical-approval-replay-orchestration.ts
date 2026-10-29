import { isDeepStrictEqual } from "node:util";
import type { PublicEveEvent } from "../mcp/contracts";
import { approvalReplayProgressSchema } from "./postgres-hosted-checkpoint-history";
import type { ApprovalReplayProgress } from "./postgres-hosted-checkpoint-history";
import { verifyHistoricalApprovalReplay } from "./historical-approval-replay";

export interface ApprovalReplayCheckpoint {
  id: string;
  digest: string;
  eventCount: number;
}

interface Tail {
  complete: boolean;
  nextNativeIndex: number;
  nativeTailIndex: number;
}
type Binding = ApprovalReplayProgress["binding"];
const retainsCapture = (previous: ApprovalReplayProgress, next: ApprovalReplayProgress) => {
  const current = next.privateApprovalCaptureState;
  const identicalRequest = (
    a: { requestId: string; callId: string; toolName: string; toolInput: unknown },
    b: { requestId: string; callId: string; toolName: string; toolInput: unknown },
  ) =>
    a.requestId === b.requestId &&
    a.callId === b.callId &&
    a.toolName === b.toolName &&
    isDeepStrictEqual(a.toolInput, b.toolInput);
  return (
    previous.privateApprovalCaptureState.receipts.every((receipt) =>
      current.receipts.some((candidate) => isDeepStrictEqual(receipt, candidate)),
    ) &&
    previous.privateApprovalCaptureState.pendingRequests.every(
      (request) =>
        current.pendingRequests.some((candidate) => identicalRequest(request, candidate)) ||
        current.receipts.some((candidate) => identicalRequest(request, candidate)),
    )
  );
};
const identity = (binding: Binding) => ({
  issuer: binding.principal.issuer,
  audience: binding.principal.audience,
  workspaceId: binding.principal.workspaceId,
  ownerUserId: binding.principal.ownerUserId,
  sessionId: binding.sessionId,
  adapterSessionId: binding.adapterSessionId,
  adapterGeneration: binding.adapterGeneration,
});

/**
 * One owner-authorized observation of a historical approval replay. The ports are
 * read/transaction boundaries; this function never dispatches an approval response.
 * Both write ports must atomically compare the supplied current checkpoint reference.
 */
export const runHistoricalApprovalReplay = async (input: {
  binding: Binding;
  checkpoint: ApprovalReplayCheckpoint;
  trustedEvents: () => AsyncIterable<PublicEveEvent>;
  progress?: ApprovalReplayProgress;
  assertOwner: () => Promise<void>;
  observe: (prior: ApprovalReplayProgress | undefined) => Promise<{
    progress: ApprovalReplayProgress;
    nativeTail: Tail;
  }>;
  persistPartial: (
    progress: ApprovalReplayProgress,
    expected: ApprovalReplayCheckpoint,
  ) => Promise<boolean>;
  publishVerified: (
    progress: ApprovalReplayProgress,
    expected: ApprovalReplayCheckpoint,
  ) => Promise<boolean>;
}): Promise<{ status: "partial" | "ready" }> => {
  await input.assertOwner();
  const previous =
    input.progress === undefined ? undefined : approvalReplayProgressSchema.parse(input.progress);
  const { progress: raw, nativeTail } = await input.observe(previous);
  const progress = approvalReplayProgressSchema.parse(raw);
  const bindingMatches = (candidate: Binding) =>
    isDeepStrictEqual(identity(candidate), identity(input.binding)) &&
    candidate.approvalSessionId === input.binding.approvalSessionId;
  const source = previous?.sourceCheckpoint ?? input.checkpoint;
  const stablePrevious =
    previous === undefined ||
    [
      bindingMatches(previous.binding),
      progress.nativeObservationState.nextNativeIndex >=
        previous.nativeObservationState.nextNativeIndex,
      progress.events.length >= previous.events.length,
      retainsCapture(previous, progress),
      previous.events.every((event, index) => isDeepStrictEqual(event, progress.events[index])),
    ].every(Boolean);
  const stableBinding = [
    bindingMatches(progress.binding),
    isDeepStrictEqual(progress.sourceCheckpoint, source),
    stablePrevious,
  ].every(Boolean);
  if (!stableBinding) {
    throw new Error("Historical approval replay changed its binding or saved prefix.");
  }
  const validTail = [
    Number.isSafeInteger(nativeTail.nextNativeIndex),
    Number.isSafeInteger(nativeTail.nativeTailIndex),
    nativeTail.nextNativeIndex >= 0,
    nativeTail.nativeTailIndex >= -1,
    nativeTail.nextNativeIndex <= nativeTail.nativeTailIndex + 1,
    nativeTail.nextNativeIndex === progress.nativeObservationState.nextNativeIndex,
  ].every(Boolean);
  if (!validTail) {
    throw new Error("Historical approval replay has an invalid native cursor.");
  }

  if (!nativeTail.complete) {
    // Even a partial observation must not diverge from the currently published prefix.
    let index = 0;
    for await (const expected of input.trustedEvents()) {
      if (index >= progress.events.length) {
        break;
      }
      if (expected.index !== index || !isDeepStrictEqual(expected, progress.events[index])) {
        throw new Error("Historical approval replay prefix mismatch.");
      }
      index += 1;
    }
    if (index < Math.min(progress.events.length, input.checkpoint.eventCount)) {
      throw new Error("Trusted approval checkpoint prefix is truncated.");
    }
    await input.assertOwner();
    if (!(await input.persistPartial(progress, input.checkpoint))) {
      throw new Error("Historical approval replay checkpoint changed.");
    }
    return { status: "partial" };
  }
  const eventStream = async function* eventStream() {
    yield* progress.events;
  };
  await verifyHistoricalApprovalReplay({
    trustedBinding: identity(input.binding),
    replayBinding: identity(progress.binding),
    trustedEventCount: input.checkpoint.eventCount,
    trustedEvents: input.trustedEvents(),
    replayEvents: eventStream(),
    nativeTail,
  });
  await input.assertOwner();
  if (!(await input.publishVerified(progress, input.checkpoint))) {
    throw new Error("Historical approval replay checkpoint changed.");
  }
  return { status: "ready" };
};
