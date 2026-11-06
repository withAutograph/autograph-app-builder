import { describe, expect, it, vi } from "vitest";
import type { WorkflowStepToolContext } from "eve/tools";
import type { PreparedApplicationReviewContext } from "./application-review-context-store";
import type { ApplicationReviewContinuation } from "./application-source-review";
import { emptySourceReviewInvocation } from "./product-source-review-batches";
import { unavailableSourceAssessment } from "./product-source-review";
import { continueApplicationReviewWorkflow } from "./application-review-workflow";

type Steps = NonNullable<Parameters<typeof continueApplicationReviewWorkflow>[2]>;
const reference = { appId: "example_app", contextRef: "private-context" };
const outcome = { ...reference, outcomeRef: "private-outcome" };
const assessment = unavailableSourceAssessment(
  {
    appSpec: "Keep the requested behavior.",
    appSpecDigest: "spec",
    clarifications: [],
    files: [],
    omissions: [],
    originalRequest: "Keep the requested behavior.",
    sourceDigest: "source",
  },
  "Runtime behavior remains unassessed.",
  "blocked",
);
const context = (signal = new AbortController().signal): WorkflowStepToolContext => ({
  abortSignal: signal,
  callId: "review-call",
  getToken() {
    throw new Error("No provider authorization is requested by workflow orchestration.");
  },
  requireAuth() {
    throw new Error("No provider authorization is requested by workflow orchestration.");
  },
  session: {
    auth: { current: null, initiator: null },
    id: "same-session",
    turn: { id: "same-turn", sequence: 0 },
  },
  toolName: "review_current_product_source",
});
const checkpoint = (stepNumber: number): ApplicationReviewContinuation => ({
  completionRequested: false,
  evidenceFailed: false,
  findings: [],
  invalidEvidence: false,
  invocation: { ...emptySourceReviewInvocation(), requestAttempts: stepNumber },
  messages: [{ content: `Retained private round ${stepNumber}`, role: "assistant" }],
  outputRejected: false,
  references: [],
  requestOrdinal: stepNumber,
  reusableReads: [],
  runtimeChecks: ["Runtime behavior still requires execution."],
  stepNumber,
  version: 1,
});

const prepared: PreparedApplicationReviewContext = {
  appId: reference.appId,
  applyRoot: "/workspace/repository",
  normalizedChanges: [],
  observed: { files: [], treeDigest: "source" },
  parentSessionId: "same-session",
  reviewInput: {
    appSpec: "Keep the requested behavior.",
    appSpecDigest: "spec",
    clarifications: [],
    omissions: [],
    originalRequest: "Keep the requested behavior.",
    sourceDigest: "source",
  },
  reviewKey: "a".repeat(64),
  sandboxName: "owned-existing-sandbox",
  version: 1,
  visiblePaths: [],
};

describe("durable application review workflow orchestration", () => {
  it("loads immutable prepared evidence once and hands the same checkpoint to every round", async () => {
    const descriptor = structuredClone(prepared);
    const first = structuredClone(checkpoint(1));
    const second = structuredClone(checkpoint(2));
    const ctx = context();
    const load = vi.fn<NonNullable<Steps["load"]>>().mockResolvedValue(descriptor);
    const round = vi
      .fn<Steps["round"]>()
      .mockResolvedValueOnce({ continuation: first })
      .mockResolvedValueOnce({ continuation: second })
      .mockResolvedValueOnce({ assessment, continuation: second });
    const save = vi.fn<Steps["save"]>().mockResolvedValue(outcome);
    expect(await continueApplicationReviewWorkflow(reference, ctx, { load, round, save })).toEqual(
      outcome,
    );
    expect(load).toHaveBeenCalledExactlyOnceWith(reference, ctx);
    expect(round.mock.calls).toEqual([
      [reference, undefined, ctx, descriptor],
      [reference, first, ctx, descriptor],
      [reference, second, ctx, descriptor],
    ]);
    for (const call of round.mock.calls) {
      expect(call[3]).toBe(descriptor);
    }
    expect(save).toHaveBeenCalledExactlyOnceWith(reference, assessment, ctx);
    expect(descriptor).toEqual(prepared);
  });

  it("preserves descriptor load failure before any model round or outcome publication", async () => {
    const failure = new Error("Private prepared descriptor unavailable.");
    const load = vi.fn<NonNullable<Steps["load"]>>().mockRejectedValue(failure);
    const round = vi.fn<Steps["round"]>();
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(), { load, round, save }),
    ).rejects.toBe(failure);
    expect(load).toHaveBeenCalledOnce();
    expect(round).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("does not load prepared evidence when already stopped", async () => {
    const controller = new AbortController();
    const stopped = new Error("Stopped before descriptor load.");
    controller.abort(stopped);
    const load = vi.fn<NonNullable<Steps["load"]>>();
    const round = vi.fn<Steps["round"]>();
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(controller.signal), {
        load,
        round,
        save,
      }),
    ).rejects.toBe(stopped);
    expect(load).not.toHaveBeenCalled();
    expect(round).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("observes Stop during descriptor loading before dispatching a model round", async () => {
    const controller = new AbortController();
    const stopped = new Error("Stopped during descriptor load.");
    const load = vi.fn<NonNullable<Steps["load"]>>(async () => {
      controller.abort(stopped);
      return structuredClone(prepared);
    });
    const round = vi.fn<Steps["round"]>();
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(controller.signal), {
        load,
        round,
        save,
      }),
    ).rejects.toBe(stopped);
    expect(load).toHaveBeenCalledOnce();
    expect(round).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("passes each completed private checkpoint to the next round and saves only the terminal assessment", async () => {
    const first = structuredClone(checkpoint(1));
    const second = structuredClone(checkpoint(2));
    const ctx = context();
    const round = vi
      .fn<Steps["round"]>()
      .mockResolvedValueOnce({ continuation: first })
      .mockResolvedValueOnce({ continuation: second })
      .mockResolvedValueOnce({ assessment, continuation: second });
    const save = vi.fn<Steps["save"]>().mockResolvedValue(outcome);
    expect(await continueApplicationReviewWorkflow(reference, ctx, { round, save })).toEqual(
      outcome,
    );
    expect(round.mock.calls).toEqual([
      [reference, undefined, ctx, undefined],
      [reference, first, ctx, undefined],
      [reference, second, ctx, undefined],
    ]);
    expect(round.mock.calls[1][1]).toBe(first);
    expect(round.mock.calls[2][1]).toBe(second);
    expect(save).toHaveBeenCalledExactlyOnceWith(reference, assessment, ctx);
  });

  it.each(["blocked", "failed", "unassessed"] as const)(
    "saves a terminal %s outcome without trying another model round",
    async (status) => {
      const terminal = { ...assessment, reviewCompleted: false, status };
      const round = vi.fn<Steps["round"]>().mockResolvedValue({ assessment: terminal });
      const save = vi.fn<Steps["save"]>().mockResolvedValue(outcome);
      const ctx = context();
      expect(await continueApplicationReviewWorkflow(reference, ctx, { round, save })).toEqual(
        outcome,
      );
      expect(round).toHaveBeenCalledOnce();
      expect(round.mock.calls[0][0]).toBe(reference);
      expect(round.mock.calls[0][1]).toBeUndefined();
      expect(round.mock.calls[0][2]).toBe(ctx);
      expect(save).toHaveBeenCalledExactlyOnceWith(reference, terminal, ctx);
    },
  );

  it("stops before dispatch or saving when the durable context is already aborted", async () => {
    const controller = new AbortController();
    const stopped = new Error("Stopped by the owner.");
    controller.abort(stopped);
    const round = vi.fn<Steps["round"]>();
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(controller.signal), { round, save }),
    ).rejects.toBe(stopped);
    expect(round).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
  });

  it("observes cancellation after a completed round before saving its outcome", async () => {
    const controller = new AbortController();
    const stopped = new Error("Stopped during the round.");
    const round = vi.fn<Steps["round"]>(async () => {
      controller.abort(stopped);
      return { assessment, continuation: checkpoint(1) };
    });
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(controller.signal), { round, save }),
    ).rejects.toBe(stopped);
    expect(round).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves a failed native round instead of restarting or saving an invented outcome", async () => {
    const failure = new Error("Native round failed.");
    const round = vi.fn<Steps["round"]>().mockRejectedValue(failure);
    const save = vi.fn<Steps["save"]>();
    await expect(
      continueApplicationReviewWorkflow(reference, context(), { round, save }),
    ).rejects.toBe(failure);
    expect(round).toHaveBeenCalledOnce();
    expect(save).not.toHaveBeenCalled();
  });

  it("preserves private outcome storage failure without another model or storage attempt", async () => {
    const failure = new Error("Private outcome storage unavailable.");
    const round = vi.fn<Steps["round"]>().mockResolvedValue({ assessment });
    const save = vi.fn<Steps["save"]>().mockRejectedValue(failure);
    await expect(
      continueApplicationReviewWorkflow(reference, context(), { round, save }),
    ).rejects.toBe(failure);
    expect(round).toHaveBeenCalledOnce();
    expect(save).toHaveBeenCalledOnce();
  });
});
