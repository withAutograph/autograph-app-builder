import { sanitizeEvidence } from "./self-reproduction-evidence";

interface Credentials {
  token: string;
  teamId: string;
  projectId: string;
}

/** Caller owns project/expiry validation; this never reads the parent environment. */
export const candidateCapabilities = (
  credentials?: Credentials,
): {
  environment: Record<string, string>;
  receipt: { modelGateway: string; childSandbox: string; persistence: string };
} => ({
  environment: credentials
    ? {
        VERCEL_OIDC_TOKEN: credentials.token,
        VERCEL_PROJECT_ID: credentials.projectId,
        VERCEL_TEAM_ID: credentials.teamId,
      }
    : {},
  receipt: {
    childSandbox: credentials ? "configured-unverified" : "not-configured",
    modelGateway: credentials ? "configured-unverified" : "not-configured",
    persistence: "application-owned; no external database provisioned",
  },
});

/** Redact complete diagnostics before serialization, including bare credential values. */
export const redactCandidateEvidence = <T>(value: T, secrets: readonly string[]): T => {
  const redact = (item: unknown): unknown => {
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) {
        if (secret) {text = text.replaceAll(secret, "[REDACTED]");}
      }
      return text;
    }
    if (Array.isArray(item)) {return item.map(redact);}
    if (item && typeof item === "object")
      {return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, redact(entry)]));}
    return item;
  };
  return sanitizeEvidence(redact(value)) as T;
};
