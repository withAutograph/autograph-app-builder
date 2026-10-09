import { operatorWorkloadFailureSchema } from "./hosted-operator-consent-diagnostic";
import type { OperatorWorkloadFailure } from "./hosted-operator-consent-diagnostic";
import { createRemoteJWKSet, errors, jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";

const workloadPolicySchema = z.strictObject({
  audience: z.url().startsWith("https://vercel.com/"),
  environment: z.enum(["development", "preview", "production"]),
  issuer: z.string().regex(/^https:\/\/oidc\.vercel\.com(?:\/[A-Za-z0-9_-]+)?$/u),
  ownerId: z.string().min(1),
  projectId: z.string().min(1),
  subject: z.string().min(1),
});
export type OperatorWorkloadPolicy = z.infer<typeof workloadPolicySchema>;

const workloadFailures = new WeakMap<HostedOperatorError, OperatorWorkloadFailure>();
/** Diagnostics stay private to this process; the error itself keeps its existing public shape. */
export const createOperatorWorkloadAuthorizationError = (
  workloadFailure: OperatorWorkloadFailure,
) => {
  const error = new HostedOperatorError("authorization_required");
  workloadFailures.set(error, operatorWorkloadFailureSchema.parse(workloadFailure));
  return error;
};
export const operatorWorkloadFailureFor = (error: HostedOperatorError) =>
  workloadFailures.get(error);

/** Exact trusted Builder workload policy, configured by the separate operator deployment. */
export const createOperatorWorkloadVerifier = (
  input: OperatorWorkloadPolicy,
  keyResolver?: JWTVerifyGetKey,
) => {
  const policy = workloadPolicySchema.parse(input);
  const keys = keyResolver ?? createRemoteJWKSet(new URL(`${policy.issuer}/.well-known/jwks`));
  return async (request: Request): Promise<void> => {
    const authorization = request.headers.get("authorization");
    if (authorization === null || !authorization.startsWith("Bearer ")) {
      throw createOperatorWorkloadAuthorizationError({ reason: "missing_authorization" });
    }
    let reason: OperatorWorkloadFailure["reason"] = "verification_failed";
    try {
      const verified = await jwtVerify(authorization.slice(7), keys, {
        algorithms: ["RS256"],
        audience: policy.audience,
        issuer: policy.issuer,
        requiredClaims: [
          "exp",
          "iat",
          "iss",
          "aud",
          "sub",
          "owner_id",
          "project_id",
          "environment",
        ],
        subject: policy.subject,
      });
      if (verified.payload.owner_id !== policy.ownerId) {
        reason = "policy_owner_mismatch";
        throw new HostedOperatorError("authorization_required");
      }
      if (verified.payload.project_id !== policy.projectId) {
        reason = "policy_project_mismatch";
        throw new HostedOperatorError("authorization_required");
      }
      if (verified.payload.environment !== policy.environment) {
        reason = "policy_environment_mismatch";
        throw new HostedOperatorError("authorization_required");
      }
    } catch (error) {
      const workloadFailure: OperatorWorkloadFailure = { reason };
      try {
        if (error instanceof errors.JOSEError) {
          const joseCode = operatorWorkloadFailureSchema.shape.joseCode.safeParse(error.code);
          if (joseCode.success && joseCode.data !== undefined) {
            workloadFailure.joseCode = joseCode.data;
          }
        }
        if (
          error instanceof errors.JWTClaimValidationFailed ||
          error instanceof errors.JWTExpired
        ) {
          const failedClaim = operatorWorkloadFailureSchema.shape.failedClaim.safeParse(
            error.claim,
          );
          if (failedClaim.success && failedClaim.data !== undefined) {
            workloadFailure.failedClaim = failedClaim.data;
          }
        }
      } catch {
        /* Unreadable diagnostic fields never change the authorization denial. */
      }
      throw createOperatorWorkloadAuthorizationError(workloadFailure);
    }
  };
};
