import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import type { JWTVerifyGetKey } from "jose";
import { z } from "zod";
import { HostedOperatorError } from "./hosted-operator-contract";

const hash = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.string().min(1).max(512);
export const realmPhysicalResourceSchema = z.strictObject({
  database: id,
  environment: z.enum(["local", "preview", "production"]),
  hostname: id,
  migratorRole: id,
  neon: z.strictObject({ branchId: id, projectId: id }).optional(),
  port: z.number().int().min(1).max(65_535),
  runtimeRole: id,
  schema: z.literal("public"),
  version: z.literal(1),
});
export const realmLinkClaimsSchema = z.strictObject({
  aud: z.url(),
  authResourceId: id,
  bootstrapPlanDigest: hash,
  exp: z.number().int().nonnegative(),
  iat: z.number().int().nonnegative(),
  iss: z.url(),
  nonceSha256: hash,
  organizationId: id.nullable(),
  ownerSessionId: id,
  purpose: z.literal("realm-operator-link-v1"),
  resource: realmPhysicalResourceSchema,
  sessionId: id,
  sub: id,
});
export const pendingRealmIdentityLinkSchema = z.object({
  audience: z.url(),
  authResourceId: id,
  bootstrapPlanDigest: hash,
  browserOrigin: z.url(),
  consumedAt: z.iso.datetime({ offset: true }).optional(),
  endpointOrigin: z.url(),
  expiresAt: z.iso.datetime({ offset: true }),
  issuer: z.url(),
  nonceSha256: hash,
  organizationId: id.nullable(),
  ownerSessionId: id,
  proofRef: id.optional(),
  proofSha256: hash.optional(),
});
export type PendingRealmIdentityLink = z.infer<typeof pendingRealmIdentityLinkSchema>;
const nativeIdentitySchema = z.strictObject({
  actorId: id,
  expiresAt: z.iso.datetime({ offset: true }),
  organizationId: id.nullable(),
  sessionId: id,
  version: z.literal(1),
});

export const realmIdentityNonceSha256 = (nonce: string): string =>
  createHash("sha256").update(hash.parse(nonce)).digest("hex");
const sameResource = (
  left: z.infer<typeof realmPhysicalResourceSchema>,
  right: z.infer<typeof realmPhysicalResourceSchema>,
) =>
  [
    left.environment === right.environment,
    left.hostname === right.hostname,
    left.port === right.port,
    left.database === right.database,
    left.schema === right.schema,
    left.runtimeRole === right.runtimeRole,
    left.migratorRole === right.migratorRole,
    left.neon?.projectId === right.neon?.projectId,
    left.neon?.branchId === right.neon?.branchId,
  ].every(Boolean);

/** Verification config comes only from the exact pending canonical nonce, never from the token's issuer or resource. */
const verifySignedRealmIdentityProof = async (input: {
  proof: string;
  pending: PendingRealmIdentityLink;
  resource: z.infer<typeof realmPhysicalResourceSchema>;
  getKey: JWTVerifyGetKey;
  now?: Date;
}) => {
  const pending = pendingRealmIdentityLinkSchema.parse(input.pending);
  const now = input.now ?? new Date();
  if (Date.parse(pending.expiresAt) <= now.getTime()) {
    throw new HostedOperatorError("auth_identity_required");
  }
  const result = await jwtVerify(input.proof, input.getKey, {
    algorithms: ["EdDSA"],
    audience: pending.audience,
    currentDate: now,
    issuer: pending.issuer,
    maxTokenAge: 240,
    requiredClaims: ["iat", "exp", "sub"],
    typ: "autograph-realm-operator-link+jwt",
  });
  const claims = realmLinkClaimsSchema.parse(result.payload);
  const matches = [
    claims.ownerSessionId === pending.ownerSessionId,
    claims.authResourceId === pending.authResourceId,
    claims.bootstrapPlanDigest === pending.bootstrapPlanDigest,
    claims.nonceSha256 === pending.nonceSha256,
    claims.organizationId === pending.organizationId,
    claims.iat <= Math.floor(now.getTime() / 1000),
    claims.exp > claims.iat,
    claims.exp - claims.iat <= 240,
    sameResource(claims.resource, realmPhysicalResourceSchema.parse(input.resource)),
  ].every(Boolean);
  if (!matches) {
    throw new HostedOperatorError("auth_identity_required");
  }
  return claims;
};

export const verifyRealmIdentityLinkProof = async (
  input: Parameters<typeof verifySignedRealmIdentityProof>[0] & { nonce: string },
) => {
  if (
    input.pending.consumedAt !== undefined ||
    realmIdentityNonceSha256(input.nonce) !== input.pending.nonceSha256
  ) {
    throw new HostedOperatorError("auth_identity_required");
  }
  return await verifySignedRealmIdentityProof(input);
};

/** Uses the configured trusted HTTP/OIDC reader; no Realm cookies, SQL URLs or admin credentials enter Builder. */
export const readVerifiedRealmAccess = async (input: {
  nonce?: string;
  resource: z.infer<typeof realmPhysicalResourceSchema>;
  getKey: JWTVerifyGetKey;
  pending: PendingRealmIdentityLink;
  readback: (request: Request) => Promise<Response>;
  proof: string;
  assertCurrent: () => Promise<void>;
}) => {
  await input.assertCurrent();
  const captured = input.pending.consumedAt !== undefined;
  if (captured) {
    const proofSha256 = createHash("sha256").update(input.proof).digest("hex");
    if (input.pending.proofRef === undefined || input.pending.proofSha256 !== proofSha256) {
      throw new HostedOperatorError("auth_identity_required");
    }
  } else if (
    input.nonce === undefined ||
    realmIdentityNonceSha256(input.nonce) !== input.pending.nonceSha256
  ) {
    throw new HostedOperatorError("auth_identity_required");
  }
  const claims = await verifySignedRealmIdentityProof(input);
  const url = new URL(
    "/api/auth/platform/operator-identity/readback",
    input.pending.endpointOrigin,
  );
  const response = await input.readback(
    new Request(url, {
      body: new URLSearchParams({ proof: input.proof }),
      headers: { "content-type": "application/x-www-form-urlencoded" },
      method: "POST",
      redirect: "error",
    }),
  );
  if (response.status !== 200 || response.redirected) {
    throw new HostedOperatorError("auth_identity_required");
  }
  const result = z
    .strictObject({ identity: nativeIdentitySchema, resource: realmPhysicalResourceSchema })
    .parse(await response.json());
  const matches = [
    result.identity.actorId === claims.sub,
    result.identity.sessionId === claims.sessionId,
    result.identity.organizationId === claims.organizationId,
    Date.parse(result.identity.expiresAt) > Date.now(),
    sameResource(result.resource, claims.resource),
  ].every(Boolean);
  if (!matches) {
    throw new HostedOperatorError("auth_identity_required");
  }
  await input.assertCurrent();
  return { claims, identity: result.identity };
};

/** Only a nonce returned by the existing owner-bound pending journal may form the ordinary Auth UI link. */
export const createRealmIdentityBrowserUrl = (input: {
  link: PendingRealmIdentityLink;
  nonce: string;
}): string => {
  const link = pendingRealmIdentityLinkSchema.parse(input.link);
  const browser = new URL(link.browserOrigin);
  const current = [
    browser.protocol === "https:",
    browser.origin === link.browserOrigin,
    browser.username === "",
    browser.password === "",
    link.consumedAt === undefined,
    Date.parse(link.expiresAt) > Date.now(),
    realmIdentityNonceSha256(input.nonce) === link.nonceSha256,
  ].every(Boolean);
  if (!current) {
    throw new HostedOperatorError("auth_identity_required");
  }
  const url = new URL("/api/auth/platform/operator-link", browser);
  url.searchParams.set("nonce", input.nonce);
  url.searchParams.set("ownerSessionId", link.ownerSessionId);
  url.searchParams.set("bootstrapPlanDigest", link.bootstrapPlanDigest);
  url.searchParams.set("authResourceId", link.authResourceId);
  if (link.organizationId !== null) {
    url.searchParams.set("organizationId", link.organizationId);
  }
  return url.toString();
};
