import { createHash } from "node:crypto";

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
    if (!local || url.pathname !== "/" || url.search || url.hash) {
      context.addIssue({
        code: "custom",
        message: "Emulator origin must be a loopback origin.",
      });
    }
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
    ) {
      context.addIssue({
        code: "custom",
        message: "Preview emulator origin must be a Vercel hostname.",
      });
    }
    return `https://${normalized}`;
  });

export function readVercelPreviewOrigin(
  hostname: string | undefined
): string | undefined {
  return hostname === undefined ? undefined : vercelHost.parse(hostname);
}

const branchSchema = z
  .string()
  .min(1)
  .max(255)
  .refine((value) => !/[\0\r\n]/u.test(value));

interface SharedProviderEmulation {
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
}

export type LocalProviderEmulation = SharedProviderEmulation & {
  mode: "local";
};

export type PreviewProviderEmulation = SharedProviderEmulation & {
  mode: "preview";
  namespace: string;
  branch: string;
};

export type ProviderEmulation =
  | LocalProviderEmulation
  | PreviewProviderEmulation;

export function previewEmulationNamespace(input: {
  repository: string;
  project: string;
  branch: string;
}) {
  return `${input.repository.toLowerCase()}:${input.project.toLowerCase()}:${input.branch}:seed-v2`;
}

export function readPreviewProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>
): PreviewProviderEmulation | undefined {
  if (environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === undefined) {
    return undefined;
  }
  if (
    environment.APP_BUILDER_PREVIEW_PROVIDER_EMULATION !== "1" ||
    environment.VERCEL_ENV !== "preview" ||
    environment.NODE_ENV !== "production"
  ) {
    throw new Error("Preview provider emulation is unavailable.");
  }

  const parsed = z
    .object({
      branch: branchSchema,
      githubClientId: z.string().min(1).max(255),
      githubClientSecret: z.string().min(20).max(512),
      githubRepository: repositorySchema,
      origin: vercelHost,
      project: z.string().min(1).max(255),
      relaySecret: z.string().min(32).max(512),
      repository: z.string().min(1).max(255),
      vercelClientId: z.string().min(1).max(255),
      vercelClientSecret: z.string().min(20).max(512),
    })
    .strict()
    .parse({
      branch: environment.VERCEL_GIT_COMMIT_REF,
      githubClientId: environment.EMULATE_PREVIEW_GITHUB_CLIENT_ID,
      githubClientSecret: environment.EMULATE_PREVIEW_GITHUB_CLIENT_SECRET,
      githubRepository:
        environment.EMULATE_GITHUB_REPOSITORY ?? "autograph-local/demo-app",
      origin: environment.VERCEL_BRANCH_URL ?? environment.VERCEL_URL,
      project: environment.VERCEL_PROJECT_ID,
      relaySecret: environment.EMULATE_PREVIEW_RELAY_SECRET,
      repository: environment.VERCEL_GIT_REPO_SLUG,
      vercelClientId: environment.EMULATE_PREVIEW_VERCEL_CLIENT_ID,
      vercelClientSecret: environment.EMULATE_PREVIEW_VERCEL_CLIENT_SECRET,
    });

  return {
    branch: parsed.branch,
    canonicalOrigin: parsed.origin,
    githubClientId: parsed.githubClientId,
    githubClientSecret: parsed.githubClientSecret,
    githubOrigin: `${parsed.origin}/api/emulate/github`,
    githubRepository: parsed.githubRepository,
    mode: "preview",
    namespace: previewEmulationNamespace(parsed),
    relaySecret: parsed.relaySecret,
    token: "emulate_preview_provider_token",
    vercelClientId: parsed.vercelClientId,
    vercelClientSecret: parsed.vercelClientSecret,
    vercelOrigin: `${parsed.origin}/api/emulate/vercel`,
  };
}

/** Development-only loopback transport. */
export function readLocalProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>
): LocalProviderEmulation | undefined {
  if (environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION === undefined) {
    return undefined;
  }
  if (
    environment.APP_BUILDER_LOCAL_PROVIDER_EMULATION !== "1" ||
    environment.NODE_ENV === "production" ||
    environment.VERCEL_ENV !== undefined
  ) {
    throw new Error("Local provider emulation is unavailable.");
  }
  const parsed = z
    .object({
      canonicalOrigin: z.string().url(),
      githubClientId: z.string().min(1).max(255),
      githubClientSecret: z.string().min(20).max(512),
      githubOrigin: localOrigin,
      githubRepository: repositorySchema,
      relaySecret: z.string().min(32).max(512),
      token: z.string().min(20).max(512),
      vercelClientId: z.string().min(1).max(255),
      vercelClientSecret: z.string().min(20).max(512),
      vercelOrigin: localOrigin,
    })
    .strict()
    .parse({
      canonicalOrigin: new URL(environment.BETTER_AUTH_URL ?? "").origin,
      githubClientId: environment.GITHUB_CLIENT_ID,
      githubClientSecret: environment.GITHUB_CLIENT_SECRET,
      githubOrigin: environment.GITHUB_EMULATOR_URL,
      githubRepository: environment.EMULATE_GITHUB_REPOSITORY,
      relaySecret: environment.EMULATE_LOCAL_RELAY_SECRET,
      token: environment.EMULATE_PROVIDER_TOKEN,
      vercelClientId: environment.VERCEL_AUTH_CLIENT_ID,
      vercelClientSecret: environment.VERCEL_AUTH_CLIENT_SECRET,
      vercelOrigin: environment.VERCEL_EMULATOR_URL,
    });
  return { mode: "local", ...parsed };
}

export function readProviderEmulation(
  environment: Readonly<Record<string, string | undefined>>
): ProviderEmulation | undefined {
  const local = readLocalProviderEmulation(environment);
  const preview = readPreviewProviderEmulation(environment);
  if (local && preview) {
    throw new Error("Provider emulation mode is ambiguous.");
  }
  return local ?? preview;
}

export function providerEmulationEnvironment(
  environment: Readonly<Record<string, string | undefined>>
) {
  const emulation = readProviderEmulation(environment);
  if (!emulation) {
    return environment;
  }
  if (emulation.mode === "local") {
    return { ...environment, APP_ORIGIN: emulation.canonicalOrigin };
  }
  return {
    ...environment,
    APP_ORIGIN: emulation.canonicalOrigin,
    BETTER_AUTH_URL: `${emulation.canonicalOrigin}/api/auth`,
    GITHUB_APP_CLIENT_ID: emulation.githubClientId,
    GITHUB_APP_CLIENT_SECRET: emulation.githubClientSecret,
    GITHUB_APP_ID: "12345",
    GITHUB_APP_INSTALL_STATE_SECRET: emulation.relaySecret,
    GITHUB_APP_SLUG: "autograph-app-builder",
    GITHUB_CLIENT_ID: emulation.githubClientId,
    GITHUB_CLIENT_SECRET: emulation.githubClientSecret,
    MCP_OAUTH_AUDIENCE: `${emulation.canonicalOrigin}/mcp`,
    MCP_OAUTH_ISSUER: `${emulation.canonicalOrigin}/api/auth`,
    MCP_OAUTH_JWKS_URL: `${emulation.canonicalOrigin}/api/auth/jwks`,
    MCP_RESOURCE_URL: `${emulation.canonicalOrigin}/mcp`,
    VERCEL_AUTH_CLIENT_ID: emulation.vercelClientId,
    VERCEL_AUTH_CLIENT_SECRET: emulation.vercelClientSecret,
    VERCEL_INTEGRATION_CLIENT_ID: emulation.vercelClientId,
    VERCEL_INTEGRATION_CLIENT_SECRET: emulation.vercelClientSecret,
    VERCEL_INTEGRATION_SLUG: "autograph-app-builder",
    VERCEL_INTEGRATION_TOKEN_KEY: createHash("sha256")
      .update(`preview-vercel-token:${emulation.relaySecret}`)
      .digest("base64"),
    VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "preview-emulation-v1",
  };
}
