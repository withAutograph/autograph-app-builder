import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins";
import { z } from "zod";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
  previewEmailPasswordPolicy,
  type PreviewOAuthMembershipAuthority,
} from "./preview-oauth-contract";
import { fetchPreviewClientMetadataResource } from "./preview-cimd-transport";

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

const previewOAuthRuntimeConfigSchema = z
  .object({
    hostedAdapter: z.literal("1"),
    vercelEnvironment: z.literal("preview"),
    configuredEnvironment: z.literal("preview"),
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

export function readPreviewOAuthRuntimeConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): PreviewOAuthRuntimeConfig {
  return previewOAuthRuntimeConfigSchema.parse({
    hostedAdapter: environment.EVE_HOSTED_ADAPTER,
    vercelEnvironment: environment.VERCEL_ENV,
    configuredEnvironment: environment.EVE_HOSTED_VERCEL_ENVIRONMENT,
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
    secret: environment.BETTER_AUTH_SECRET,
    databaseUrl: environment.DATABASE_URL,
    githubClientId: environment.GITHUB_CLIENT_ID,
    githubClientSecret: environment.GITHUB_CLIENT_SECRET,
  });
}

export function createPreviewOAuthServer(input: {
  config: PreviewOAuthRuntimeConfig;
  database: NonNullable<BetterAuthOptions["database"]>;
  membership: PreviewOAuthMembershipAuthority;
  fetchClientMetadata?: typeof fetchPreviewClientMetadataResource;
}) {
  const config = previewOAuthRuntimeConfigSchema.parse(input.config);
  const resourceOrigin = new URL(config.resource).origin;
  return betterAuth({
    appName: "Autograph App Builder Preview",
    baseURL: resourceOrigin,
    basePath: "/api/auth",
    secret: config.secret,
    database: input.database,
    trustedOrigins: [resourceOrigin],
    emailAndPassword: previewEmailPasswordPolicy,
    socialProviders: {
      github: {
        clientId: config.githubClientId,
        clientSecret: config.githubClientSecret,
        disableSignUp: true,
      },
    },
    account: {
      accountLinking: {
        enabled: false,
      },
    },
    session: {
      expiresIn: 60 * 60 * 8,
      updateAge: 60 * 60,
    },
    rateLimit: {
      enabled: true,
      window: 60,
      max: 60,
    },
    advanced: {
      cookiePrefix: "autograph_preview",
      useSecureCookies: true,
    },
    plugins: [
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
      nextCookies(),
    ],
  });
}
