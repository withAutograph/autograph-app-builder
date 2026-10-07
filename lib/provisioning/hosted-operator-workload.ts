import { createRemoteJWKSet, jwtVerify } from "jose";
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
      throw new HostedOperatorError("authorization_required");
    }
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
      if (
        verified.payload.owner_id !== policy.ownerId ||
        verified.payload.project_id !== policy.projectId ||
        verified.payload.environment !== policy.environment
      ) {
        throw new HostedOperatorError("authorization_required");
      }
    } catch {
      throw new HostedOperatorError("authorization_required");
    }
  };
};
