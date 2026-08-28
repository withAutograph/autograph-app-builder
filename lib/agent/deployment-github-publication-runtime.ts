import { z } from "zod";

import { parseHostedDatabaseUrl } from "../db/postgres-connection-policy";
import { readHostedForwarderSubject } from "../eve/hosted-forwarder";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createGitHubAppPublicationAdapter } from "../repository/github-app-adapter";
import {
  createGitHubAppHttpProvider,
  parseGitHubAppHttpProviderCredentials,
  type GitHubAppHttpProviderConfig,
} from "../repository/github-app-http-provider";
import type { GitHubPublicationAdapter } from "../repository/github-publication";
import {
  createHostedGitHubPublicationRuntimeResolver,
  type HostedGitHubPublicationRuntimeResolver,
  type HostedGitHubPublicationRuntimeResolverDependencies,
} from "./hosted-github-publication-runtime";

const enabledSchema = z.enum(["0", "1"]);

export type DeploymentGitHubPublicationConfig =
  | { enabled: false }
  | {
      enabled: true;
      databaseUrl: string;
      forwarderSubject: string;
      providerCredentials: {
        appId: string;
        privateKey: string;
      };
    };

function rejectAmbientGitHubAuthority(
  environment: Readonly<Record<string, string | undefined>>,
): void {
  if (
    environment.GITHUB_APP_INSTALLATION_ID !== undefined ||
    environment.GITHUB_TOKEN !== undefined ||
    environment.GITHUB_API_URL !== undefined
  ) {
    throw new Error(
      "Hosted GitHub publication contains forbidden ambient authority.",
    );
  }
}

export function readDeploymentGitHubPublicationConfig(
  environment: Readonly<Record<string, string | undefined>>,
): DeploymentGitHubPublicationConfig {
  rejectAmbientGitHubAuthority(environment);
  const rawEnabled = environment.APP_BUILDER_GITHUB_PUBLICATION_ENABLED;
  if (rawEnabled === undefined) return { enabled: false };
  const enabled = enabledSchema.safeParse(rawEnabled);
  if (!enabled.success) {
    throw new Error(
      "APP_BUILDER_GITHUB_PUBLICATION_ENABLED must be exactly 0 or 1.",
    );
  }
  if (enabled.data === "0") return { enabled: false };
  if (
    environment.EVE_HOSTED_ADAPTER !== "1" ||
    environment.VERCEL_ENV !== "preview" ||
    environment.EVE_HOSTED_VERCEL_ENVIRONMENT !== "preview"
  ) {
    throw new Error(
      "Hosted GitHub publication requires the exact Preview hosted deployment.",
    );
  }
  const forwarderSubject = readHostedForwarderSubject(environment);
  if (forwarderSubject === undefined) {
    throw new Error(
      "Hosted GitHub publication requires the exact Preview forwarder binding.",
    );
  }
  const providerCredentials = parseGitHubAppHttpProviderCredentials({
    appId: environment.GITHUB_APP_ID,
    privateKey: environment.GITHUB_APP_PRIVATE_KEY,
  });
  return {
    enabled: true,
    databaseUrl: parseHostedDatabaseUrl(environment.DATABASE_URL),
    forwarderSubject,
    providerCredentials,
  };
}

type Database = ReturnType<typeof openHostedPostgresDatabase>;

export function createDeploymentGitHubPublicationRuntimeResolver(input: {
  environment: Readonly<Record<string, string | undefined>>;
  openDatabase?: (databaseUrl: string) => Database | Promise<Database>;
  createAdapter?: (
    config: GitHubAppHttpProviderConfig,
  ) => GitHubPublicationAdapter;
  fetchImplementation?: typeof fetch;
  now?: () => number;
  resolverDependencies?: Partial<HostedGitHubPublicationRuntimeResolverDependencies>;
}): HostedGitHubPublicationRuntimeResolver {
  const config = readDeploymentGitHubPublicationConfig(input.environment);
  if (!config.enabled) {
    return createHostedGitHubPublicationRuntimeResolver({ enabled: false });
  }
  const openDatabase = input.openDatabase ?? openHostedPostgresDatabase;
  const createAdapter =
    input.createAdapter ??
    ((providerConfig: GitHubAppHttpProviderConfig) =>
      createGitHubAppPublicationAdapter(
        createGitHubAppHttpProvider({
          config: providerConfig,
          fetch: input.fetchImplementation,
          now: input.now,
        }),
      ));
  return createHostedGitHubPublicationRuntimeResolver({
    enabled: true,
    openDatabase: () => openDatabase(config.databaseUrl),
    providerFactory: ({ installation }) =>
      createAdapter({
        ...config.providerCredentials,
        installationId: installation.installationId,
      }),
    dependencies: input.resolverDependencies,
  });
}

let defaultResolver: HostedGitHubPublicationRuntimeResolver | undefined;

/** Lazily parses deployment configuration so local discovery stays disabled. */
export async function githubPublicationRuntimeForSession(sessionAuth: unknown) {
  defaultResolver ??= createDeploymentGitHubPublicationRuntimeResolver({
    environment: process.env,
  });
  return defaultResolver.resolve(sessionAuth);
}
