import { z } from "zod";

import type { LocalProviderEmulation } from "../integrations/local-provider-emulation";

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

export function parseLocalOAuthAuthorization(input: {
  provider: string;
  values: Record<string, string | undefined>;
  appOrigin: string;
  emulation: LocalProviderEmulation;
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
