import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";

const identifier = z
  .string()
  .min(1)
  .refine((value) => !/[\p{Cc}]/u.test(value));
const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const origin = z.string().refine((value) => {
  try {
    const url = new URL(value);
    return value === url.origin && url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
});
const publicKey = z.strictObject({
  alg: z.literal("EdDSA"),
  crv: z.literal("Ed25519"),
  kid: identifier,
  kty: z.literal("OKP"),
  use: z.literal("sig"),
  x: z
    .string()
    .refine(
      (value) =>
        /^[A-Za-z0-9_-]{43}$/u.test(value) &&
        Buffer.from(value, "base64url").length === 32 &&
        Buffer.from(value, "base64url").toString("base64url") === value,
    ),
});
/** Wire-compatible with Arrusted's managed public verification adapter; no private JWK fields. */
export const managedRuntimePublicProfileSchema = z
  .strictObject({
    appId: identifier,
    jwksUrl: z.url(),
    keys: z.array(publicKey).min(1),
    publicOrigin: origin,
    version: z.literal(1),
  })
  .superRefine((value, ctx) => {
    if (
      value.jwksUrl !== `${value.publicOrigin}/_platform/jwks.json` ||
      new Set(value.keys.map((key) => key.kid)).size !== value.keys.length
    ) {
      ctx.addIssue({ code: "custom", message: "Managed public verification profile differs" });
    }
  });
export type ManagedRuntimePublicProfile = z.infer<typeof managedRuntimePublicProfileSchema>;
export const managedRuntimeOwnerSchema = z.strictObject({
  audience: identifier,
  issuer: identifier,
  ownerUserId: identifier,
  sessionId: identifier,
  workspaceId: identifier,
});
export const managedRuntimeIdentitySchema = z.strictObject({
  appId: identifier,
  approvalRef: identifier,
  fence: z.number().int().positive().refine(Number.isSafeInteger),
  intentId: z.uuid(),
  owner: managedRuntimeOwnerSchema,
  providerSessionId: identifier,
  runtimeAttemptId: z.uuid(),
  sandboxId: identifier,
});
export type ManagedRuntimeIdentity = z.infer<typeof managedRuntimeIdentitySchema>;
export const managedRuntimeCurrentSchema = managedRuntimeIdentitySchema.extend({
  leaseExpiresAt: z.iso.datetime(),
  state: z.enum([
    "starting",
    "ready",
    "restarting",
    "revoked",
    "expired",
    "reconciliation-required",
  ]),
});
export type ManagedRuntimeCurrent = z.infer<typeof managedRuntimeCurrentSchema>;
export const managedCapabilitySha256 = (value: string) =>
  createHash("sha256").update(value).digest("hex");
const capability = z
  .string()
  .regex(/^[A-Za-z0-9_-]{43}$/u)
  .refine(
    (value) =>
      Buffer.from(value, "base64url").length === 32 &&
      Buffer.from(value, "base64url").toString("base64url") === value,
  );
/** Trusted host custody only. These bearer values must never become workflow/model results or app environment. */
export const createPrivateManagedRuntimeCapabilities = () => {
  const suiteSelector = randomBytes(32).toString("base64url");
  const transport = randomBytes(32).toString("base64url");
  const lifecycle = randomBytes(32).toString("base64url");
  return {
    lifecycleSha256: managedCapabilitySha256(lifecycle),
    private: { lifecycle, suiteSelector, transport },
    projection: {
      suiteSelectorSha256: managedCapabilitySha256(suiteSelector),
      transportSha256: managedCapabilitySha256(transport),
    },
  };
};
export const verifyManagedCapability = (bearer: string | undefined, expectedSha256: string) => {
  const parsed = capability.safeParse(bearer);
  const expected = digest.safeParse(expectedSha256);
  return (
    parsed.success &&
    expected.success &&
    timingSafeEqual(
      Buffer.from(managedCapabilitySha256(parsed.data), "hex"),
      Buffer.from(expected.data, "hex"),
    )
  );
};
/** One explicit host-owned public read. No provider/signing/Auth credential is returned to the runtime. */
export const readManagedRuntimePublicProfile = async (input: {
  appId: string;
  publicOrigin: string;
  // oxlint-disable-next-line anti-slop/no-unknown-returns -- Public network JSON is parsed into the closed public-key schema at this boundary.
  readPublicJwks: (url: string) => Promise<unknown>;
}) => {
  const publicOrigin = origin.parse(input.publicOrigin);
  const jwksUrl = `${publicOrigin}/_platform/jwks.json`;
  const document = z
    .strictObject({ keys: z.array(publicKey).min(1) })
    .parse(await input.readPublicJwks(jwksUrl));
  return managedRuntimePublicProfileSchema.parse({
    appId: input.appId,
    jwksUrl,
    keys: document.keys,
    publicOrigin,
    version: 1,
  });
};
