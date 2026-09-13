import { sanitizeEvidence } from "./self-reproduction-evidence";

interface Credentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** Caller owns project/expiry validation; this never reads the parent environment. */
export function candidateCapabilities(credentials?: Credentials): {
  environment: Record<string, string>;
  receipt: { modelGateway: string; childSandbox: string; persistence: string };
} {
  return {
    environment: credentials
      ? {
          VERCEL_OIDC_TOKEN: credentials.token,
          VERCEL_TEAM_ID: credentials.teamId,
          VERCEL_PROJECT_ID: credentials.projectId,
        }
      : {},
    receipt: {
      modelGateway: credentials ? "configured-unverified" : "not-configured",
      childSandbox: credentials ? "configured-unverified" : "not-configured",
      persistence: "application-owned; no external database provisioned",
    },
  };
}

/** Redact complete diagnostics before serialization, including bare credential values. */
export function redactCandidateEvidence<T>(value: T, secrets: readonly string[]): T {
  const redact = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) {
        if (secret) text = text.replaceAll(secret, "[REDACTED]");
      }
      return text;
    }
    if (Array.isArray(item)) return item.map(redact);
    if (item && typeof item === "object")
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, redact(entry)]));
    return item;
  };
  return sanitizeEvidence(redact(value)) as T;
}
