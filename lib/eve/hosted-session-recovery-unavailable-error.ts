export class HostedSessionRecoveryUnavailableError extends Error {
  constructor() {
    super("The App Builder session has no recoverable checkpoint.");
    this.name = "HostedSessionRecoveryUnavailableError";
  }
}
