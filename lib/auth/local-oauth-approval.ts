import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { ProviderEmulation } from "../integrations/local-provider-emulation";

export const localOAuthProviderSchema = z.enum(["github", "vercel"]);
export type LocalOAuthProvider = z.infer<typeof localOAuthProviderSchema>;

const scalar = z.string().min(1).max(2_048);
const authorizationSchema = z
  .object({
    response_type: z.literal("code"),
    client_id: scalar,
    state: z.string().min(20).max(512),
    scope: z.string().max(1_024).default(""),
    redirect_uri: z.string().url().max(2_048),
    code_challenge: z.string().min(20).max(256).optional(),
    code_challenge_method: z.literal("S256").optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (
      Boolean(value.code_challenge) !== Boolean(value.code_challenge_method)
    ) {
      context.addIssue({
        code: "custom",
        message: "PKCE challenge and method must be supplied together.",
      });
    }
  });

export type LocalOAuthAuthorization = z.infer<typeof authorizationSchema>;

const approvalRelaySchema = z
  .object({
    provider: localOAuthProviderSchema,
    origin: z.string().url(),
    authorization: authorizationSchema,
    expiresAt: z.number().int().positive(),
  })
  .strict();

export function signLocalOAuthApproval(
  input: z.infer<typeof approvalRelaySchema>,
  secret: string,
) {
  const payload = Buffer.from(
    JSON.stringify(approvalRelaySchema.parse(input)),
  ).toString("base64url");
  const signature = createHmac("sha256", secret)
    .update(payload)
    .digest("base64url");
  return `${payload}.${signature}`;
}

export function signFreshLocalOAuthApproval(
  input: Omit<z.infer<typeof approvalRelaySchema>, "expiresAt">,
  secret: string,
) {
  return signLocalOAuthApproval(
    { ...input, expiresAt: Date.now() + 5 * 60_000 },
    secret,
  );
}

export function verifyLocalOAuthApproval(
  value: string,
  secret: string,
  now = Date.now(),
) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) throw new Error("invalid-approval");
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (
    provided.length !== expected.length ||
    !timingSafeEqual(provided, expected)
  )
    throw new Error("invalid-approval");
  const result = approvalRelaySchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf8")),
  );
  if (result.expiresAt <= now) throw new Error("expired-approval");
  return result;
}

export function parseLocalOAuthAuthorization(input: {
  provider: string;
  values: Record<string, string | undefined>;
  appOrigin: string;
  emulation: ProviderEmulation;
  githubClientId: string;
  vercelClientId: string;
}): { provider: LocalOAuthProvider; authorization: LocalOAuthAuthorization } {
  const provider = localOAuthProviderSchema.parse(input.provider);
  const authorization = authorizationSchema.parse(input.values);
  const expectedClientId =
    provider === "github" ? input.githubClientId : input.vercelClientId;
  if (
    authorization.client_id !== expectedClientId ||
    authorization.redirect_uri !==
      `${input.appOrigin}/api/auth/callback/${provider}`
  ) {
    throw new Error("Local OAuth authorization binding is invalid.");
  }
  return { provider, authorization };
}

export function localOAuthProviderDetails(provider: LocalOAuthProvider) {
  return provider === "github"
    ? {
        name: "GitHub",
        account: "Autograph Developer",
        handle: "@autograph-dev",
        scope: "Read your profile and verified email address",
      }
    : {
        name: "Vercel",
        account: "Autograph Developer",
        handle: "autograph-dev",
        scope: "Read your profile and verified email address",
      };
}
