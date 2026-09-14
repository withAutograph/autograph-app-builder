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

const inputContext = (): HookContext =>
  // SAFETY: Input handlers only update session-bound state and do not access context services.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  ({ session: { turn: { sequence: 1 } } }) as HookContext;
const requestInput = async (kind: "question" | "tool-approval", requestId = "scope") => {
  // SAFETY: Supplies every input request field used by the supported handler; event metadata is not read.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const event = {
    data: {
      requests: [
        {
          action: {
            callId: "call",
            input: { credential: "do-not-retain-action-input" },
            kind: "tool-call",
            toolName: "ask_question",
          },
          kind,
          options: [
            { description: "Keep login", id: "auth", label: "Require authentication" },
            { id: "public", label: "Public access" },
          ],
          prompt: "Should the app require login?",
          requestId,
        },
      ],
      sequence: 1,
      stepIndex: 0,
      turnId: "turn_1",
    },
    meta: { at: "2026-09-14T00:00:00.000Z", id: `requested-${requestId}` },
    type: "input.requested",
  } as HookEvent<"input.requested">;
  await hook.events?.["input.requested"]?.(event, inputContext());
};
const resolveInput = async (
  resolution: HookEvent<"input.resolved">["data"]["resolutions"][number],
) => {
  // SAFETY: The complete supported resolution is supplied; event metadata is not read by the handler.
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion
  const event = {
    data: { resolutions: [resolution], sequence: 1, stepIndex: 0, turnId: "turn_1" },
    meta: { at: "2026-09-14T00:00:01.000Z", id: `resolved-${resolution.requestId}` },
    type: "input.resolved",
  } as HookEvent<"input.resolved">;
  await hook.events?.["input.resolved"]?.(event, inputContext());
};
it("retains selected option context and explicit later scope changes once through actual hooks", async () => {
  let state: RetainedProductRequest = {
    clarifications: [],
    original: "Build an authenticated app",
    sequences: [],
  };
  vi.spyOn(productRequestState, "update").mockImplementation((update) => {
    state = update(state);
  });
  await requestInput("question");
  expect(JSON.stringify(state)).not.toContain("do-not-retain-action-input");
  const answer = {
    kind: "question" as const,
    outcome: "answered" as const,
    requestId: "scope",
    response: {
      optionId: "public",
      requestId: "scope",
      text: "Change the scope: this app should be public without login.",
    },
  };
  await resolveInput(answer);
  await requestInput("question");
  await resolveInput(answer);
  expect(state.original).toBe("Build an authenticated app");
  expect(state.clarifications).toHaveLength(1);
  expect(state.clarifications[0]).toContain("Should the app require login?");
  expect(state.clarifications[0]).toContain("Public access");
  expect(state.clarifications[0]).toContain("Change the scope");
  expect(state.pendingInputs).toEqual([]);
});
it("preserves legacy safety, contextualizes approvals and ignores unresolved or mismatched answers", async () => {
  let state: RetainedProductRequest = { clarifications: [], original: null, sequences: [] };
  vi.spyOn(productRequestState, "update").mockImplementation((update) => {
    state = update(state);
  });
  await resolveInput({
    kind: "question",
    outcome: "answered",
    requestId: "unknown",
    response: { requestId: "unknown", text: "No context" },
  });
  expect(state.clarifications).toEqual([]);
  await requestInput("tool-approval", "approval");
  await resolveInput({
    kind: "tool-approval",
    outcome: "approved",
    requestId: "approval",
    response: { requestId: "approval" },
  });
  expect(state.original).toBeNull();
  expect(state.clarifications[0]).toContain("does not by itself waive product requirements");
  await requestInput("question", "invalid");
  await resolveInput({ kind: "question", outcome: "invalid", requestId: "invalid" });
  await requestInput("question", "mismatch");
  await resolveInput({
    kind: "question",
    outcome: "answered",
    requestId: "mismatch",
    response: { requestId: "another-session", text: "Do not retain" },
  });
  expect(state.clarifications).toHaveLength(1);
});
it("does not carry pending question context into another session and retains explicit denial", async () => {
  let state: RetainedProductRequest = { clarifications: [], original: "Owner one", sequences: [] };
  vi.spyOn(productRequestState, "update").mockImplementation((update) => {
    state = update(state);
  });
  await requestInput("question", "owner-question");
  const ownerOne = state;
  state = { clarifications: [], original: "Owner two", sequences: [] };
  await resolveInput({
    kind: "question",
    outcome: "answered",
    requestId: "owner-question",
    response: { optionId: "auth", requestId: "owner-question" },
  });
  expect(state.clarifications).toEqual([]);
  state = ownerOne;
  await resolveInput({
    kind: "question",
    outcome: "answered",
    requestId: "owner-question",
    response: { optionId: "auth", requestId: "owner-question" },
  });
  expect(state.clarifications[0]).toContain("Keep login");
  await requestInput("tool-approval", "denial");
  await resolveInput({
    kind: "tool-approval",
    outcome: "denied",
    requestId: "denial",
    response: { requestId: "denial", text: "Do not publish" },
  });
  expect(state.clarifications[1]).toContain('"outcome":"denied"');
  expect(state.clarifications[1]).toContain("Do not publish");
});
