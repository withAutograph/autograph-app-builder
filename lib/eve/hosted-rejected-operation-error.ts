export class HostedRejectedOperationError extends Error {
  readonly code: string;

  constructor(code = "operation_rejected") {
    super("The hosted Eve operation was rejected before a durable result.");
    this.name = "HostedRejectedOperationError";
    this.code = code;
  }
}
