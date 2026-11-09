import { assertAuthProposalMigrationUrl } from "./hosted-operator-auth-proposal";
import { HostedOperatorError } from "./hosted-operator-contract";

/** Strengthen the existing server-only binding without changing its credential or target. */
export const normalizeProductionAuthMigrationUrl = (
  value: string,
  resource: Parameters<typeof assertAuthProposalMigrationUrl>[1],
): string => {
  let normalized = value;
  try {
    const url = new URL(value);
    // Check cardinality before set(): URLSearchParams.set would silently collapse duplicates.
    if (url.searchParams.getAll("sslmode").length !== 1) {
      throw new HostedOperatorError("resource_mismatch");
    }
    if (url.searchParams.get("sslmode") === "require") {
      url.searchParams.set("sslmode", "verify-full");
      normalized = url.toString();
    }
    // Keep the independent exact host/database/schema-owner role and query checks unchanged.
    assertAuthProposalMigrationUrl(normalized, resource);
  } catch {
    throw new HostedOperatorError("resource_mismatch");
  }
  return normalized;
};
