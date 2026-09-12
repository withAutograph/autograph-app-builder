export class HostedSubmissionUnknownError extends Error {
  constructor() {
    super("The hosted Eve submission outcome is unknown and will not be replayed.");
    this.name = "HostedSubmissionUnknownError";
  }
}
