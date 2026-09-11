import { describe, expect, it } from "vitest";

import { assertAtomicReviewedChangeSetReuse } from "./reviewed-change-set-reuse";

const expected = {
  digest: "a".repeat(64),
  changeSetDigest: "b".repeat(64),
  reviewedByCallId: "review-call",
};

describe("reviewed change-set reuse", () => {
  const current = {
    expectedApplyDigest: "c".repeat(64),
    expectedValidationDigest: "d".repeat(64),
    expectedReviewReceipt: expected,
  };

  it("permits an unchanged reviewed receipt", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: {
          phase: "reviewed",
          applyDigest: current.expectedApplyDigest,
          validationDigest: current.expectedValidationDigest,
          reviewReceipt: expected,
        },
      }),
    ).not.toThrow();
  });

  it("fails closed when artifact invalidation changes reviewed to prepared after recomputation", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: { phase: "prepared" },
      }),
    ).toThrow("changed concurrently");
  });

  it("fails closed when a concurrent reviewed receipt differs", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: {
          phase: "reviewed",
          applyDigest: current.expectedApplyDigest,
          validationDigest: current.expectedValidationDigest,
          reviewReceipt: { ...expected, digest: "e".repeat(64) },
        },
      }),
    ).toThrow("changed concurrently");
  });
});
