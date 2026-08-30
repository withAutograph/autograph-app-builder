import { z } from "zod";

const repositorySchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u);

const localOrigin = z
  .string()
  .url()
  .transform((value, context) => {
    const url = new URL(value);
    const local =
      (url.protocol === "http:" &&
        ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) ||
      (url.protocol === "https:" &&
        url.hostname.endsWith(".emulate.localhost"));
    if (!local || url.pathname !== "/" || url.search || url.hash)
      context.addIssue({
        code: "custom",
        message: "Emulator origin must be a loopback origin.",
      });
    return url.origin;
  });

const vercelHost = z
  .string()
  .min(1)
  .max(253)
  .transform((value, context) => {
    const normalized = value.toLowerCase();
    if (
      !normalized.endsWith(".vercel.app") ||
      !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.vercel\.app$/u.test(normalized)
    )
      context.addIssue({
        code: "custom",
        message: "Preview emulator origin must be a Vercel hostname.",
      });
    return `https://${normalized}`;
  });

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/u.test(value));

type SharedProviderEmulation = {
  canonicalOrigin: string;
  vercelOrigin: string;
  githubOrigin: string;
  token: string;
  githubRepository: string;
  relaySecret: string;
  githubClientId: string;
  githubClientSecret: string;
  vercelClientId: string;
  vercelClientSecret: string;
};

export type LocalProviderEmulation = SharedProviderEmulation & {
  mode: "local";
};

export type PreviewProviderEmulation = SharedProviderEmulation & {
  mode: "preview";
  namespace: string;
  branch: string;
};

export type ProviderEmulation =
  LocalProviderEmulation | PreviewProviderEmulation;

export function previewEmulationNamespace(input: {
  repository: string;
  project: string;
  branch: string;
}) {
  return `${input.repository.toLowerCase()}:${input.project.toLowerCase()}:${input.branch}`;
}

export function readPreviewProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>,
): PreviewProviderEmulation | undefined {
  if (environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === undefined)
    return undefined;
  if (
    environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION !== "1" ||
    environment.VERCEL_ENV !== "preview" ||
    environment.NODE_ENV !== "production"
  )
    throw new Error("Preview provider emulation is unavailable.");

  const parsed = z
    .object({
      origin: vercelHost,
      branch: branchSchema,
      repository: z.string().min(1).max(255),
      project: z.string().min(1).max(255),
      githubRepository: repositorySchema,
      relaySecret: z.string().min(32).max(512),
      githubClientId: z.string().min(1).max(255),
      githubClientSecret: z.string().min(20).max(512),
      vercelClientId: z.string().min(1).max(255),
      vercelClientSecret: z.string().min(20).max(512),
    })
    .strict()
    .parse({
      origin: environment.VERCEL_BRANCH_URL ?? environment.VERCEL_URL,
      branch: environment.VERCEL_GIT_COMMIT_REF,
      repository: environment.VERCEL_GIT_REPO_SLUG,
      project: environment.VERCEL_PROJECT_ID,
      githubRepository:
        environment.EMULATE_GITHUB_REPOSITORY ?? "autograph-local/demo-app",
      relaySecret: environment.EMULATE_PREVIEW_RELAY_SECRET,
      githubClientId: environment.EMULATE_PREVIEW_GITHUB_CLIENT_ID,
      githubClientSecret: environment.EMULATE_PREVIEW_GITHUB_CLIENT_SECRET,
      vercelClientId: environment.EMULATE_PREVIEW_VERCEL_CLIENT_ID,
      vercelClientSecret: environment.EMULATE_PREVIEW_VERCEL_CLIENT_SECRET,
    });

  return {
    mode: "preview",
    canonicalOrigin: parsed.origin,
    vercelOrigin: `${parsed.origin}/api/emulate/vercel`,
    githubOrigin: `${parsed.origin}/api/emulate/github`,
    token: "emulate_preview_provider_token",
    githubRepository: parsed.githubRepository,
    relaySecret: parsed.relaySecret,
    githubClientId: parsed.githubClientId,
    githubClientSecret: parsed.githubClientSecret,
    vercelClientId: parsed.vercelClientId,
    vercelClientSecret: parsed.vercelClientSecret,
    branch: parsed.branch,
    namespace: previewEmulationNamespace(parsed),
  };
}

/** Development-only loopback transport. */
export function readLocalProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>,
): LocalProviderEmulation | undefined {
  if (environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === undefined)
    return undefined;
  if (
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1" ||
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV !== undefined
  )
    throw new Error("Local provider emulation is unavailable.");
  const parsed = z
    .object({
      canonicalOrigin: z.string().url(),
      vercelOrigin: localOrigin,
      githubOrigin: localOrigin,
      token: z.string().min(20).max(512),
      githubRepository: repositorySchema,
      relaySecret: z.string().min(32).max(512),
      githubClientId: z.string().min(1).max(255),
      githubClientSecret: z.string().min(20).max(512),
      vercelClientId: z.string().min(1).max(255),
      vercelClientSecret: z.string().min(20).max(512),
    })
    .strict()
    .parse({
      canonicalOrigin: new URL(environment.BETTER_AUTH_URL ?? "").origin,
      vercelOrigin: environment.VERCEL_EMULATOR_URL,
      githubOrigin: environment.GITHUB_EMULATOR_URL,
      token: environment.EMULATE_PROVIDER_TOKEN,
      githubRepository: environment.EMULATE_GITHUB_REPOSITORY,
      relaySecret: environment.EMULATE_LOCAL_RELAY_SECRET,
      githubClientId: environment.GITHUB_CLIENT_ID,
      githubClientSecret: environment.GITHUB_CLIENT_SECRET,
      vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
      vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
    });
  return { mode: "local", ...parsed };
}

export function readProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>,
): ProviderEmulation | undefined {
  const local = readLocalProviderEmulation(environment);
  const preview = readPreviewProviderEmulation(environment);
  if (local && preview)
    throw new Error("Provider emulation mode is ambiguous.");
  return local ?? preview;
}

export function providerEmulationEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
) {
  const emulation = readProviderEmulation(environment);
  if (!emulation || emulation.mode === "local") return environment;
  return {
    ...environment,
    APP_ORIGIN: emulation.canonicalOrigin,
    BETTER_AUTH_URL: `${emulation.canonicalOrigin}/api/auth`,
    MCP_RESOURCE_URL: `${emulation.canonicalOrigin}/mcp`,
    MCP_OAUTH_ISSUER: `${emulation.canonicalOrigin}/api/auth`,
    MCP_OAUTH_AUDIENCE: `${emulation.canonicalOrigin}/mcp`,
    MCP_OAUTH_JWKS_URL: `${emulation.canonicalOrigin}/api/auth/jwks`,
    GITHUB_CLIENT_ID: emulation.githubClientId,
    GITHUB_CLIENT_SECRET: emulation.githubClientSecret,
    GITHUB_APP_CLIENT_ID: emulation.githubClientId,
    GITHUB_APP_CLIENT_SECRET: emulation.githubClientSecret,
    VERCEL_AUTH_CLIENT_ID: emulation.vercelClientId,
    VERCEL_AUTH_CLIENT_SECRET: emulation.vercelClientSecret,
    VERCEL_INTEGRATION_CLIENT_ID: emulation.vercelClientId,
    VERCEL_INTEGRATION_CLIENT_SECRET: emulation.vercelClientSecret,
  };
}
