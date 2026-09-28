export class HostedSessionReadTimeoutError extends Error {
  constructor() {
    super(
      "The canonical Eve session stream did not deliver its complete durable tail before the read deadline.",
    );
    this.name = "HostedSessionReadTimeoutError";
  }
}
