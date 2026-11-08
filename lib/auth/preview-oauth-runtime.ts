import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth } from "better-auth";
import type { BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import type { GithubProfile } from "@better-auth/core/social-providers";
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

const vercelUserInfoSchema = z
  .object({
    email: z.email().max(320),
    email_verified: z.literal(true),
    name: z.string().min(1).max(512).optional(),
    picture: z.url().max(2048).nullable().optional(),
    preferred_username: z.string().min(1).max(512).optional(),
    sub: z.string().min(1).max(512),
  })
  .loose();

const vercelUserInfoEndpoint = "https://api.vercel.com/login/oauth/userinfo";
const githubUserInfoEndpoint = "https://api.github.com/user";
const githubEmailsEndpoint = "https://api.github.com/user/emails";

const githubProfileSchema = z
  .object({
    avatar_url: z.url().max(2048).nullable().optional(),
    id: z.union([z.string().min(1), z.number().int().positive()]),
    login: z.string().min(1).max(256),
    name: z.string().min(1).max(512).nullable().optional(),
  })
  .loose();

const githubEmailsSchema = z
  .array(
    z
      .object({
        email: z.email().max(320),
        primary: z.boolean(),
        verified: z.boolean(),
      })
      .loose(),
  )
  .max(100);

interface VercelOAuthTokens {
  accessToken?: string;
  idToken?: string;
}

interface GitHubOAuthTokens {
  accessToken?: string;
}

// eslint-disable-next-line eslint/func-style, anti-slop/no-unknown-returns -- Keep bounded response JSON unknown until its consumer parses it. Preserve function declaration hoisting and initialization timing.
async function readBoundedJson(response: Response, limit: number): Promise<unknown> {
  if (!response.ok) {
    return null;
  }
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > limit) {
    return null;
  }
  const body = await response.text();
  if (body.length > limit) {
    return null;
  }
  try {
    return JSON.parse(body);
  } catch {
    return null;
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
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  if (!tokens.accessToken) {
    return null;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */
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

  const [profileBody, emailsBody] = await Promise.all([
    readBoundedJson(profileResponse, 16_384),
    readBoundedJson(emailsResponse, 16_384),
  ]);
  const profile = githubProfileSchema.safeParse(profileBody);
  const emails = githubEmailsSchema.safeParse(emailsBody);
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
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  const response = await providerEmulationFetch(
    input.tokenUrl,
    {
      body: new URLSearchParams({
        client_id: input.clientId,
        client_secret: input.clientSecret,
        code: input.code,
        // oxlint-disable-next-line anti-slop/no-conditional-empty-object-spread -- Preserve conditional fields and evaluation order.
        ...(input.codeVerifier ? { code_verifier: input.codeVerifier } : {}),
        redirect_uri: input.redirectURI,
      }),
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
  /* oxlint-enable typescript/strict-boolean-expressions */
  if (!response.ok) {
    throw new Error("Emulated OAuth token exchange failed.");
  }
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
  const body = (await response.json()) as {
    access_token?: unknown;
    token_type?: unknown;
    scope?: unknown;
    id_token?: unknown;
  };
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof body.access_token !== "string" || body.access_token.length === 0) {
    throw new Error("Emulated OAuth token response is invalid.");
  }
  return {
    accessToken: body.access_token,
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    idToken: typeof body.id_token === "string" ? body.id_token : undefined,
    raw: body,
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    scopes: typeof body.scope === "string" ? body.scope.split(/\s+/u).filter(Boolean) : undefined,
    // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
    tokenType: typeof body.token_type === "string" ? body.token_type : undefined,
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
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  if (!tokens.accessToken || !tokens.idToken) {
    return null;
  }
  /* oxlint-enable typescript/strict-boolean-expressions */

  let tokenClaims: ReturnType<typeof decodeJwt>;
  try {
    tokenClaims = decodeJwt(tokens.idToken);
  } catch {
    return null;
  }
  // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
  if (typeof tokenClaims.sub !== "string" || typeof tokenClaims.email !== "string") {
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

  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > 16_384) {
    return null;
  }
  const body = await response.text();
  if (body.length > 16_384) {
    return null;
  }

  let profile: z.infer<typeof vercelUserInfoSchema>;
  try {
    profile = vercelUserInfoSchema.parse(JSON.parse(body));
  } catch {
    return null;
  }

  const email = profile.email.trim().toLowerCase();
  if (profile.sub !== tokenClaims.sub || email !== tokenClaims.email.trim().toLowerCase()) {
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
    const invalidIssuerLocation =
      issuer.pathname !== "/api/auth" || issuer.search !== "" || issuer.hash !== "";
    if (invalidIssuerLocation || issuer.username || issuer.password) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth issuer must be the exact /api/auth URL.",
        path: ["issuer"],
      });
    }
    const invalidResourceLocation =
      resource.pathname !== "/mcp" || resource.search !== "" || resource.hash !== "";
    if (
      invalidResourceLocation ||
      resource.username ||
      resource.password ||
      resource.origin !== issuer.origin
    ) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth resource must be same-origin exact /mcp.",
        path: ["resource"],
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
    const localHttp =
      config.environment === "local" &&
      issuer.protocol === "http:" &&
      resource.protocol === "http:" &&
      issuer.hostname === "localhost";
    if (
      // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
      !(
        config.hostedAdapter === "1" ||
        (config.localDevelopmentEmulation === true &&
          config.environment === "local" &&
          config.hostedAdapter === "0" &&
          issuer.hostname === "localhost" &&
          issuer.protocol === "https:")
      ) ||
      (!localHttp && (issuer.protocol !== "https:" || resource.protocol !== "https:"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Hosted auth requires the hosted adapter and HTTPS.",
        path: ["hostedAdapter"],
      });
    }
    if (config.passkeyOnboarding === null) {
      let missingCredentials =
        config.githubClientId === undefined ||
        config.githubClientId === "" ||
        config.githubClientSecret === undefined ||
        config.githubClientSecret === "";
      if (!missingCredentials) {
        missingCredentials =
          config.vercelClientId === undefined ||
          config.vercelClientId === "" ||
          config.vercelClientSecret === undefined ||
          config.vercelClientSecret === "";
      }
      if (missingCredentials) {
        context.addIssue({
          code: "custom",
          message:
            "Hosted auth without passkey onboarding requires all GitHub and Vercel credentials.",
          path: ["passkeyOnboarding"],
        });
      }
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

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function authRateLimitForLocalEmulation(localEmulation: boolean) {
  return localEmulation
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
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readPreviewOAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthRuntimeConfig {
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
    return previewOAuthRuntimeConfigSchema.parse({
      databaseUrl: `postgresql://postgres@127.0.0.1:${localDatabasePort}/autograph_app_builder`,
      environment: "local",
      githubClientId: environment.GITHUB_CLIENT_ID,
      githubClientSecret: environment.GITHUB_CLIENT_SECRET,
      hostedAdapter: environment.EVE_HOSTED_ADAPTER,
      issuer: environment.BETTER_AUTH_URL,
      localDevelopmentEmulation:
        // oxlint-disable-next-line sonarjs/expression-complexity -- Preserve the existing conditions and their evaluation order.
        environment.APP_BUILDER_EXECUTION_MODE === "development" &&
        environment.APP_BUILDER_EXECUTION_BUNDLE === "local-development" &&
        environment.APP_BUILDER_LOCAL_ADAPTER === "1" &&
        environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "1" &&
        environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === "1" &&
        environment.VERCEL_ENV === undefined &&
        environment.EVE_HOSTED_VERCEL_ENVIRONMENT === undefined
          ? true
          : undefined,
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
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
  const issuer =
    environment.BETTER_AUTH_URL ??
    (environment.VERCEL_ENV === "preview" && environment.VERCEL_URL
      ? `https://${environment.VERCEL_URL}/api/auth`
      : undefined);
  /* oxlint-enable typescript/strict-boolean-expressions */
  const resource =
    environment.MCP_RESOURCE_URL ??
    (issuer !== undefined && issuer !== "" ? `${new URL(issuer).origin}/mcp` : undefined);
  /* oxlint-disable typescript/strict-boolean-expressions -- Preserve empty and nullish string truthiness. */
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
    trustedOrigins: resource ? [new URL(resource).origin] : [],
    vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
  });
  /* oxlint-enable typescript/strict-boolean-expressions */
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
  const localEmulation = readProviderEmulation(process.env);
  const { githubClientId, githubClientSecret, vercelClientId, vercelClientSecret } = config;
  if (localEmulation) {
    let missingCredentials =
      githubClientId === undefined ||
      githubClientId === "" ||
      githubClientSecret === undefined ||
      githubClientSecret === "";
    if (!missingCredentials) {
      missingCredentials =
        vercelClientId === undefined ||
        vercelClientId === "" ||
        vercelClientSecret === undefined ||
        vercelClientSecret === "";
    }
    if (missingCredentials) {
      throw new Error("Local provider emulation requires GitHub and Vercel OAuth credentials.");
    }
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
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
          getToken: (data) =>
            exchangeLocalEmulatedOAuthCode({
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
            // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
            const profile = (await response.json()) as {
              id?: number;
              login?: string;
              email?: string;
              name?: string;
              avatar_url?: string;
            };
            /* oxlint-disable typescript/strict-boolean-expressions -- Preserve the existing truthiness for supported values. */
            if (!profile.id || !profile.email) {
              return null;
            }
            /* oxlint-enable typescript/strict-boolean-expressions */
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
          // oxlint-disable-next-line typescript/promise-function-async -- Preserve the existing promise and synchronous exception behavior.
          getToken: (data) =>
            exchangeLocalEmulatedOAuthCode({
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
  return betterAuth({
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
    // oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
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
              if (localEmulation) {
                return [genericOAuth({ config: localProviderConfigs })];
              }
              if (config.vercelClientId === undefined || config.vercelClientSecret === undefined) {
                return [];
              }
              return [
                genericOAuth({
                  config: [
                    {
                      clientId: config.vercelClientId,
                      clientSecret: config.vercelClientSecret,
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
      if (localEmulation) {
        return {};
      }
      if (config.githubClientId === undefined || config.githubClientSecret === undefined) {
        return {};
      }
      return {
        github: {
          clientId: config.githubClientId,
          clientSecret: config.githubClientSecret,
          disableSignUp: false,
          getUserInfo: async (tokens) => {
            const result = await fetchVerifiedGitHubUserInfo(tokens);
            if (result === null) {
              return null;
            }
            return {
              ...result,
              // GitHub's own response contains additional profile fields
              // beyond the identity fields this boundary needs to inspect.
              // oxlint-disable-next-line typescript/no-unsafe-type-assertion, anti-slop/require-safety-comment-for-type-assertion -- Preserve the existing type assertion at this boundary.
              data: result.data as GithubProfile,
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
        if (
          !new Set(["github", "vercel"]).has(providerId) ||
          user.emailVerified !== true ||
          // oxlint-disable-next-line anti-slop/no-runtime-typeof -- Preserve this runtime check and existing input handling.
          typeof user.email !== "string" ||
          user.email.trim().length === 0
        ) {
          // oxlint-disable-next-line typescript/consistent-return -- Preserve the optional user-info validation result.
          return {
            error: "verified_provider_identity_required",
            errorDescription: "Use GitHub or Vercel with a verified email address.",
          };
        }
      },
    },
  });
}
