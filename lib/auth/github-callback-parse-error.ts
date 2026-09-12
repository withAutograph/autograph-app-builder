type CallbackParseReason = "duplicate-key" | "state-format" | "callback-shape" | "code-format";

export class GitHubCallbackParseError extends Error {
  readonly reason: CallbackParseReason;

  constructor(reason: CallbackParseReason) {
    super("invalid-callback");
    this.name = "GitHubCallbackParseError";
    this.reason = reason;
  }
}
