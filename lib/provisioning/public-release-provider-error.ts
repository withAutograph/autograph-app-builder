import { publicReleaseProviderDiagnosticSchema } from "./public-release-provider-diagnostic";
import type { PublicReleaseProviderDiagnostic } from "./public-release-provider-diagnostic";

/** Only allowlisted support facts cross this boundary; no raw provider error is retained. */
export class PublicReleaseProviderError extends Error {
  readonly diagnostic: PublicReleaseProviderDiagnostic;

  constructor(diagnostic: PublicReleaseProviderDiagnostic) {
    super("public_release_provider_rejected");
    this.name = "PublicReleaseProviderError";
    this.diagnostic = publicReleaseProviderDiagnosticSchema.parse(diagnostic);
  }
}
