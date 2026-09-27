export class HostedSubmissionUnknownError extends Error {
  constructor() {
    super("The hosted Eve submission outcome is unknown. Retry the exact request to check its durable result.");
    this.name = "HostedSubmissionUnknownError";
  }
}
