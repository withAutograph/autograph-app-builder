import { createHash } from "node:crypto";
import { z } from "zod";

const boundary = z.enum(["builder", "operator"]);
const phase = z.enum(["inline", "check", "start", "complete"]);
const stage = z.enum([
  "configuration",
  "owner_context",
  "owner_configuration",
  "owner_authority",
  "owner_membership",
  "owner_session_binding",
  "client_construction",
  "principal",
  "operator_request",
  "operator_ingress",
  "workload_verification",
  "caller_workload",
  "inline_token",
  "current_owner",
  "operator_oidc",
  "callback",
  "provider_token",
  "provider_start",
]);
const outcome = z.enum([
  "started",
  "verified",
  "ready",
  "consent_required",
  "challenge_started",
  "operator_access_denied",
  "setup_unavailable",
  "control_flow_propagated",
]);
export const operatorWorkloadFailureSchema = z.strictObject({
  failedClaim: z
    .enum(["exp", "iat", "iss", "aud", "sub", "owner_id", "project_id", "environment"])
    .optional(),
  joseCode: z
    .enum([
      "ERR_JWT_CLAIM_VALIDATION_FAILED",
      "ERR_JWT_EXPIRED",
      "ERR_JWS_SIGNATURE_VERIFICATION_FAILED",
      "ERR_JWKS_NO_MATCHING_KEY",
      "ERR_JOSE_ALG_NOT_ALLOWED",
      "ERR_JWKS_TIMEOUT",
    ])
    .optional(),
  reason: z.enum([
    "missing_authorization",
    "verification_failed",
    "policy_owner_mismatch",
    "policy_project_mismatch",
    "policy_environment_mismatch",
  ]),
});
export type OperatorWorkloadFailure = z.infer<typeof operatorWorkloadFailureSchema>;

const callerEnvironment = z.enum(["development", "preview", "production"]);
export const operatorCallerWorkloadSchema = z.strictObject({
  environmentMatches: z.boolean().optional(),
  projectMatches: z.boolean().optional(),
  runtimeEnvironment: callerEnvironment.optional(),
  signatureVerified: z.literal(true).optional(),
  source: z.enum(["request_context", "environment", "unknown"]),
  teamMatches: z.boolean().optional(),
  tokenEnvironment: callerEnvironment.optional(),
  verification: z.enum(["verified", "failed", "unavailable"]),
});
export type OperatorCallerWorkload = z.infer<typeof operatorCallerWorkloadSchema>;

const metadata = z.strictObject({
  accessClass: z
    .enum(["upstream_auth_denied", "application_auth_denied", "other_failed", "ok"])
    .optional(),
  boundary,
  callerWorkload: operatorCallerWorkloadSchema.optional(),
  httpStatus: z.number().int().min(100).max(599).optional(),
  outcome,
  phase,
  stage,
  vercelError: z.literal("TRUSTED_SOURCES_ENVIRONMENT_MISMATCH").optional(),
  workloadFailure: operatorWorkloadFailureSchema.optional(),
});
export type HostedOperatorConsentMetadata = z.infer<typeof metadata>;
export type HostedOperatorConsentDiagnostic = HostedOperatorConsentMetadata & {
  event: "builder.hosted_neon_consent";
  sessionIdHash: string;
};
export type HostedOperatorConsentDiagnosticSink = (
  value: HostedOperatorConsentDiagnostic,
) => void | Promise<void>;

/** Closed metadata only. Never receives exceptions, URLs, inputs, outputs or credentials. */
export const createHostedOperatorConsentDiagnostic = (
  sessionId: string,
  sink?: HostedOperatorConsentDiagnosticSink,
) => {
  let sessionIdHash: string;
  try {
    sessionIdHash = `sha256:${createHash("sha256").update(sessionId).digest("hex")}`;
  } catch {
    return (_value: HostedOperatorConsentMetadata) => {
      /* Diagnostics are unavailable; authorization remains unchanged. */
    };
  }
  return (value: HostedOperatorConsentMetadata) => {
    try {
      const parsed = metadata.safeParse(value);
      if (!parsed.success) {
        return;
      }
      const diagnostic: HostedOperatorConsentDiagnostic = {
        ...parsed.data,
        event: "builder.hosted_neon_consent",
        sessionIdHash,
      };
      if (sink === undefined) {
        console.info("[builder:hosted-neon-consent]", diagnostic);
      } else {
        const deliver = async () => {
          try {
            await sink(diagnostic);
          } catch {
            /* Diagnostic only. */
          }
        };
        void deliver();
      }
    } catch {
      /* Diagnostics never change authorization or pause behavior. */
    }
  };
};
