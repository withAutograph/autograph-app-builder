/** Mock routing must not reuse review failures from before current validation. */
export const currentReviewResults = <T extends { name: string }>(results: readonly T[]): T[] =>
  results.slice(results.findLastIndex(({ name }) => name === "validate_app_creation") + 1);
