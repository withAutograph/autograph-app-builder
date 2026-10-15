/* oxlint-disable eslint/require-await -- Faithful asynchronous observation and judge test doubles. */
import { expect, it, vi } from "vitest";
import {
  currentChangedSourcePaths,
  reviewObservedProductSource,
  sourceReviewScopeBindingDigest,
} from "./review-applied-product-source";
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
it("reviews every current normalized path, including repairs and supporting source", () => {
  const changes = [
    { kind: "modified" as const, path: "apps/example/page.tsx" },
    { kind: "added" as const, path: "apps/example/error.tsx" },
    { kind: "modified" as const, path: ".config/app-specs/example.cue" },
    { kind: "added" as const, path: "apps/example/schema/release/v2/manifest.json" },
    { kind: "modified" as const, path: "packages/shared/runtime.ts" },
    { kind: "deleted" as const, path: "apps/example/demo.tsx" },
  ];
  expect(currentChangedSourcePaths(changes)).toEqual([
    "apps/example/page.tsx",
    "apps/example/error.tsx",
    ".config/app-specs/example.cue",
    "apps/example/schema/release/v2/manifest.json",
    "packages/shared/runtime.ts",
  ]);
});
it("keeps aggregate cache bindings distinct when review scope changes on the same source tree", () => {
  const first = [{ kind: "added" as const, path: "apps/example/page.tsx" }];
  const expanded = [...first, { kind: "added" as const, path: "apps/example/error.tsx" }];
  expect(sourceReviewScopeBindingDigest(reviewInput, first)).toBe(
    sourceReviewScopeBindingDigest(reviewInput, [...first]),
  );
  expect(sourceReviewScopeBindingDigest(reviewInput, first)).not.toBe(
    sourceReviewScopeBindingDigest(reviewInput, expanded),
  );
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
