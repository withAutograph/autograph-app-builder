/** A staged observation lost the active checkpoint digest comparison. */
export class HostedCheckpointObservationConflictError extends Error {
  constructor() {
    super("Hosted paged checkpoint observation raced another update.");
    this.name = "HostedCheckpointObservationConflictError";
  }
}
