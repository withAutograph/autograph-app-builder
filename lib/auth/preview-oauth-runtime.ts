import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import {
  genericOAuth,
  jwt,
  type GenericOAuthConfig,
} from "better-auth/plugins";
import { decodeJwt } from "jose";
import { z } from "zod";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
  type PreviewOAuthMembershipAuthority,
} from "./preview-oauth-contract";
import { fetchPreviewClientMetadataResource } from "./preview-cimd-transport";
import {
  previewUserManagementPlugins,
  type PreviewOrganizationUserAuthority,
} from "./preview-user-management";
import {
  resolveBetterAuthInfrastructure,
  type BetterAuthInfrastructureEnvironment,
} from "./better-auth-infrastructure";
import {
  createPasskeyOnboardingPlugin,
  createPasskeyPlugin,
  readPasskeyOnboardingConfig,
  type PasskeyOnboardingConfig,
} from "./passkey-onboarding";
import {
  hostedDeploymentEnvironmentSchema,
  readHostedDeploymentEnvironment,
} from "../hosted/deployment-environment";
import { readLocalProviderEmulation } from "../integrations/local-provider-emulation";

const databaseUrlSchema = z
  .string()
  .min(1)
  .max(8_192)
  .refine((value) => !/[\0\r\n]/u.test(value))
  .refine((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Preview OAuth requires PostgreSQL.");

const vercelUserInfoSchema = z
  .object({
    sub: z.string().min(1).max(512),
    email: z.string().email().max(320),
    email_verified: z.literal(true),
    name: z.string().min(1).max(512).optional(),
    preferred_username: z.string().min(1).max(512).optional(),
    picture: z.string().url().max(2_048).nullable().optional(),
  })
  .passthrough();

const vercelUserInfoEndpoint = "https://api.vercel.com/login/oauth/userinfo";

type VercelOAuthTokens = {
  accessToken?: string;
  idToken?: string;
};

async function exchangeLocalEmulatedOAuthCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectURI: string;
  codeVerifier?: string;
}) {
  const response = await fetch(input.tokenUrl, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_id: input.clientId,
      client_secret: input.clientSecret,
      code: input.code,
      ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
      redirect_uri: input.redirectURI,
    }),
    cache: "no-store",
    redirect: "error",
  });
  if (!response.ok) throw new Error("Emulated OAuth token exchange failed.");
  const body = (await response.json()) as {
    access_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    id_token?: unknown;
  };
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("Emulated OAuth token response is invalid.");
  }
  return {
    accessToken: body.access_token,
    tokenType:
      typeof body.token_type === "string" ? body.token_type : undefined,
    scopes:
      typeof body.scope === "string"
        ? body.scope.split(/\s+/u).filter(Boolean)
        : undefined,
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
    raw: body,
  };
}

/**
 * Vercel's signed ID token carries the email claim but not `email_verified`.
 * Read that assertion from Vercel's fixed UserInfo endpoint, then bind it back
 * to the already verified ID-token subject and email before Better Auth may
 * treat the provider identity as verified.
 */
export async function fetchVerifiedVercelUserInfo(
  tokens: VercelOAuthTokens,
  fetchImplementation: typeof fetch = fetch,
) {
  if (!tokens.accessToken || !tokens.idToken) return null;

  let tokenClaims: ReturnType<typeof decodeJwt>;
  try {
    tokenClaims = decodeJwt(tokens.idToken);
  } catch {
    return null;
  }
  if (
    typeof tokenClaims.sub !== "string" ||
    typeof tokenClaims.email !== "string"
  ) {
    return null;
  }

  let response: Response;
  try {
    response = await fetchImplementation(vercelUserInfoEndpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(5_000),
    });
  } catch {
    return null;
  }
  if (!response.ok) return null;

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) return null;
  const body = await response.text();
  if (body.length > 16_384) return null;

  let profile: z.infer<typeof vercelUserInfoSchema>;
  try {
    profile = vercelUserInfoSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }

  const email = profile.email.trim().toLowerCase();
  if (
    profile.sub !== tokenClaims.sub ||
    email !== tokenClaims.email.trim().toLowerCase()
  ) {
    return null;
  }

  return {
    ...profile,
    id: profile.sub,
    email,
    emailVerified: true,
    image: profile.picture ?? undefined,
    name:
      profile.name ??
      profile.preferred_username ??
      email.slice(0, email.indexOf("@")),
  };
}

const previewOAuthRuntimeConfigSchema = z
  .object({
    hostedAdapter: z.enum(["0", "1"]),
    environment: z.union([
      hostedDeploymentEnvironmentSchema,
      z.literal("local"),
      z.literal("development"),
    ]),
    issuer: z.string().url(),
    resource: z.string().url(),
    secret: z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    databaseUrl: databaseUrlSchema,
    githubClientId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    githubClientSecret: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    vercelClientId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    vercelClientSecret: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value))
      .optional(),
    passkeyOnboarding: z.custom<PasskeyOnboardingConfig>().nullable(),
  })
  .strict()
  .superRefine((config, context) => {
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resource);
    if (
      issuer.pathname !== "/api/auth" ||
      issuer.search ||
      issuer.hash ||
      issuer.username ||
      issuer.password
    ) {
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "Preview OAuth issuer must be the exact /api/auth URL.",
      });
    }
    if (
      resource.pathname !== "/mcp" ||
      resource.search ||
      resource.hash ||
      resource.username ||
      resource.password ||
      resource.origin !== issuer.origin
    ) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "Preview OAuth resource must be same-origin exact /mcp.",
      });
    }
    if (config.environment === "development") {
      if (
        config.hostedAdapter !== "0" ||
        !["localhost", "127.0.0.1"].includes(issuer.hostname) ||
        issuer.protocol !== "http:"
      ) {
        context.addIssue({
          code: "custom",
          path: ["environment"],
          message: "Development auth requires one loopback HTTP issuer.",
        });
      }
      return;
    }
    for (const [provider, clientId, clientSecret] of [
      ["GitHub", config.githubClientId, config.githubClientSecret],
      ["Vercel", config.vercelClientId, config.vercelClientSecret],
    ] as const) {
      if ((clientId === undefined) !== (clientSecret === undefined)) {
        context.addIssue({
          code: "custom",
          path: [provider === "GitHub" ? "githubClientId" : "vercelClientId"],
          message: `${provider} auth requires both client ID and client secret.`,
        });
      }
    }
    if (
      config.hostedAdapter !== "1" ||
      issuer.protocol !== "https:" ||
      resource.protocol !== "https:"
    ) {
      context.addIssue({
        code: "custom",
        path: ["hostedAdapter"],
        message: "Hosted auth requires the hosted adapter and HTTPS.",
      });
    }
    if (
      config.passkeyOnboarding === null &&
      (!config.githubClientId ||
        !config.githubClientSecret ||
        !config.vercelClientId ||
        !config.vercelClientSecret)
    ) {
      context.addIssue({
        code: "custom",
        path: ["passkeyOnboarding"],
        message:
          "Hosted auth without passkey onboarding requires all GitHub and Vercel credentials.",
      });
    }
  });

export type PreviewOAuthRuntimeConfig = z.infer<
  typeof previewOAuthRuntimeConfigSchema
>;

/**
 * Codex can retry the public-client code exchange while its loopback callback
 * settles. Keep the authorization server's default limit everywhere else, but
 * give the one-time-code/refresh-token endpoint enough room for those bounded
 * retries instead of sharing the much smaller general Preview bucket.
 */
export const previewOAuthRateLimit = {
  enabled: true,
  window: 60,
  max: 60,
  customRules: {
    "/oauth2/token": { window: 60, max: 180 },
  },
} satisfies NonNullable<BetterAuthOptions["rateLimit"]>;

export function authRateLimitForLocalEmulation(localEmulation: boolean) {
  return localEmulation
    ? { ...previewOAuthRateLimit, max: 600 }
    : previewOAuthRateLimit;
}

export function readPreviewOAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthRuntimeConfig {
  const localEmulation = readLocalProviderEmulation(environment);
  if (localEmulation) {
    if (environment.APP_BUILDER_LOCAL_AUTH_EMULATION !== "1") {
      throw new Error("Local authentication emulation is unavailable.");
    }
    const passkeyOnboarding = readPasskeyOnboardingConfig(environment);
    return previewOAuthRuntimeConfigSchema.parse({
      hostedAdapter: environment.EVE_HOSTED_ADAPTER,
      environment: "local",
      issuer: environment.BETTER_AUTH_URL,
      resource: environment.MCP_RESOURCE_URL,
      secret: environment.BETTER_AUTH_SECRET,
      databaseUrl:
        "postgresql://postgres@127.0.0.1:54329/autograph_app_builder",
      githubClientId: environment.GITHUB_CLIENT_ID,
      githubClientSecret: environment.GITHUB_CLIENT_SECRET,
      vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
      vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
      passkeyOnboarding,
    });
  }
  const passkeyOnboarding = readPasskeyOnboardingConfig(environment);
  const localDevelopment =
    passkeyOnboarding?.deploymentId === "local" &&
    environment.VERCEL_ENV === undefined;
  const deploymentEnvironment = localDevelopment
    ? "development"
    : readHostedDeploymentEnvironment(environment);
  const issuer =
    environment.BETTER_AUTH_URL ??
    (environment.VERCEL_ENV === "preview" && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}/api/auth`
      : undefined);
  const resource =
    environment.MCP_RESOURCE_URL ??
    (issuer ? `${new URL(issuer).origin}/mcp` : undefined);
  return previewOAuthRuntimeConfigSchema.parse({
    hostedAdapter: localDevelopment ? "0" : environment.EVE_HOSTED_ADAPTER,
    environment: deploymentEnvironment,
    issuer,
    resource,
    secret: environment.BETTER_AUTH_SECRET,
    databaseUrl: environment.DATABASE_URL,
    githubClientId: environment.GITHUB_CLIENT_ID,
    githubClientSecret: environment.GITHUB_CLIENT_SECRET,
    vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
    passkeyOnboarding,
  });
}

export function createPreviewOAuthServer(input: {
  config: PreviewOAuthRuntimeConfig;
  database: NonNullable<BetterAuthOptions["database"]>;
  membership: PreviewOAuthMembershipAuthority;
  userManagement?: PreviewOrganizationUserAuthority;
  infrastructure?: {
    environment: BetterAuthInfrastructureEnvironment;
    organizationAuthorityReady: boolean;
  };
  fetchClientMetadata?: typeof fetchPreviewClientMetadataResource;
}) {
  const config = previewOAuthRuntimeConfigSchema.parse(input.config);
  const resourceOrigin = new URL(config.resource).origin;
  const localEmulation =
    config.environment === "local"
      ? readLocalProviderEmulation(process.env)
      : undefined;
  const {
    githubClientId,
    githubClientSecret,
    vercelClientId,
    vercelClientSecret,
  } = config;
  if (
    localEmulation &&
    (!githubClientId ||
      !githubClientSecret ||
      !vercelClientId ||
      !vercelClientSecret)
  ) {
    throw new Error(
      "Local provider emulation requires GitHub and Vercel OAuth credentials.",
    );
  }
  const localGithubClientId = githubClientId ?? "";
  const localGithubClientSecret = githubClientSecret ?? "";
  const localVercelClientId = vercelClientId ?? "";
  const localVercelClientSecret = vercelClientSecret ?? "";
  const localProviderConfigs: GenericOAuthConfig[] = localEmulation
    ? [
        {
          providerId: "github",
          name: "GitHub",
          authorizationUrl: `${resourceOrigin}/local-oauth/github/authorize`,
          tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
          clientId: localGithubClientId,
          clientSecret: localGithubClientSecret,
          tokenEndpointAuth: { method: "client_secret_post" },
          accountIssuer: localEmulation.githubOrigin,
          scopes: ["read:user", "user:email"],
          getToken: (data) =>
            exchangeLocalEmulatedOAuthCode({
              tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
              clientId: localGithubClientId,
              clientSecret: localGithubClientSecret,
              code: data.code,
              redirectURI: data.redirectURI,
              codeVerifier: data.codeVerifier,
            }),
          getUserInfo: async (tokens) => {
            const response = await fetch(
              `${localEmulation.githubOrigin}/user`,
              {
                headers: { Authorization: `Bearer ${tokens.accessToken}` },
                cache: "no-store",
                redirect: "error",
              },
            );
            if (!response.ok) return null;
            const profile = (await response.json()) as {
              id?: number;
              login?: string;
              email?: string;
              name?: string;
              avatar_url?: string;
            };
            if (!profile.id || !profile.email) return null;
            return {
              id: profile.id,
              email: profile.email,
              emailVerified: true,
              name: profile.name ?? profile.login ?? profile.email,
              image: profile.avatar_url,
            };
          },
          disableSignUp: false,
          overrideUserInfo: false,
        },
        {
          providerId: "vercel",
          name: "Vercel",
          authorizationUrl: `${resourceOrigin}/local-oauth/vercel/authorize`,
          tokenUrl: `${localEmulation.vercelOrigin}/login/oauth/token`,
          clientId: localVercelClientId,
          clientSecret: localVercelClientSecret,
          tokenEndpointAuth: { method: "client_secret_post" },
          accountIssuer: localEmulation.vercelOrigin,
          scopes: ["openid", "email", "profile"],
          // Emulate's Vercel authorization endpoint validates PKCE but its
          // seeded installation flow does not retain the verifier. Keep this
          // development-only client flow compatible with that emulator.
          pkce: false,
          getToken: (data) =>
            exchangeLocalEmulatedOAuthCode({
              tokenUrl: `${localEmulation.vercelOrigin}/login/oauth/token`,
              clientId: localVercelClientId,
              clientSecret: localVercelClientSecret,
              code: data.code,
              redirectURI: data.redirectURI,
              codeVerifier: data.codeVerifier,
            }),
          getUserInfo: async (tokens) => {
            const response = await fetch(
              `${localEmulation.vercelOrigin}/login/oauth/userinfo`,
              {
                // Emulate currently does not expose OAuth-issued Vercel
                // tokens to its UserInfo route. The seeded service token is
                // the local emulator's verified identity transport.
                headers: {
                  Authorization: `Bearer ${localEmulation.token}`,
                },
                cache: "no-store",
                redirect: "error",
              },
            );
            if (!response.ok) return null;
            const profile = vercelUserInfoSchema.safeParse(
              await response.json(),
            );
            if (!profile.success || !profile.data.email_verified) return null;
            return {
              id: profile.data.sub,
              sub: profile.data.sub,
              email: profile.data.email,
              emailVerified: true,
              name:
                profile.data.name ??
                profile.data.preferred_username ??
                profile.data.email,
              image: profile.data.picture ?? undefined,
            };
          },
          accountSubject: ({ profile }) => String(profile.sub ?? ""),
          disableSignUp: false,
          overrideUserInfo: false,
        },
      ]
    : [];
  const infrastructure = resolveBetterAuthInfrastructure(
    input.infrastructure ?? {
      environment: {},
      organizationAuthorityReady: false,
    },
  );
  return betterAuth({
    appName:
      config.environment === "preview"
        ? "Autograph App Builder Preview"
        : "Autograph App Builder",
    baseURL: resourceOrigin,
    basePath: "/api/auth",
    secret: config.secret,
    database: input.database,
    trustedOrigins: [resourceOrigin],
    socialProviders: localEmulation
      ? {}
      : config.githubClientId && config.githubClientSecret
        ? {
            github: {
              clientId: config.githubClientId,
              clientSecret: config.githubClientSecret,
              disableSignUp: false,
              overrideUserInfoOnSignIn: false,
            },
          }
        : {},
    user: {
      validateUserInfo({ user, source }) {
        const providerId = source.oauth?.providerId;
        if (providerId === undefined) return;
        if (
          !new Set(["github", "vercel"]).has(providerId) ||
          user.emailVerified !== true ||
          typeof user.email !== "string" ||
          user.email.trim().length === 0
        ) {
          return {
            error: "verified_provider_identity_required",
            errorDescription:
              "Use GitHub or Vercel with a verified email address.",
          };
        }
      },
    },
    account: {
      accountLinking: {
        enabled: true,
        disableImplicitLinking: false,
        allowDifferentEmails: true,
        updateUserInfoOnLink: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
    },
    rateLimit: authRateLimitForLocalEmulation(localEmulation !== undefined),
    advanced: {
      cookiePrefix:
        config.environment === "preview"
          ? "autograph_preview"
          : "autograph_app_builder",
      useSecureCookies: config.environment !== "development",
    },
    plugins: [
      ...previewUserManagementPlugins(
        input.userManagement ?? {
          async ensureOrganizationForVerifiedUser() {
            throw new Error("Preview organization authority is unavailable.");
          },
        },
      ),
      ...infrastructure.plugins,
      createPasskeyOnboardingPlugin({ config: config.passkeyOnboarding }),
      createPasskeyPlugin({ config: config.passkeyOnboarding }),
      ...(config.environment === "development"
        ? []
        : [
            jwt({
              jwks: {
                keyPairConfig: { alg: "ES256" },
                jwksPath: "/jwks",
              },
              jwt: {
                issuer: config.issuer,
                audience: config.resource,
                expirationTime: "5m",
              },
              disableSettingJwtHeader: true,
            }),
            mcp(
              buildPreviewMcpOAuthOptions({
                config: { issuer: config.issuer, resource: config.resource },
                membership: input.membership,
              }),
            ),
            cimd(
              buildPreviewCimdOptions({
                fetchClientMetadataResource:
                  input.fetchClientMetadata ??
                  fetchPreviewClientMetadataResource,
              }),
            ),
            ...(localEmulation
              ? [genericOAuth({ config: localProviderConfigs })]
              : config.vercelClientId && config.vercelClientSecret
                ? [
                    genericOAuth({
                      config: [
                        {
                          providerId: "vercel",
                          name: "Vercel",
                          discoveryUrl:
                            "https://vercel.com/.well-known/openid-configuration",
                          requireIdTokenVerification: true,
                          clientId: config.vercelClientId,
                          clientSecret: config.vercelClientSecret,
                          tokenEndpointAuth: { method: "client_secret_post" },
                          scopes: ["openid", "email", "profile"],
                          getUserInfo: fetchVerifiedVercelUserInfo,
                          disableSignUp: false,
                          overrideUserInfo: false,
                        },
                      ],
                    }),
                  ]
                : []),
          ]),
      nextCookies(),
    ],
  });
}
