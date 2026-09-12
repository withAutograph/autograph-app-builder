/** Transport adapters may use this only when they prove dispatch did not run. */
export class SubmissionRejectedBeforeDispatchError extends Error {
  readonly code: string;

  constructor(code = "submission_rejected") {
    super("The Eve transport rejected the operation before dispatch.");
    this.name = "SubmissionRejectedBeforeDispatchError";
    this.code = code;
  }
}
