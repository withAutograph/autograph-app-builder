import { z } from "zod";

import { createGitHubApp, createGitHubTokenOctokit } from "../github/octokit";
import { parseGitHubAppHttpProviderCredentials } from "./github-app-http-provider";

export const ARRUSTED_TEMPLATE_OWNER = "withAutograph";
export const ARRUSTED_TEMPLATE_NAME = "arrusted-development";
export const ARRUSTED_TEMPLATE_FULL_NAME = `${ARRUSTED_TEMPLATE_OWNER}/${ARRUSTED_TEMPLATE_NAME}`;

const installationIdSchema = z.string().regex(/^[1-9]\d*$/u);
const tokenSchema = z.string().min(20).max(1024);

const requestedPermissions = {
  contents: "read" as const,
  checks: "read" as const,
};

export type ArrustedTemplateReaderConfig = {
  appId: string;
  privateKey: string;
  installationId: string;
};

export type ArrustedTemplateReader = {
  acquire(): Promise<{ token: string }>;
};

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function privateTemplateRepository(value: unknown) {
  if (!record(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isSafeInteger(value.id) &&
    value.id > 0 &&
    value.full_name === ARRUSTED_TEMPLATE_FULL_NAME &&
    value.private === true
  );
}

function exactReaderPermissions(value: unknown) {
  if (!record(value)) return false;
  if (
    value.contents !== "read" ||
    value.checks !== "read" ||
    (value.metadata !== undefined && value.metadata !== "read")
  )
    return false;
  return Object.entries(value).every(
    ([key, permission]) =>
      (key === "metadata" || key === "contents" || key === "checks") &&
      permission === "read",
  );
}

function unavailable(): never {
  throw new Error("The Arrusted template reader is unavailable.");
}

/**
 * This is deliberately separate from the tenant-selected publishing
 * installation. It accepts only the deployment-owned fixed installation ID.
 */
export function readDeploymentArrustedTemplateReaderConfig(
  environment: Readonly<Record<string, string | undefined>>,
): ArrustedTemplateReaderConfig {
  let credentials: { appId: string; privateKey: string };
  try {
    credentials = parseGitHubAppHttpProviderCredentials({
      appId: environment.GITHUB_APP_ID,
      privateKey: environment.GITHUB_APP_PRIVATE_KEY,
    });
  } catch {
    unavailable();
  }
  const installation = installationIdSchema.safeParse(
    environment.APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID,
  );
  if (!installation.success) unavailable();
  return { ...credentials, installationId: installation.data };
}

export function createArrustedTemplateReader(input: {
  config: ArrustedTemplateReaderConfig;
  fetch?: typeof fetch;
}): ArrustedTemplateReader {
  const installation = installationIdSchema.safeParse(
    input.config.installationId,
  );
  if (!installation.success) unavailable();
  const credentials = parseGitHubAppHttpProviderCredentials({
    appId: input.config.appId,
    privateKey: input.config.privateKey,
  });
  const app = createGitHubApp({
    ...credentials,
    fetch: input.fetch,
  });

  return {
    async acquire() {
      try {
        const authentication: unknown = await app.octokit.auth({
          type: "installation",
          installationId: installation.data,
          permissions: requestedPermissions,
          refresh: true,
        });
        const parsedToken = record(authentication)
          ? tokenSchema.safeParse(authentication.token)
          : undefined;
        if (
          !record(authentication) ||
          authentication.type !== "token" ||
          parsedToken === undefined ||
          !parsedToken.success ||
          authentication.repositorySelection !== "selected" ||
          !exactReaderPermissions(authentication.permissions)
        )
          unavailable();
        const token = parsedToken.data;

        const inventory = await createGitHubTokenOctokit({
          token,
          fetch: input.fetch,
        }).request("GET /installation/repositories", {
          per_page: 100,
          page: 1,
        });
        const data: unknown = inventory.data;
        if (
          !record(data) ||
          data.total_count !== 1 ||
          !Array.isArray(data.repositories) ||
          data.repositories.length !== 1 ||
          !privateTemplateRepository(data.repositories[0])
        )
          unavailable();
        return { token };
      } catch {
        unavailable();
      }
    },
  };
}

export function deploymentArrustedTemplateReader(
  environment: Readonly<Record<string, string | undefined>> = process.env,
) {
  return createArrustedTemplateReader({
    config: readDeploymentArrustedTemplateReaderConfig(environment),
  });
}
