export function assertAtomicReviewedChangeSetReuse(input: {
  latest: {
    phase: string;
    applyDigest?: string;
    validationDigest?: string;
    reviewReceipt?: unknown;
  };
  expectedApplyDigest: string;
  expectedValidationDigest: string;
  expectedReviewReceipt: unknown;
}): void {
  if (
    input.latest.phase !== "reviewed" ||
    input.latest.applyDigest !== input.expectedApplyDigest ||
    input.latest.validationDigest !== input.expectedValidationDigest ||
    JSON.stringify(input.latest.reviewReceipt) !==
      JSON.stringify(input.expectedReviewReceipt)
  )
    throw new Error(
      "The workflow changed concurrently before reviewed change-set reuse.",
    );
}
