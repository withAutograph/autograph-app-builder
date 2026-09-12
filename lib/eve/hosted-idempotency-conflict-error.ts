export class HostedIdempotencyConflictError extends Error {
  constructor() {
    super("The client request identifier is already bound to another request.");
    this.name = "HostedIdempotencyConflictError";
  }
}
