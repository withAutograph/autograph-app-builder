/* oxlint-disable eslint/require-await -- Faithful asynchronous observation and judge test doubles. */
import { expect, it, vi } from "vitest";
import { reviewObservedProductSource } from "./review-applied-product-source";
import { unavailableSourceAssessment } from "./product-source-review";

const reviewInput = {
  appSpec: "Accepted plan",
  appSpecDigest: "spec",
  clarifications: ["Use durable drafts"],
  files: [],
  omissions: [],
  originalRequest: "Original full request",
  sourceDigest: "before",
};
const observe = async () => ({
  currentDigest: async () => "observed",
  source: { files: [], omissions: ["No behavior inferred"], sourceDigest: "observed" },
});
it("binds original requirements and actual source to the shared cached reviewer", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  await reviewObservedProductSource({ mockModel: false, observe, reviewInput }, review);
  expect(review).toHaveBeenCalledWith(
    expect.objectContaining({
      appSpec: "Accepted plan",
      clarifications: ["Use durable drafts"],
      originalRequest: "Original full request",
      sourceDigest: "observed",
    }),
    false,
    expect.any(Function),
    undefined,
    undefined,
  );
});
it("retains unavailable source as blocked without invoking the judge", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  const result = await reviewObservedProductSource(
    {
      mockModel: false,
      observe: async () => {
        throw new Error("read failed");
      },
      reviewInput,
    },
    review,
  );
  expect(result).toMatchObject({ reviewCompleted: false, status: "blocked" });
  expect(review).not.toHaveBeenCalled();
});
it("does not substitute an accepted plan for missing original request", async () => {
  const review = vi.fn(async () => unavailableSourceAssessment(reviewInput, "test"));
  const result = await reviewObservedProductSource(
    { mockModel: false, observe, reviewInput: { ...reviewInput, originalRequest: null } },
    review,
  );
  expect(result.status).toBe("unassessed");
  expect(review).not.toHaveBeenCalled();
});
it("propagates cancellation rather than returning an unavailable assessment", async () => {
  const controller = new AbortController();
  const observed = async () => {
    controller.abort(new Error("cancelled"));
    throw new Error("read cancelled");
  };
  await expect(
    reviewObservedProductSource({
      abortSignal: controller.signal,
      mockModel: false,
      observe: observed,
      reviewInput,
    }),
  ).rejects.toThrow("cancelled");
});
