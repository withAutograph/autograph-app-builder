import { describe, expect, it } from "vitest";

import { assertAtomicReviewedChangeSetReuse } from "./reviewed-change-set-reuse";

const expected = {
  changeSetDigest: "b".repeat(64),
  digest: "a".repeat(64),
  reviewedByCallId: "review-call",
};

describe("reviewed change-set reuse", () => {
  const current = {
    expectedApplyDigest: "c".repeat(64),
    expectedReviewReceipt: expected,
    expectedValidationDigest: "d".repeat(64),
  };

  it("permits an unchanged reviewed receipt", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: {
          applyDigest: current.expectedApplyDigest,
          phase: "reviewed",
          reviewReceipt: expected,
          validationDigest: current.expectedValidationDigest,
        },
      })
    ).not.toThrow();
  });

  it("fails closed when artifact invalidation changes reviewed to prepared after recomputation", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: { phase: "prepared" },
      })
    ).toThrow("changed concurrently");
  });

  it("fails closed when a concurrent reviewed receipt differs", () => {
    expect(() =>
      assertAtomicReviewedChangeSetReuse({
        ...current,
        latest: {
          applyDigest: current.expectedApplyDigest,
          phase: "reviewed",
          reviewReceipt: { ...expected, digest: "e".repeat(64) },
          validationDigest: current.expectedValidationDigest,
        },
      })
    ).toThrow("changed concurrently");
  });
});
