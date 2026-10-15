import type { NativeObservationState } from "../eve/native-observation-state";

export interface RealmContinuationPendingBaseline {
  nextNativeIndex: number;
  pendingRequestIds: string[];
}

/** Carry every retained pending request across turns before reading the native tail. */
export const realmContinuationPendingBaseline = (
  state: Pick<NativeObservationState, "nextNativeIndex" | "pendingRequests" | "privateInputState">,
): RealmContinuationPendingBaseline => {
  const pending = new Set(state.pendingRequests.map(({ requestId }) => requestId));
  const privateState = state.privateInputState;
  if (privateState !== undefined) {
    const resolved = new Set(
      privateState.resolved.flatMap(({ resolutions }) =>
        resolutions.map(({ requestId }) => requestId),
      ),
    );
    for (const batch of privateState.pending) {
      for (const { requestId } of batch.requests) {
        if (!resolved.has(requestId)) {
          pending.add(requestId);
        }
      }
    }
  }
  return { nextNativeIndex: state.nextNativeIndex, pendingRequestIds: [...pending] };
};
