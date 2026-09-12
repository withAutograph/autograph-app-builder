export class HostedAdapterSessionUnavailableError extends Error {
  constructor() {
    super("The underlying Eve session is unavailable.");
    this.name = "HostedAdapterSessionUnavailableError";
  }
}
