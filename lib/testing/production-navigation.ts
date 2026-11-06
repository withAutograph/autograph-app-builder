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
  APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: z.url(),
  BETTER_AUTH_SECRET: secret,
  BETTER_AUTH_URL: z.url(),
  DATABASE_URL: z.url().max(8192),
  GITHUB_CLIENT_ID: credential,
  GITHUB_CLIENT_SECRET: credential,
  MCP_RESOURCE_URL: z.url(),
  NODE_ENV: z.literal("production"),
  VERCEL_AUTH_CLIENT_ID: credential,
  VERCEL_AUTH_CLIENT_SECRET: credential,
});

/** Test artifact authority, not a runtime environment feature flag. */
export const readProductionNavigationRuntimeConfig = function readProductionNavigationRuntimeConfig(
  environment: Record<string, string | undefined>,
) {
  if (!productionNavigationArtifact) {
    return null;
  }

  for (const [key, value] of Object.entries(environment)) {
    const isVercelKey = key.startsWith("VERCEL_");
    const isAuthClientKey = key.startsWith("VERCEL_AUTH_CLIENT_");
    const hasVercelIdentity = key === "VERCEL" || (isVercelKey && !isAuthClientKey);
    const hasDeploymentIdentity = [
      "DEPLOYMENT_ID",
      "PROJECT_ID",
      "APP_BUILDER_DEPLOYMENT_ID",
      "APP_BUILDER_PROJECT_ID",
    ].includes(key);
    if (value !== undefined && (hasVercelIdentity || hasDeploymentIdentity)) {
      throw new Error("Production navigation test artifacts cannot run with deployment identity.");
    }
  }
  const emulationVariables = [
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION,
    environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION,
    environment.APP_BUILDER_PROVIDER_EMULATION,
    environment.APP_BUILDER_PASSKEY_TEST_MODE,
  ];
  const hasLocalAuthEmulation = environment.APP_BUILDER_LOCAL_AUTH_EMULATION === "1";
  const hasProviderOrPasskeyEmulation = emulationVariables.some(
    (value) => value !== undefined && value !== "",
  );
  if (hasLocalAuthEmulation || hasProviderOrPasskeyEmulation) {
    throw new Error("Production navigation uses real sessions, not provider or passkey emulation.");
  }
  const config = environmentSchema.parse(environment);
  const origin = new URL(config.APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN);
  const invalidOriginProtocol = origin.protocol !== "https:";
  const invalidOriginHost = origin.hostname !== "localhost";
  const missingOriginPort = origin.port.length === 0;
  const invalidOrigin = invalidOriginProtocol || invalidOriginHost || missingOriginPort;
  const invalidOriginUrl = config.APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN !== origin.origin;
  const invalidAuthUrl = config.BETTER_AUTH_URL !== `${origin.origin}/api/auth`;
  const invalidMcpUrl = config.MCP_RESOURCE_URL !== `${origin.origin}/mcp`;
  const invalidResourceUrls = invalidOriginUrl || invalidAuthUrl || invalidMcpUrl;
  if (invalidOrigin || invalidResourceUrls) {
    throw new Error("Production navigation requires exact loopback HTTPS auth and resource URLs.");
  }
  const database = new URL(config.DATABASE_URL);
  const isPostgresProtocol = ["postgres:", "postgresql:"].includes(database.protocol);
  const isLoopbackDatabase = database.hostname === "127.0.0.1";
  const hasDatabasePort = database.port.length > 0;
  const invalidDatabaseAddress = !isPostgresProtocol || !isLoopbackDatabase || !hasDatabasePort;
  const hasIsolatedDatabasePath = /^\/autograph_navigation_[a-z0-9_]+$/u.test(database.pathname);
  const hasNoDatabaseQuery = database.search.length === 0;
  const hasNoDatabaseHash = database.hash.length === 0;
  const invalidDatabasePath = !hasIsolatedDatabasePath || !hasNoDatabaseQuery || !hasNoDatabaseHash;
  if (invalidDatabaseAddress || invalidDatabasePath) {
    throw new Error("Production navigation requires an isolated loopback fixture database.");
  }
  return {
    databaseUrl: config.DATABASE_URL,
    environment: "local" as const,
    githubClientId: config.GITHUB_CLIENT_ID,
    githubClientSecret: config.GITHUB_CLIENT_SECRET,
    hostedAdapter: "1" as const,
    issuer: config.BETTER_AUTH_URL,
    passkeyOnboarding: null,
    resource: config.MCP_RESOURCE_URL,
    secret: config.BETTER_AUTH_SECRET,
    trustedOrigins: [origin.origin],
    vercelClientId: config.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: config.VERCEL_AUTH_CLIENT_SECRET,
  };
};
