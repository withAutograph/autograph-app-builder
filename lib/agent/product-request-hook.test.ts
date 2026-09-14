import { afterEach, expect, it, vi } from "vitest";
import hook from "../../agent/hooks/retain-product-request";
import { productRequestState } from "./product-source-review-state";
import type { RetainedProductRequest } from "./product-source-review-state";
import type { HookContext, HookEvent } from "eve/hooks";

afterEach(() => vi.restoreAllMocks());
const receive = async (sequence: number, message: string) => {
  // SAFETY: The exported observer only reads session.turn.sequence; runtime services are never accessed.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const context = { session: { turn: { sequence } } } as HookContext;
  // SAFETY: The handler only reads the supplied normalized message and event coordinates.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const event = {
    data: { message, sequence, turnId: `turn_${sequence}` },
    type: "message.received",
  } as HookEvent<"message.received">;
  await hook.events?.["message.received"]?.(event, context);
};
it("captures the original initial-turn message, never a legacy session follow-up", async () => {
  let state: RetainedProductRequest = { clarifications: [], original: null, sequences: [] };
  vi.spyOn(productRequestState, "update").mockImplementation((update) => {
    state = update(state);
  });
  await receive(4, "Continue");
  expect(state.original).toBeNull();
  state = { clarifications: [], original: null, sequences: [] };
  await receive(0, "Build the requested product");
  await receive(1, "Approved, proceed");
  await receive(1, "Approved, proceed");
  expect(state.original).toBe("Build the requested product");
  expect(state.clarifications).toEqual(["Approved, proceed"]);
});
