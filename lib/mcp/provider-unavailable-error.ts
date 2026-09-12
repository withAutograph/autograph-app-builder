export class McpProviderUnavailableError extends Error {
  constructor() {
    super("Provider access is temporarily unavailable.");
    this.name = "McpProviderUnavailableError";
  }
}
