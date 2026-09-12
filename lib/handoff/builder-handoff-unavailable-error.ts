export class BuilderHandoffUnavailableError extends Error {
  constructor() {
    super("This App Builder handoff is unavailable.");
    this.name = "BuilderHandoffUnavailableError";
  }
}
