/** Mock routing must not reuse review failures from before current validation. */
export const currentReviewResults = <T extends { name: string }>(results: readonly T[]): T[] =>
  results.slice(results.findLastIndex(({ name }) => name === "validate_app_creation") + 1);

export const unavailableReviewReply = (phase: unknown): string | undefined => {
  if (phase === "validated" || phase === "reviewed") {
    return undefined;
  }
  if (phase === "validation_failed") {
    return "The app did not pass its quality checks, so there is no validated change set to review.";
  }
  if (phase === "validation_pending") {
    return "The app checks did not finish, so there is no validated change set to review yet.";
  }
  return "The app must pass its quality checks before I can prepare a change set for review.";
};
