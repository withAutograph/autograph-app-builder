export class HostedSessionNotFoundError extends Error {
  constructor() {
    super("The hosted Eve session was not found.");
    this.name = "HostedSessionNotFoundError";
  }
}

export class HostedAdapterSessionUnavailableError extends Error {
  constructor() {
    super("The underlying Eve session is unavailable.");
    this.name = "HostedAdapterSessionUnavailableError";
  }
}

export class HostedSessionRecoveryUnavailableError extends Error {
  constructor() {
    super("The App Builder session has no recoverable checkpoint.");
    this.name = "HostedSessionRecoveryUnavailableError";
  }
}

export class HostedSessionBusyError extends Error {
  constructor() {
    super("Another continuation is already active for this session.");
    this.name = "HostedSessionBusyError";
  }
}

export class HostedIdempotencyConflictError extends Error {
  constructor() {
    super("The client request identifier is already bound to another request.");
    this.name = "HostedIdempotencyConflictError";
  }
}

export class HostedSubmissionUnknownError extends Error {
  constructor() {
    super(
      "The hosted Eve submission outcome is unknown and will not be replayed.",
    );
    this.name = "HostedSubmissionUnknownError";
  }
}

export class HostedCancellationUnsettledError extends Error {
  constructor() {
    super("Cancellation was accepted but has not settled; use autograph_get.");
    this.name = "HostedCancellationUnsettledError";
  }
}

export class HostedRejectedOperationError extends Error {
  readonly code: string;

  constructor(code = "operation_rejected") {
    super("The hosted Eve operation was rejected before a durable result.");
    this.name = "HostedRejectedOperationError";
    this.code = code;
  }
}

/** Transport adapters use this only when dispatch may have reached Eve. */
export class SubmissionOutcomeUnknownError extends Error {
  constructor() {
    super("The Eve transport cannot determine whether submission occurred.");
    this.name = "SubmissionOutcomeUnknownError";
  }
}

/** Transport adapters may use this only when they prove dispatch did not run. */
export class SubmissionRejectedBeforeDispatchError extends Error {
  readonly code: string;

  constructor(code = "submission_rejected") {
    super("The Eve transport rejected the operation before dispatch.");
    this.name = "SubmissionRejectedBeforeDispatchError";
    this.code = code;
  }
}
