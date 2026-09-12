import type { GitHubStateValidationDiagnostic } from "./github-app-installation";

export class GitHubStateValidationError extends Error {
  readonly diagnostic: GitHubStateValidationDiagnostic;

  constructor(diagnostic: GitHubStateValidationDiagnostic) {
    super("invalid-state");
    this.name = "GitHubStateValidationError";
    this.diagnostic = diagnostic;
  }
}
