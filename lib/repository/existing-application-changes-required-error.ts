export class ExistingApplicationChangesRequiredError extends Error {
  constructor() {
    super(
      "The requested application already exists. Inspect its app-owned source files, then retry target planning with exact replacement contents.",
    );
    this.name = "ExistingApplicationChangesRequiredError";
  }
}
