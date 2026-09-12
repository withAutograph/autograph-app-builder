import { z } from "zod";

import { productionNavigationArtifact } from "./production-navigation-artifact";

const secret = z
  .string()
  .min(32)
  .max(512)
  .regex(/^[^\0\r\n]+$/u);
const credential = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[^\0\r\n]+$/u);
const environmentSchema = z.object({
  NODE_ENV: z.literal("production"),
  APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: z.string().url(),
  BETTER_AUTH_URL: z.string().url(),
  MCP_RESOURCE_URL: z.string().url(),
  BETTER_AUTH_SECRET: secret,
  DATABASE_URL: z.string().url().max(8192),
  GITHUB_CLIENT_ID: credential,
  GITHUB_CLIENT_SECRET: credential,
  VERCEL_AUTH_CLIENT_ID: credential,
  VERCEL_AUTH_CLIENT_SECRET: credential,
});

/** Test artifact authority, not a runtime environment feature flag. */
export function readProductionNavigationRuntimeConfig(
  environment: Record<string, string | undefined>,
) {
  if (!productionNavigationArtifact) return null;

  for (const [key, value] of Object.entries(environment)) {
    if (
      value !== undefined &&
      (key === "VERCEL" ||
        (key.startsWith("VERCEL_") && !key.startsWith("VERCEL_AUTH_CLIENT_")) ||
        [
          "DEPLOYMENT_ID",
          "PROJECT_ID",
          "APP_BUILDER_DEPLOYMENT_ID",
          "APP_BUILDER_PROJECT_ID",
        ].includes(key))
    ) {
      throw new Error("Production navigation test artifacts cannot run with deployment identity.");
    }
  }
  if (
    environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "1" ||
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION ||
    environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION ||
    environment.APP_BUILDER_PROVIDER_EMULATION ||
    environment.APP_BUILDER_PASSKEY_TEST_MODE
  ) {
    throw new Error("Production navigation uses real sessions, not provider or passkey emulation.");
  }
  const config = environmentSchema.parse(environment);
  const origin = new URL(config.APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN);
  if (
    origin.protocol !== "https:" ||
    origin.hostname !== "localhost" ||
    !origin.port ||
    config.APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN !== origin.origin ||
    config.BETTER_AUTH_URL !== `${origin.origin}/api/auth` ||
    config.MCP_RESOURCE_URL !== `${origin.origin}/mcp`
  ) {
    throw new Error("Production navigation requires exact loopback HTTPS auth and resource URLs.");
  }
  const database = new URL(config.DATABASE_URL);
  if (
    !["postgres:", "postgresql:"].includes(database.protocol) ||
    database.hostname !== "127.0.0.1" ||
    !database.port ||
    !/^\/autograph_navigation_[a-z0-9_]+$/u.test(database.pathname) ||
    database.search ||
    database.hash
  ) {
    throw new Error("Production navigation requires an isolated loopback fixture database.");
  }
  return {
    hostedAdapter: "1" as const,
    environment: "local" as const,
    issuer: config.BETTER_AUTH_URL,
    resource: config.MCP_RESOURCE_URL,
    trustedOrigins: [origin.origin],
    secret: config.BETTER_AUTH_SECRET,
    databaseUrl: config.DATABASE_URL,
    githubClientId: config.GITHUB_CLIENT_ID,
    githubClientSecret: config.GITHUB_CLIENT_SECRET,
    vercelClientId: config.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: config.VERCEL_AUTH_CLIENT_SECRET,
    passkeyOnboarding: null,
  };
}
