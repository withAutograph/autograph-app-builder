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

const selfServiceSignupEnvironmentSchema = z
  .enum(["0", "1"])
  .default("0")
  .transform((value) => value === "1");

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
    hostedAdapter: z.literal("1"),
    environment: z.union([
      hostedDeploymentEnvironmentSchema,
      z.literal("local"),
    ]),
    issuer: z.string().url().startsWith("https://"),
    resource: z.string().url().startsWith("https://"),
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
      .refine((value) => !/[\0\r\n]/u.test(value)),
    githubClientSecret: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    vercelClientId: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    vercelClientSecret: z
      .string()
      .min(1)
      .max(512)
      .refine((value) => !/[\0\r\n]/u.test(value)),
    selfServiceSignupEnabled: z.boolean(),
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

export function readPreviewOAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthRuntimeConfig {
  const localEmulation = readLocalProviderEmulation(environment);
  if (localEmulation) {
    if (environment.APP_BUILDER_LOCAL_AUTH_EMULATION !== "1") {
      throw new Error("Local authentication emulation is unavailable.");
    }
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
      selfServiceSignupEnabled: selfServiceSignupEnvironmentSchema.parse(
        environment.SELF_SERVICE_SIGNUP_ENABLED,
      ),
    });
  }
  const deploymentEnvironment = readHostedDeploymentEnvironment(environment);
  return previewOAuthRuntimeConfigSchema.parse({
    hostedAdapter: environment.EVE_HOSTED_ADAPTER,
    environment: deploymentEnvironment,
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
    secret: environment.BETTER_AUTH_SECRET,
    databaseUrl: environment.DATABASE_URL,
    githubClientId: environment.GITHUB_CLIENT_ID,
    githubClientSecret: environment.GITHUB_CLIENT_SECRET,
    vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
    selfServiceSignupEnabled: selfServiceSignupEnvironmentSchema.parse(
      environment.SELF_SERVICE_SIGNUP_ENABLED,
    ),
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
  const localEmulation =
    config.environment === "local"
      ? readLocalProviderEmulation(process.env)
      : undefined;
  const localProviderConfigs: GenericOAuthConfig[] = localEmulation
    ? [
        {
          providerId: "github",
          name: "GitHub",
          authorizationUrl: `${localEmulation.githubOrigin}/login/oauth/authorize`,
          tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
          clientId: config.githubClientId,
          clientSecret: config.githubClientSecret,
          tokenEndpointAuth: { method: "client_secret_post" },
          accountIssuer: localEmulation.githubOrigin,
          scopes: ["read:user", "user:email"],
          getToken: (data) =>
            exchangeLocalEmulatedOAuthCode({
              tokenUrl: `${localEmulation.githubOrigin}/login/oauth/access_token`,
              clientId: config.githubClientId,
              clientSecret: config.githubClientSecret,
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
          authorizationUrl: `${localEmulation.vercelOrigin}/oauth/authorize`,
          tokenUrl: `${localEmulation.vercelOrigin}/login/oauth/token`,
          clientId: config.vercelClientId,
          clientSecret: config.vercelClientSecret,
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
              clientId: config.vercelClientId,
              clientSecret: config.vercelClientSecret,
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
  const resourceOrigin = new URL(config.resource).origin;
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
      : {
          github: {
            clientId: config.githubClientId,
            clientSecret: config.githubClientSecret,
            disableSignUp: false,
            overrideUserInfoOnSignIn: false,
          },
        },
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
    rateLimit: previewOAuthRateLimit,
    advanced: {
      cookiePrefix:
        config.environment === "preview"
          ? "autograph_preview"
          : "autograph_app_builder",
      useSecureCookies: true,
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
            input.fetchClientMetadata ?? fetchPreviewClientMetadataResource,
        }),
      ),
      genericOAuth({
        config: [
          ...localProviderConfigs,
          ...(localEmulation
            ? []
            : [
                {
                  providerId: "vercel",
                  name: "Vercel",
                  discoveryUrl:
                    "https://vercel.com/.well-known/openid-configuration",
                  requireIdTokenVerification: true,
                  clientId: config.vercelClientId,
                  clientSecret: config.vercelClientSecret,
                  tokenEndpointAuth: { method: "client_secret_post" as const },
                  scopes: ["openid", "email", "profile"],
                  getUserInfo: fetchVerifiedVercelUserInfo,
                  disableSignUp: false,
                  overrideUserInfo: false,
                },
              ]),
        ],
      }),
      nextCookies(),
    ],
  });
}
