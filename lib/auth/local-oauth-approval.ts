import { createHmac, timingSafeEqual } from "node:crypto";

import { z } from "zod";

import type { ProviderEmulation } from "../integrations/local-provider-emulation";

export const localOAuthProviderSchema = z.enum(["github", "vercel"]);
export type LocalOAuthProvider = z.infer<typeof localOAuthProviderSchema>;

const scalar = z.string().min(1).max(2048);
const authorizationSchema = z
  .strictObject({
    client_id: scalar,
    code_challenge: z.string().min(20).max(256).optional(),
    code_challenge_method: z.literal("S256").optional(),
    redirect_uri: z.url().max(2048),
    response_type: z.literal("code"),
    scope: z.string().max(1024).default(""),
    state: z.string().min(20).max(512),
  })
  .superRefine((value, context) => {
    if (Boolean(value.code_challenge) !== Boolean(value.code_challenge_method)) {
      context.addIssue({
        code: "custom",
        message: "PKCE challenge and method must be supplied together.",
      });
    }
  });

export type LocalOAuthAuthorization = z.infer<typeof authorizationSchema>;

const approvalRelaySchema = z.strictObject({
  authorization: authorizationSchema,
  expiresAt: z.number().int().positive(),
  origin: z.url(),
  provider: localOAuthProviderSchema,
});

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function signLocalOAuthApproval(input: z.infer<typeof approvalRelaySchema>, secret: string) {
  const payload = Buffer.from(JSON.stringify(approvalRelaySchema.parse(input))).toString(
    "base64url",
  );
  const signature = createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function signFreshLocalOAuthApproval(
  input: Omit<z.infer<typeof approvalRelaySchema>, "expiresAt">,
  secret: string,
) {
  return signLocalOAuthApproval({ ...input, expiresAt: Date.now() + 5 * 60_000 }, secret);
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function verifyLocalOAuthApproval(value: string, secret: string, now = Date.now()) {
  const [payload, signature, extra] = value.split(".");
  if (!payload || !signature || extra) {
    throw new Error("invalid-approval");
  }
  const expected = createHmac("sha256", secret).update(payload).digest();
  const provided = Buffer.from(signature, "base64url");
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    throw new Error("invalid-approval");
  }
  const result = approvalRelaySchema.parse(
    JSON.parse(Buffer.from(payload, "base64url").toString("utf-8")),
  );
  if (result.expiresAt <= now) {
    throw new Error("expired-approval");
  }
  return result;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseLocalOAuthAuthorization(input: {
  provider: string;
  values: Record<string, string | undefined>;
  appOrigin: string;
  emulation: ProviderEmulation;
  githubClientId: string;
  vercelClientId: string;
}) {
  const provider = localOAuthProviderSchema.parse(input.provider);
  const authorization = authorizationSchema.parse(input.values);
  const expectedClientId = provider === "github" ? input.githubClientId : input.vercelClientId;
  if (
    authorization.client_id !== expectedClientId ||
    authorization.redirect_uri !== `${input.appOrigin}/api/auth/callback/${provider}`
  ) {
    throw new Error("Local OAuth authorization binding is invalid.");
  }
  return { authorization, provider };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function localOAuthProviderDetails(provider: LocalOAuthProvider) {
  return provider === "github"
    ? {
        account: "Autograph Developer",
        handle: "@autograph-dev",
        name: "GitHub",
        scope: "Read your profile and verified email address",
      }
    : {
        account: "Autograph Developer",
        handle: "autograph-dev",
        name: "Vercel",
        scope: "Read your profile and verified email address",
      };
}
