/** Transport adapters use this only when dispatch may have reached Eve. */
export class SubmissionOutcomeUnknownError extends Error {
  constructor() {
    super("The Eve transport cannot determine whether submission occurred.");
    this.name = "SubmissionOutcomeUnknownError";
  }
}
