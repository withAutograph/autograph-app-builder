import { z } from "zod";

export const hostedIdentifierSchema = z
  .string()
  .min(1)
  .max(200)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/);

/**
 * Closed projection produced only after an adapter has verified the token's
 * signature, expiry, not-before time, and issuer key material.
 */
export const verifiedHostedClaimsSchema = z
  .object({
    audience: z.string().min(1).max(300),
    issuer: z.string().url(),
    scopes: z.array(z.string().min(1).max(100)).min(1).max(50),
    subject: hostedIdentifierSchema,
    workspaceId: hostedIdentifierSchema,
  })
  .strict();

export type VerifiedHostedClaims = z.infer<typeof verifiedHostedClaimsSchema>;

export const hostedPrincipalSchema = z
  .object({
    audience: z.string().min(1).max(300),
    issuer: z.string().url(),
    ownerUserId: hostedIdentifierSchema,
    scopes: z.array(z.string().min(1).max(100)).min(1).max(50),
    workspaceId: hostedIdentifierSchema,
  })
  .strict();

export type HostedPrincipal = z.infer<typeof hostedPrincipalSchema>;

export const hostedEveOperationScopes = {
  cancel: "autograph:cancel",
  get: "autograph:get",
  respond: "autograph:respond",
  send: "autograph:send",
  start: "autograph:start",
} as const;

export type HostedEveOperation = keyof typeof hostedEveOperationScopes;

export class HostedAuthorizationError extends Error {
  readonly code:
    | "invalid_claims"
    | "issuer_mismatch"
    | "audience_mismatch"
    | "insufficient_scope";

  constructor(code: HostedAuthorizationError["code"]) {
    super("The hosted Eve request is not authorized.");
    this.name = "HostedAuthorizationError";
    this.code = code;
  }
}

export function authorizeHostedPrincipal(input: {
  verifiedClaims: unknown;
  expectedIssuer: string;
  expectedAudience: string;
  requiredScopes: readonly string[];
}): HostedPrincipal {
  const parsed = verifiedHostedClaimsSchema.safeParse(input.verifiedClaims);
  if (!parsed.success) {
    throw new HostedAuthorizationError("invalid_claims");
  }

  const claims = parsed.data;
  if (claims.issuer !== input.expectedIssuer) {
    throw new HostedAuthorizationError("issuer_mismatch");
  }
  if (claims.audience !== input.expectedAudience) {
    throw new HostedAuthorizationError("audience_mismatch");
  }
  const scopes = [...new Set(claims.scopes)].sort();
  if (input.requiredScopes.some((scope) => !scopes.includes(scope))) {
    throw new HostedAuthorizationError("insufficient_scope");
  }

  return hostedPrincipalSchema.parse({
    audience: claims.audience,
    issuer: claims.issuer,
    ownerUserId: claims.subject,
    scopes,
    workspaceId: claims.workspaceId,
  });
}

export function tenantKeyFor(principal: HostedPrincipal): string {
  return JSON.stringify([
    principal.issuer,
    principal.audience,
    principal.workspaceId,
    principal.ownerUserId,
  ]);
}

export function requireHostedOperationScope(
  principal: HostedPrincipal,
  operation: HostedEveOperation
): void {
  if (!principal.scopes.includes(hostedEveOperationScopes[operation])) {
    throw new HostedAuthorizationError("insufficient_scope");
  }
}
