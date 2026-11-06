import { sanitizeEvidence } from "./self-reproduction-evidence";

interface Credentials {
  token: string;
  teamId: string;
  projectId: string;
}

interface CandidateCapabilities {
  environment: Record<string, string>;
  receipt: { modelGateway: string; childSandbox: string; persistence: string };
}

type CandidateEvidence =
  | string
  | number
  | boolean
  | null
  | CandidateEvidence[]
  | { [key: string]: CandidateEvidence };

/** Caller owns project/expiry validation; this never reads the parent environment. */
export const candidateCapabilities = (credentials?: Credentials): CandidateCapabilities => ({
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
export const redactCandidateEvidence = (
  value: CandidateEvidence,
  secrets: readonly string[],
): CandidateEvidence => {
  const redact = (item: CandidateEvidence): CandidateEvidence => {
    if (item === null || item === true || item === false || Number.isFinite(item)) {
      return item;
    }
    if (typeof item === "string") {
      let text = item;
      for (const secret of secrets) {
        if (secret) {
          text = text.replaceAll(secret, "[REDACTED]");
        }
      }
      return text;
    }
    if (Array.isArray(item)) {
      return item.map((entry: unknown) => redact(entry as CandidateEvidence));
    }
    return Object.fromEntries(
      Object.entries(item).map(([key, entry]) => [key, redact(entry as CandidateEvidence)]),
    );
  };
  const sanitized = sanitizeEvidence(redact(value));
  return redact(sanitized);
};
