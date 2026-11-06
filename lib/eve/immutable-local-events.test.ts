import { expect, it } from "vitest";
import type { MessageStreamEvent } from "eve/client";
import { appendCurrentLocalSnapshot, appendImmutableLocalEvent } from "./immutable-local-events";

const event = (id: string): MessageStreamEvent => ({
  data: { continuationToken: id, wait: "next-user-message" },
  meta: { at: "2026-11-04T00:00:00.000Z", id },
  type: "session.waiting",
});

it("retains the shared array and cursor when an older reader repeats caught-up events", () => {
  const events = [event("first")];
  const heldByReader = events;
  appendCurrentLocalSnapshot(events, [event("first"), event("second")]);
  expect(heldByReader).toBe(events);
  expect(appendImmutableLocalEvent(heldByReader, event("second"))).toBe(false);
  expect(events.map((entry) => entry.meta.id)).toEqual(["first", "second"]);
});

it("preserves a stream tail newer than an independently read unchanged snapshot", () => {
  const events = [event("first"), event("second")];
  appendCurrentLocalSnapshot(events, [event("first")]);
  expect(events).toEqual([event("first"), event("second")]);
});

it("rejects a conflicting late event before changing the retained history", () => {
  const events = [event("first")];
  expect(() =>
    appendImmutableLocalEvent(events, {
      ...event("first"),
      meta: { at: "2026-11-04T01:00:00.000Z", id: "first" },
    }),
  ).toThrow("local_native_event_conflict");
  expect(events).toEqual([event("first")]);
});

it("rejects reordered or substituted native prefixes without appending a suffix", () => {
  const events = [event("first"), event("second")];
  expect(() => {
    appendCurrentLocalSnapshot(events, [event("second"), event("first"), event("third")]);
  }).toThrow("local_native_history_conflict");
  expect(events).toEqual([event("first"), event("second")]);
});
