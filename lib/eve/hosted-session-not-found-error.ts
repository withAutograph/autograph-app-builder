export class HostedSessionNotFoundError extends Error {
  constructor() {
    super("The hosted Eve session was not found.");
    this.name = "HostedSessionNotFoundError";
  }
}
