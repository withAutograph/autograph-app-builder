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
const metadata = z.strictObject({
  boundary,
  httpStatus: z.number().int().min(100).max(599).optional(),
  outcome,
  phase,
  stage,
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
