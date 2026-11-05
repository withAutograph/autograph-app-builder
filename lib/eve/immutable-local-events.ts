import { isDeepStrictEqual } from "node:util";
import type { MessageStreamEvent } from "eve/client";

/** Snapshot catch-up and an older open stream may observe the same native event. */
export const appendImmutableLocalEvent = (
  events: MessageStreamEvent[],
  event: MessageStreamEvent,
): boolean => {
  const prior = events.find((entry) => entry.meta.id === event.meta.id);
  if (prior !== undefined) {
    if (!isDeepStrictEqual(prior, event)) {
      throw new Error("local_native_event_conflict");
    }
    return false;
  }
  events.push(event);
  return true;
};

/** Preserve the array held by active readers and every already observed raw cursor. */
export const appendCurrentLocalSnapshot = (
  buffered: MessageStreamEvent[],
  snapshot: readonly MessageStreamEvent[],
) => {
  const overlap = Math.min(buffered.length, snapshot.length);
  for (let index = 0; index < overlap; index += 1) {
    if (!isDeepStrictEqual(buffered[index], snapshot[index])) {
      throw new Error("local_native_history_conflict");
    }
  }
  // A stream can advance while the independently complete snapshot is in flight.
  // Its unchanged older prefix is safe but cannot truncate that newer tail.
  for (const event of snapshot.slice(buffered.length)) {
    buffered.push(event);
  }
};
