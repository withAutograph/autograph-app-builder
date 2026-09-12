import type { ProviderConnectionReturn } from "../integrations/provider-connection-return";
import type {
  GitHubCallbackDiagnostic,
  GitHubInstallationAuthorizationFailureStage,
  GitHubOAuthCallbackError,
  GitHubOAuthErrorCategory,
  GitHubStateValidationDiagnostic,
} from "./github-app-installation";

export class GitHubInstallationAuthorizationError extends Error {
  readonly stage: GitHubInstallationAuthorizationFailureStage;
  readonly category?: GitHubOAuthErrorCategory | GitHubOAuthCallbackError;
  readonly returnState?: ProviderConnectionReturn;
  readonly callback?: GitHubCallbackDiagnostic;
  readonly stateValidation?: GitHubStateValidationDiagnostic;

  constructor(
    stage: GitHubInstallationAuthorizationFailureStage,
    category?: GitHubOAuthErrorCategory | GitHubOAuthCallbackError,
    returnState?: ProviderConnectionReturn,
    callback?: GitHubCallbackDiagnostic,
    stateValidation?: GitHubStateValidationDiagnostic,
  ) {
    super("GitHub App installation authorization failed.");
    this.name = "GitHubInstallationAuthorizationError";
    this.stage = stage;
    this.category = category;
    this.returnState = returnState;
    this.callback = callback;
    this.stateValidation = stateValidation;
  }
}
