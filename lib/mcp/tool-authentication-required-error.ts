export class McpToolAuthenticationRequiredError extends Error {
  readonly challenge: string;

  constructor(challenge: string) {
    super("Authentication is required before calling this tool.");
    this.challenge = challenge;
    this.name = "McpToolAuthenticationRequiredError";
  }
}
