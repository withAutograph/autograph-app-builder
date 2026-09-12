export class HostedCancellationUnsettledError extends Error {
  constructor() {
    super("Cancellation was accepted but has not settled; use autograph_get.");
    this.name = "HostedCancellationUnsettledError";
  }
}
