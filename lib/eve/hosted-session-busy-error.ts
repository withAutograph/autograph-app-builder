export class HostedSessionBusyError extends Error {
  constructor() {
    super("Another continuation is already active for this session.");
    this.name = "HostedSessionBusyError";
  }
}
