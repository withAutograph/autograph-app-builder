export class HostedSessionReadTimeoutError extends Error {
  readonly progressPersisted: boolean;
  constructor(progressPersisted = false) {
    super(
      "The canonical Eve session stream did not deliver its complete durable tail before the read deadline.",
    );
    this.name = "HostedSessionReadTimeoutError";
    this.progressPersisted = progressPersisted;
  }
}
