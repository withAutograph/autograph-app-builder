import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { genericOAuth, jwt } from "better-auth/plugins";
import type { GenericOAuthConfig } from "better-auth/plugins";
import { decodeJwt } from "jose";
import { z } from "zod";

import { buildPreviewCimdOptions, buildPreviewMcpOAuthOptions } from "./preview-oauth-contract";
import type { PreviewOAuthMembershipAuthority } from "./preview-oauth-contract";
import { fetchPreviewClientMetadataResource } from "./preview-cimd-transport";
import { previewUserManagementPlugins } from "./preview-user-management";
import type { PreviewOrganizationUserAuthority } from "./preview-user-management";
import { resolveBetterAuthInfrastructure } from "./better-auth-infrastructure";
import type { BetterAuthInfrastructureEnvironment } from "./better-auth-infrastructure";
import {
  createPasskeyOnboardingPlugin,
  createPasskeyPlugin,
  readPasskeyOnboardingConfig,
} from "./passkey-onboarding";
import type { PasskeyOnboardingConfig } from "./passkey-onboarding";
import {
  hostedDeploymentEnvironmentSchema,
  readHostedDeploymentEnvironment,
} from "../hosted/deployment-environment";
import {
  providerEmulationEnvironment,
  readProviderEmulation,
  readVercelPreviewOrigin,
} from "../integrations/local-provider-emulation";
import type { ProviderEmulation } from "../integrations/local-provider-emulation";
import { providerEmulationFetch } from "../integrations/provider-emulation-fetch";
import { readProductionNavigationRuntimeConfig } from "../testing/production-navigation";

const databaseUrlSchema = z
  .string()
  .min(1)
  .max(8192)
  .refine((value) => !/[\0\r\n]/u.test(value))
  .refine((value) => {
    try {
      return ["postgres:", "postgresql:"].includes(new URL(value).protocol);
    } catch {
      return false;
    }
  }, "Preview OAuth requires PostgreSQL.");

const vercelUserInfoSchema = z.looseObject({
  email: z.email().max(320),
  email_verified: z.literal(true),
  name: z.string().min(1).max(512).optional(),
  picture: z.url().max(2048).nullable().optional(),
  preferred_username: z.string().min(1).max(512).optional(),
  sub: z.string().min(1).max(512),
});

const vercelUserInfoEndpoint = "https://api.vercel.com/login/oauth/userinfo";
const githubUserInfoEndpoint = "https://api.github.com/user";
const githubEmailsEndpoint = "https://api.github.com/user/emails";

const githubProfileSchema = z.looseObject({
  avatar_url: z.url().max(2048).nullable().optional(),
  id: z.union([z.string().min(1), z.number().int().positive()]),
  login: z.string().min(1).max(256),
  name: z.string().min(1).max(512).nullable().optional(),
});

const githubEmailsSchema = z
  .array(
    z.looseObject({
      email: z.email().max(320),
      primary: z.boolean(),
      verified: z.boolean(),
    }),
  )
  .max(100);

const isLocalEmulationIssuer = (config: PreviewOAuthRuntimeConfig, issuer: URL): boolean => {
  const emulationEnabled = config.localDevelopmentEmulation === true;
  const localMode = config.environment === "local" && config.hostedAdapter === "0";
  const secureLoopback = issuer.hostname === "localhost" && issuer.protocol === "https:";
  return emulationEnabled && localMode && secureLoopback;
};

const isLocalDevelopmentEmulation = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): boolean => {
  const executionMatches =
    environment.APP_BUILDER_EXECUTION_MODE === "development" &&
    environment.APP_BUILDER_EXECUTION_BUNDLE === "local-development";
  const adaptersMatch =
    environment.APP_BUILDER_LOCAL_ADAPTER === "1" &&
    environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "1" &&
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === "1";
  const vercelEnvironmentUnset = environment.VERCEL_ENV === undefined;
  const builderEnvironmentUnset = environment.EVE_HOSTED_VERCEL_ENVIRONMENT === undefined;
  const deploymentUnset = vercelEnvironmentUnset && builderEnvironmentUnset;
  return executionMatches && adaptersMatch && deploymentUnset;
};

const deriveResourceFromIssuer = (issuer: string | undefined): string | undefined =>
  issuer === undefined ? undefined : `${new URL(issuer).origin}/mcp`;

const trustedOriginsForResource = (resource: string | undefined): string[] =>
  resource === undefined ? [] : [new URL(resource).origin];

const isLocalHttpIssuer = (
  config: PreviewOAuthRuntimeConfig,
  issuer: URL,
  resource: URL,
): boolean =>
  config.environment === "local" &&
  issuer.protocol === "http:" &&
  resource.protocol === "http:" &&
  issuer.hostname === "localhost";

const isNonEmptyCredential = (credential: string | undefined): boolean =>
  credential !== undefined && credential.length > 0;

const hasCompleteOAuthCredentials = (config: {
  githubClientId?: string;
  githubClientSecret?: string;
  vercelClientId?: string;
  vercelClientSecret?: string;
}): boolean =>
  [
    config.githubClientId,
    config.githubClientSecret,
    config.vercelClientId,
    config.vercelClientSecret,
  ].every(isNonEmptyCredential);

const emulatedGitHubProfileSchema = z.object({
  avatar_url: z.string().optional(),
  email: z.string().min(1),
  id: z.number().int().positive(),
  login: z.string().min(1),
  name: z.string().optional(),
});

interface VercelOAuthTokens {
  accessToken?: string;
  idToken?: string;
}

interface GitHubOAuthTokens {
  accessToken?: string;
}

type JsonReadResult = { ok: true; value: unknown } | { ok: false };

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function readBoundedJson(response: Response, limit: number): Promise<JsonReadResult> {
  if (!response.ok) {
    return { ok: false };
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return { ok: false };
  }
  const body = await response.text();
  if (body.length > limit) {
    return { ok: false };
  }
  try {
    // SAFETY: JSON.parse output is contained as unknown and validated by the caller's schema.
    return { ok: true, value: z.unknown().parse(JSON.parse(body)) };
  } catch {
    return { ok: false };
  }
}

/**
 * GitHub keeps the authoritative verified-email assertion on its emails
 * endpoint. Read it explicitly so private profile emails still produce a
 * usable, verified identity without trusting a profile field alone.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function fetchVerifiedGitHubUserInfo(
  tokens: GitHubOAuthTokens,
  fetchImplementation: typeof fetch = fetch,
) {
  if (tokens.accessToken === undefined || tokens.accessToken.length === 0) {
    return null;
  }
  const headers = {
    Accept: "application/vnd.github+json",
    Authorization: `Bearer ${tokens.accessToken}`,
    "User-Agent": "autograph-app-builder",
  };

  let profileResponse: Response;
  let emailsResponse: Response;
  try {
    [profileResponse, emailsResponse] = await Promise.all([
      fetchImplementation(githubUserInfoEndpoint, {
        cache: "no-store",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
      fetchImplementation(githubEmailsEndpoint, {
        cache: "no-store",
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(5000),
      }),
    ]);
  } catch {
    return null;
  }

  const [profileRead, emailsRead] = await Promise.all([
    readBoundedJson(profileResponse, 16_384),
    readBoundedJson(emailsResponse, 16_384),
  ]);
  if (!profileRead.ok || !emailsRead.ok) {
    return null;
  }
  const profile = githubProfileSchema.safeParse(profileRead.value);
  const emails = githubEmailsSchema.safeParse(emailsRead.value);
  if (!profile.success || !emails.success) {
    return null;
  }
  const email =
    emails.data.find((candidate) => candidate.primary && candidate.verified) ??
    emails.data.find((candidate) => candidate.verified);
  if (!email) {
    return null;
  }
  const normalizedEmail = email.email.trim().toLowerCase();
  if (!normalizedEmail) {
    return null;
  }

  return {
    data: { ...profile.data, email: normalizedEmail },
    user: {
      email: normalizedEmail,
      emailVerified: true,
      image: profile.data.avatar_url ?? undefined,
      name: profile.data.name ?? profile.data.login,
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
async function exchangeLocalEmulatedOAuthCode(input: {
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  code: string;
  redirectURI: string;
  codeVerifier?: string;
  emulation: ProviderEmulation;
}) {
  const bodyParams = new URLSearchParams({
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectURI,
  });
  if (input.codeVerifier !== undefined && input.codeVerifier.length > 0) {
    bodyParams.set("code_verifier", input.codeVerifier);
  }
  const response = await providerEmulationFetch(
    input.tokenUrl,
    {
      body: bodyParams,
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      method: "POST",
      redirect: "error",
    },
    input.emulation,
  );
  if (!response.ok) {
    throw new Error("Emulated OAuth token exchange failed.");
  }
  const tokenBodySchema = z.strictObject({
    access_token: z.string().min(1),
    id_token: z.string().optional(),
    scope: z.string().optional(),
    token_type: z.string().optional(),
  });
  const tokenBody = z.unknown().parse(await response.json());
  const body = tokenBodySchema.parse(tokenBody);
  if (body.access_token.length === 0) {
    throw new Error("Emulated OAuth token response is invalid.");
  }
  return {
    accessToken: body.access_token,
    idToken: body.id_token,
    raw: body,
    scopes: body.scope?.split(/\s+/u).filter(Boolean),
    tokenType: body.token_type,
  };
}

/**
 * Vercel's signed ID token carries the email claim but not `email_verified`.
 * Read that assertion from Vercel's fixed UserInfo endpoint, then bind it back
 * to the already verified ID-token subject and email before Better Auth may
 * treat the provider identity as verified.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function fetchVerifiedVercelUserInfo(
  tokens: VercelOAuthTokens,
  fetchImplementation: typeof fetch = fetch,
) {
  if (
    tokens.accessToken === undefined ||
    tokens.accessToken.length === 0 ||
    tokens.idToken === undefined ||
    tokens.idToken.length === 0
  ) {
    return null;
  }

  let tokenClaims: ReturnType<typeof decodeJwt>;
  try {
    tokenClaims = decodeJwt(tokens.idToken);
  } catch {
    return null;
  }
  const claims = z.object({ email: z.email(), sub: z.string().min(1) }).safeParse(tokenClaims);
  if (!claims.success) {
    return null;
  }

  let response: Response;
  try {
    response = await fetchImplementation(vercelUserInfoEndpoint, {
      cache: "no-store",
      headers: { Authorization: `Bearer ${tokens.accessToken}` },
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    return null;
  }
  if (!response.ok) {
    return null;
  }

  const profileRead = await readBoundedJson(response, 16_384);
  if (!profileRead.ok) {
    return null;
  }
  const profileResult = vercelUserInfoSchema.safeParse(profileRead.value);
  if (!profileResult.success) {
    return null;
  }
  const profile = profileResult.data;

  const email = profile.email.trim().toLowerCase();
  if (profile.sub !== claims.data.sub || email !== claims.data.email.trim().toLowerCase()) {
    return null;
  }

  return {
    ...profile,
    email,
    emailVerified: true,
    id: profile.sub,
    image: profile.picture ?? undefined,
    name: profile.name ?? profile.preferred_username ?? email.slice(0, email.indexOf("@")),
  };
}

const previewOAuthRuntimeConfigSchema = z
  .strictObject({
    databaseUrl: databaseUrlSchema,
    environment: z.union([
      hostedDeploymentEnvironmentSchema,
      z.literal("local"),
      z.literal("development"),
    ]),
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
    hostedAdapter: z.enum(["0", "1"]),
    issuer: z.url(),
    localDevelopmentEmulation: z.literal(true).optional(),
    passkeyOnboarding: z.custom<PasskeyOnboardingConfig>().nullable(),
    resource: z.url(),
    secret: z
      .string()
      .min(32)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    trustedOrigins: z.array(z.url()).min(1).max(3).optional(),
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
  })
  .superRefine((config, context) => {
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resource);
    const issuerHasNoCredentials = issuer.username.length === 0 && issuer.password.length === 0;
    const issuerHasNoSuffix = issuer.search.length === 0 && issuer.hash.length === 0;
    if (issuer.pathname !== "/api/auth" || !issuerHasNoCredentials || !issuerHasNoSuffix) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth issuer must be the exact /api/auth URL.",
        path: ["issuer"],
      });
    }
    const resourceHasNoCredentials =
      resource.username.length === 0 && resource.password.length === 0;
    const resourceHasNoSuffix = resource.search.length === 0 && resource.hash.length === 0;
    if (
      resource.pathname !== "/mcp" ||
      !resourceHasNoCredentials ||
      !resourceHasNoSuffix ||
      resource.origin !== issuer.origin
    ) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth resource must be same-origin exact /mcp.",
        path: ["resource"],
      });
    }
    if (config.environment === "development") {
      const isDevelopmentLoopback = ["localhost", "127.0.0.1"].includes(issuer.hostname);
      if (config.hostedAdapter !== "0" || !isDevelopmentLoopback || issuer.protocol !== "http:") {
        context.addIssue({
          code: "custom",
          message: "Development auth requires one loopback HTTP issuer.",
          path: ["environment"],
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
          message: `${provider} auth requires both client ID and client secret.`,
          path: [provider === "GitHub" ? "githubClientId" : "vercelClientId"],
        });
      }
    }
    const localHttp = isLocalHttpIssuer(config, issuer, resource);
    const hostedAdapterAllowed = config.hostedAdapter === "1";
    const localEmulationAllowed = isLocalEmulationIssuer(config, issuer);
    const requiresHttps =
      !localHttp && (issuer.protocol !== "https:" || resource.protocol !== "https:");
    if ((!hostedAdapterAllowed && !localEmulationAllowed) || requiresHttps) {
      context.addIssue({
        code: "custom",
        message: "Hosted auth requires the hosted adapter and HTTPS.",
        path: ["hostedAdapter"],
      });
    }
    const hasAllOAuthCredentials = hasCompleteOAuthCredentials(config);
    if (config.passkeyOnboarding === null && !hasAllOAuthCredentials) {
      context.addIssue({
        code: "custom",
        message:
          "Hosted auth without passkey onboarding requires all GitHub and Vercel credentials.",
        path: ["passkeyOnboarding"],
      });
    }
  });

export type PreviewOAuthRuntimeConfig = z.infer<typeof previewOAuthRuntimeConfigSchema>;

/**
 * Codex can retry the public-client code exchange while its loopback callback
 * settles. Keep the authorization server's default limit everywhere else, but
 * give the one-time-code/refresh-token endpoint enough room for those bounded
 * retries instead of sharing the much smaller general Preview bucket.
 */
export const previewOAuthRateLimit = {
  customRules: {
    "/oauth2/token": { max: 180, window: 60 },
  },
  enabled: true,
  max: 60,
  window: 60,
} satisfies NonNullable<BetterAuthOptions["rateLimit"]>;

export const authRateLimitForLocalEmulation = (localEmulation: boolean) =>
  localEmulation
    ? {
        ...previewOAuthRateLimit,
        customRules: {
          ...previewOAuthRateLimit.customRules,
          // Better Auth applies a stricter three-request default to sign-in
          // routes. A complete emulated suite intentionally performs several
          // independent and returning OAuth sign-ins from one loopback client.
          "/sign-in/social": { max: 60, window: 60 },
        },
        max: 600,
      }
    : previewOAuthRateLimit;

export const readPreviewOAuthRuntimeConfig = (
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthRuntimeConfig => {
  const productionNavigation = readProductionNavigationRuntimeConfig(environment);
  if (productionNavigation) {
    return previewOAuthRuntimeConfigSchema.parse(productionNavigation);
  }
  const resolvedEnvironment = providerEmulationEnvironment(environment);
  const localEmulation = readProviderEmulation(resolvedEnvironment);
  if (localEmulation) {
    if (localEmulation.mode === "local" && environment.APP_BUILDER_LOCAL_AUTH_EMULATION !== "1") {
      throw new Error("Local authentication emulation is unavailable.");
    }
    if (localEmulation.mode === "preview") {
      const deploymentEnvironment = readHostedDeploymentEnvironment(resolvedEnvironment);
      const passkeyOnboarding = readPasskeyOnboardingConfig(resolvedEnvironment, {
        previewCanonicalOrigin: localEmulation.canonicalOrigin,
      });
      return previewOAuthRuntimeConfigSchema.parse({
        databaseUrl: resolvedEnvironment.DATABASE_URL,
        environment: deploymentEnvironment,
        githubClientId: resolvedEnvironment.GITHUB_CLIENT_ID,
        githubClientSecret: resolvedEnvironment.GITHUB_CLIENT_SECRET,
        hostedAdapter: resolvedEnvironment.EVE_HOSTED_ADAPTER,
        issuer: resolvedEnvironment.BETTER_AUTH_URL,
        passkeyOnboarding,
        resource: resolvedEnvironment.MCP_RESOURCE_URL,
        secret: resolvedEnvironment.BETTER_AUTH_SECRET,
        trustedOrigins: [
          ...new Set(
            [
              localEmulation.canonicalOrigin,
              readVercelPreviewOrigin(environment.VERCEL_URL),
            ].filter((origin): origin is string => origin !== undefined),
          ),
        ],
        vercelClientId: resolvedEnvironment.VERCEL_AUTH_CLIENT_ID,
        vercelClientSecret: resolvedEnvironment.VERCEL_AUTH_CLIENT_SECRET,
      });
    }
    const passkeyOnboarding = readPasskeyOnboardingConfig(environment);
    const localDatabasePort = environment.APP_BUILDER_DATABASE_PORT ?? "54329";
    if (!/^\d{2,5}$/u.test(localDatabasePort)) {
      throw new Error("Local authentication database port is invalid.");
    }
    const localDevelopmentEmulation = isLocalDevelopmentEmulation(environment);
    return previewOAuthRuntimeConfigSchema.parse({
      databaseUrl: `postgresql://postgres@127.0.0.1:${localDatabasePort}/autograph_app_builder`,
      environment: "local",
      githubClientId: environment.GITHUB_CLIENT_ID,
      githubClientSecret: environment.GITHUB_CLIENT_SECRET,
      hostedAdapter: environment.EVE_HOSTED_ADAPTER,
      issuer: environment.BETTER_AUTH_URL,
      localDevelopmentEmulation: localDevelopmentEmulation ? true : undefined,
      passkeyOnboarding,
      resource: environment.MCP_RESOURCE_URL,
      secret: environment.BETTER_AUTH_SECRET,
      trustedOrigins: [localEmulation.canonicalOrigin],
      vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
      vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
    });
  }
  const passkeyOnboarding = readPasskeyOnboardingConfig(environment);
  const localDevelopment =
    passkeyOnboarding?.deploymentId === "local" && environment.VERCEL_ENV === undefined;
  const deploymentEnvironment = localDevelopment
    ? "development"
    : readHostedDeploymentEnvironment(environment);
  let issuer = environment.BETTER_AUTH_URL;
  if (issuer === undefined && environment.VERCEL_ENV === "preview") {
    const previewHostname = environment.VERCEL_URL;
    if (previewHostname !== undefined && previewHostname.length > 0) {
      issuer = `https://${previewHostname}/api/auth`;
    }
  }
  const resource = environment.MCP_RESOURCE_URL ?? deriveResourceFromIssuer(issuer);
  return previewOAuthRuntimeConfigSchema.parse({
    databaseUrl: environment.DATABASE_URL,
    environment: deploymentEnvironment,
    githubClientId: environment.GITHUB_CLIENT_ID,
    githubClientSecret: environment.GITHUB_CLIENT_SECRET,
    hostedAdapter: localDevelopment ? "0" : environment.EVE_HOSTED_ADAPTER,
    issuer,
    passkeyOnboarding,
    resource,
    secret: environment.BETTER_AUTH_SECRET,
    trustedOrigins: trustedOriginsForResource(resource),
    vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
  });
};

export const createPreviewOAuthServer = (input: {
  config: PreviewOAuthRuntimeConfig;
  database: NonNullable<BetterAuthOptions["database"]>;
  membership: PreviewOAuthMembershipAuthority;
  userManagement?: PreviewOrganizationUserAuthority;
  infrastructure?: {
    environment: BetterAuthInfrastructureEnvironment;
    organizationAuthorityReady: boolean;
  };
  fetchClientMetadata?: typeof fetchPreviewClientMetadataResource;
}) => {
  const config = previewOAuthRuntimeConfigSchema.parse(input.config);
  const resourceOrigin = new URL(config.resource).origin;
  const localEmulation = readProviderEmulation(process.env);
  const { githubClientId, githubClientSecret, vercelClientId, vercelClientSecret } = config;
  const hasAllOAuthCredentials = hasCompleteOAuthCredentials(config);
  if (localEmulation !== undefined && !hasAllOAuthCredentials) {
    throw new Error("Local provider emulation requires GitHub and Vercel OAuth credentials.");
  }
  const localGithubClientId = githubClientId ?? "";
  const localGithubClientSecret = githubClientSecret ?? "";
  const localVercelClientId = vercelClientId ?? "";
  const localVercelClientSecret = vercelClientSecret ?? "";
  const localProviderConfigs: GenericOAuthConfig[] = localEmulation
    ? [
        {
          accountIssuer: localEmulation.githubOrigin,
          authorizationUrl: `${resourceOrigin}/local-oauth/github/authorize`,
          clientId: localGithubClientId,
          clientSecret: localGithubClientSecret,
          disableSignUp: false,
          getToken: async (data) =>
            await exchangeLocalEmulatedOAuthCode({
              clientId: localGithubClientId,
              clientSecret: localGithubClientSecret,
              code: data.code,
              codeVerifier: data.codeVerifier,
              emulation: localEmulation,
              redirectURI: data.redirectURI,
              tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
            }),
          getUserInfo: async (tokens) => {
            const response = await providerEmulationFetch(
              `${localEmulation.githubOrigin}/user`,
              {
                cache: "no-store",
                headers: { Authorization: `Bearer ${tokens.accessToken}` },
                redirect: "error",
              },
              localEmulation,
            );
            if (!response.ok) {
              return null;
            }
            const parsedProfile = emulatedGitHubProfileSchema.safeParse(await response.json());
            if (!parsedProfile.success) {
              return null;
            }
            const profile = parsedProfile.data;
            if (profile.id === 0 || profile.email.length === 0) {
              return null;
            }
            return {
              email: profile.email,
              emailVerified: true,
              id: profile.id,
              image: profile.avatar_url,
              name: profile.name ?? profile.login ?? profile.email,
            };
          },
          name: "GitHub",
          overrideUserInfo: false,
          providerId: "github",
          scopes: ["read:user", "user:email"],
          tokenEndpointAuth: { method: "client_secret_post" },
          tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
        },
        {
          accountIssuer: localEmulation.vercelOrigin,
          accountSubject: ({ profile }) => String(profile.sub ?? ""),
          authorizationUrl: `${resourceOrigin}/local-oauth/vercel/authorize`,
          clientId: localVercelClientId,
          clientSecret: localVercelClientSecret,
          disableSignUp: false,
          getToken: async (data) =>
            await exchangeLocalEmulatedOAuthCode({
              clientId: localVercelClientId,
              clientSecret: localVercelClientSecret,
              code: data.code,
              codeVerifier: data.codeVerifier,
              emulation: localEmulation,
              redirectURI: data.redirectURI,
              tokenUrl: `${localEmulation.vercelOrigin}/login/oauth/token`,
            }),
          getUserInfo: async (tokens) => {
            const response = await providerEmulationFetch(
              `${localEmulation.vercelOrigin}/login/oauth/userinfo`,
              {
                cache: "no-store",
                headers: {
                  Authorization: `Bearer ${tokens.accessToken}`,
                },
                redirect: "error",
              },
              localEmulation,
            );
            if (!response.ok) {
              return null;
            }
            const profile = vercelUserInfoSchema.safeParse(await response.json());
            if (!profile.success || !profile.data.email_verified) {
              return null;
            }
            return {
              email: profile.data.email,
              emailVerified: true,
              id: profile.data.sub,
              image: profile.data.picture ?? undefined,
              name: profile.data.name ?? profile.data.preferred_username ?? profile.data.email,
              sub: profile.data.sub,
            };
          },
          name: "Vercel",
          overrideUserInfo: false,
          // Emulate's Vercel authorization endpoint validates PKCE but its
          // seeded installation flow does not retain the verifier. Keep this
          // development-only client flow compatible with that emulator.
          pkce: false,
          providerId: "vercel",
          scopes: ["openid", "email", "profile"],
          tokenEndpointAuth: { method: "client_secret_post" },
          tokenUrl: `${localEmulation.vercelOrigin}/login/oauth/token`,
        },
      ]
    : [];
  const infrastructure = resolveBetterAuthInfrastructure(
    input.infrastructure ?? {
      environment: {},
      organizationAuthorityReady: false,
    },
  );
  const options: BetterAuthOptions = {
    account: {
      accountLinking: {
        allowDifferentEmails: true,
        disableImplicitLinking: false,
        enabled: true,
        updateUserInfoOnLink: false,
      },
    },
    advanced: {
      cookiePrefix:
        config.environment === "preview" ? "autograph_preview" : "autograph_app_builder",
      useSecureCookies: config.environment !== "development",
    },
    appName:
      config.environment === "preview" ? "Autograph App Builder Preview" : "Autograph App Builder",
    basePath: "/api/auth",
    baseURL: resourceOrigin,
    database: input.database,
    plugins: [
      ...previewUserManagementPlugins(
        input.userManagement ?? {
          // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
          async ensureOrganizationForVerifiedUser() {
            throw new Error("Preview organization authority is unavailable.");
          },
        },
      ),
      ...infrastructure.plugins,
      createPasskeyOnboardingPlugin({
        config: config.passkeyOnboarding,
        // The serial emulated browser suite exercises more than ten distinct
        // enrollment ceremonies from one loopback client. Keep the hosted
        // limit intact while preventing deterministic test traffic from
        // exhausting the plugin-specific bucket.
        onboardingContextRateLimitMax: localEmulation === undefined ? undefined : 600,
      }),
      createPasskeyPlugin({ config: config.passkeyOnboarding }),
      ...(config.environment === "development"
        ? []
        : [
            jwt({
              disableSettingJwtHeader: true,
              jwks: {
                jwksPath: "/jwks",
                keyPairConfig: { alg: "ES256" },
              },
              jwt: {
                audience: config.resource,
                expirationTime: "5m",
                issuer: config.issuer,
              },
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
                  input.fetchClientMetadata ?? fetchPreviewClientMetadataResource,
              }),
            ),
            ...(() => {
              if (localEmulation !== undefined) {
                return [genericOAuth({ config: localProviderConfigs })];
              }
              if (
                vercelClientId === undefined ||
                vercelClientId.length === 0 ||
                vercelClientSecret === undefined ||
                vercelClientSecret.length === 0
              ) {
                return [];
              }
              return [
                genericOAuth({
                  config: [
                    {
                      clientId: vercelClientId,
                      clientSecret: vercelClientSecret,
                      disableSignUp: false,
                      discoveryUrl: "https://vercel.com/.well-known/openid-configuration",
                      getUserInfo: fetchVerifiedVercelUserInfo,
                      name: "Vercel",
                      overrideUserInfo: false,
                      providerId: "vercel",
                      requireIdTokenVerification: true,
                      scopes: ["openid", "email", "profile"],
                      tokenEndpointAuth: { method: "client_secret_post" },
                    },
                  ],
                }),
              ];
            })(),
          ]),
      nextCookies(),
    ],
    rateLimit: authRateLimitForLocalEmulation(localEmulation !== undefined),
    secret: config.secret,
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
    },
    socialProviders: (() => {
      if (localEmulation !== undefined) {
        return {};
      }
      if (
        githubClientId === undefined ||
        githubClientId.length === 0 ||
        githubClientSecret === undefined ||
        githubClientSecret.length === 0
      ) {
        return {};
      }
      return {
        github: {
          clientId: githubClientId,
          clientSecret: githubClientSecret,
          disableSignUp: false,
          getUserInfo: async (tokens) => {
            const result = await fetchVerifiedGitHubUserInfo(tokens);
            if (result === null) {
              return null;
            }
            // SAFETY: githubProfileSchema preserves the provider's additional fields and this boundary adds a verified email.
            const fullGitHubProfile = githubProfileSchema.parse(result.data);
            return {
              ...result,
              data: { ...fullGitHubProfile, id: String(fullGitHubProfile.id) },
            };
          },
          overrideUserInfoOnSignIn: false,
        },
      };
    })(),
    trustedOrigins: config.trustedOrigins ?? [resourceOrigin],
    user: {
      validateUserInfo({ user, source }) {
        const providerId = source.oauth?.providerId;
        if (providerId === undefined) {
          return;
        }
        const emailResult = z.email().safeParse(user.email);
        if (
          !new Set(["github", "vercel"]).has(providerId) ||
          user.emailVerified !== true ||
          !emailResult.success
        ) {
          throw new Error(
            JSON.stringify({
              error: "verified_provider_identity_required",
              errorDescription: "Use GitHub or Vercel with a verified email address.",
            }),
          );
        }
      },
    },
  };
  return betterAuth(options);
};
