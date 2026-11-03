import { vercelProvisionDiagnosticSchema } from "./contracts";
import type { VercelProvisionDiagnostic } from "./contracts";

/** Only allowlisted support facts cross this boundary; no raw provider error is retained. */
export class PublicReleaseProviderError extends Error {
  readonly diagnostic: VercelProvisionDiagnostic;

  constructor(diagnostic: VercelProvisionDiagnostic) {
    super("public_release_provider_rejected");
    this.name = "PublicReleaseProviderError";
    this.diagnostic = vercelProvisionDiagnosticSchema.parse(diagnostic);
  }
}
