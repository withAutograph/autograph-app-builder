export class BuilderHandoffConflictError extends Error {
  constructor() {
    super("This App Builder handoff request is already bound.");
    this.name = "BuilderHandoffConflictError";
  }
}
