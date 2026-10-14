import type { MessageStreamEvent } from "eve/client";
import { z } from "zod";

const boundarySchema = z.enum([
  "turn.completed",
  "turn.cancelled",
  "turn.failed",
  "session.waiting",
  "session.completed",
  "session.failed",
]);
export const nativeDeliveryStateSchema = z.strictObject({
  currentTurnId: z.string().min(1).optional(),
  turns: z.array(
    z.strictObject({
      startedDeliveryIds: z.array(z.string().min(1)).optional(),
      boundary: boundarySchema.optional(),
      boundaryDeliveryIds: z.array(z.string().min(1)).optional(),
      deliveryIds: z.array(z.string().min(1)),
      turnId: z.string().min(1),
    }),
  ),
  version: z.literal(1),
});
export type NativeDeliveryState = z.infer<typeof nativeDeliveryStateSchema>;
export const sendDeliverySchema = z.strictObject({
  adapterGeneration: z.number().int().positive(),
  adapterSessionId: z.string().min(1),
  deliveryId: z.string().min(1),
  requestDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/u),
  sessionId: z.string().min(1),
});
export type SendDelivery = z.infer<typeof sendDeliverySchema>;
export const emptyNativeDeliveryState = (): NativeDeliveryState => ({ turns: [], version: 1 });
export const retainedNativeDeliveryState = (
  state: NativeDeliveryState | undefined,
): NativeDeliveryState | undefined =>
  state?.turns.some((turn) => turn.deliveryIds.length > 0) === true ? state : undefined;

/** Retain observed delivery membership and opaque turn identity privately, including coalesced sets. */
export const reduceNativeDelivery = (
  state: NativeDeliveryState,
  event: MessageStreamEvent,
): void => {
  const deliveryIds = event.meta?.deliveryIds ?? [];
  const turnId =
    "data" in event && "turnId" in event.data && event.data.turnId !== ""
      ? event.data.turnId
      : undefined;
  if (turnId !== undefined) {
    state.currentTurnId = turnId;
    let turn = state.turns.find((entry) => entry.turnId === turnId);
    if (turn === undefined) {
      turn = { deliveryIds: [], turnId };
      state.turns.push(turn);
    }
    turn.deliveryIds = [...new Set([...turn.deliveryIds, ...deliveryIds])];
    if (event.type === "turn.started") {
      turn.startedDeliveryIds = [...new Set([...(turn.startedDeliveryIds ?? []), ...deliveryIds])];
    }
  }
  const boundary = boundarySchema.safeParse(event.type);
  if (!boundary.success || state.currentTurnId === undefined) {
    return;
  }
  const turn = state.turns.find((entry) => entry.turnId === state.currentTurnId);
  if (turn === undefined) {
    return;
  }
  turn.boundary = boundary.data;
  turn.boundaryDeliveryIds = [...deliveryIds];
  delete state.currentTurnId;
};
export const nativeDeliveryForEvents = (
  events: readonly MessageStreamEvent[],
): NativeDeliveryState => {
  const state = emptyNativeDeliveryState();
  for (const event of events) {
    reduceNativeDelivery(state, event);
  }
  return state;
};
/** A stamped native turn start proves delivery acceptance; it does not prove completed work. */
export const provesNativeDelivery = (
  marker: SendDelivery,
  state: NativeDeliveryState | undefined,
): boolean =>
  state?.turns.some((turn) => {
    const started = turn.startedDeliveryIds?.includes(marker.deliveryId) === true;
    const ended =
      turn.boundary !== undefined && turn.boundaryDeliveryIds?.includes(marker.deliveryId) === true;
    return turn.deliveryIds.includes(marker.deliveryId) && (started || ended);
  }) === true;
