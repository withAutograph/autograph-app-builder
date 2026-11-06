import { z } from "zod";

import { createGitHubApp, createGitHubTokenOctokit } from "../github/octokit";
import { parseGitHubAppHttpProviderCredentials } from "./github-app-http-provider";

export const ARRUSTED_TEMPLATE_OWNER = "withAutograph";
export const ARRUSTED_TEMPLATE_NAME = "arrusted-development";
export const ARRUSTED_TEMPLATE_FULL_NAME = `${ARRUSTED_TEMPLATE_OWNER}/${ARRUSTED_TEMPLATE_NAME}`;
export const ARRUSTED_TEMPLATE_REPOSITORY_ID = 1_221_250_267;

const installationIdSchema = z.string().regex(/^[1-9]\d*$/u);
const tokenSchema = z.string().min(20).max(1024);
const repositorySchema = z.object({
  full_name: z.string(),
  id: z.number().int(),
  private: z.boolean(),
});
const repositoryInventorySchema = z.object({
  repositories: z.array(repositorySchema),
  total_count: z.number().int().nonnegative(),
});
const permissionSchema = z.record(z.string(), z.string());
type Repository = z.infer<typeof repositorySchema>;
type Permissions = z.infer<typeof permissionSchema>;

const requestedPermissions = {
  contents: "read" as const,
};

export interface ArrustedTemplateReaderConfig {
  appId: string;
  privateKey: string;
  installationId: string;
}

export interface ArrustedTemplateReader {
  acquire: () => Promise<{
    token: string;
  }>;
}

function privateTemplateRepository(repository: Repository) {
  if (repository.id !== ARRUSTED_TEMPLATE_REPOSITORY_ID) return false;
  if (repository.full_name !== ARRUSTED_TEMPLATE_FULL_NAME) return false;
  return repository.private;
}

function readOnlyReaderPermissions(permissions: Permissions) {
  if (permissions.contents !== "read") {
    return false;
  }
  if (permissions.metadata !== undefined && permissions.metadata !== "read") {
    return false;
  }
  return Object.values(permissions).every((permission) => permission === "read");
}

function exactTemplateRepositoryIds(repositoryIds: number[]) {
  if (repositoryIds.length !== 1) return false;
  return repositoryIds[0] === ARRUSTED_TEMPLATE_REPOSITORY_ID;
}

type TemplateReaderFailureStage =
  | "configuration"
  | "token_mint"
  | "token_shape"
  | "repository_inventory"
  | "repository_shape";

function unavailable(stage?: TemplateReaderFailureStage): never {
  if (stage !== undefined) {
    console.warn(
      JSON.stringify({
        event: "autograph.template-reader.failed",
        stage,
      }),
    );
  }
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
    unavailable("configuration");
  }
  const installation = installationIdSchema.safeParse(
    environment.APP_BUILDER_TEMPLATE_READER_INSTALLATION_ID,
  );
  if (!installation.success) {
    unavailable("configuration");
  }
  return { ...credentials, installationId: installation.data };
}

export function createArrustedTemplateReader(input: {
  config: ArrustedTemplateReaderConfig;
  fetch?: typeof fetch;
}): ArrustedTemplateReader {
  const installation = installationIdSchema.safeParse(input.config.installationId);
  if (!installation.success) {
    unavailable();
  }
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
      let authentication: unknown;
      try {
        authentication = await app.octokit.auth({
          installationId: installation.data,
          permissions: requestedPermissions,
          refresh: true,
          repositoryIds: [ARRUSTED_TEMPLATE_REPOSITORY_ID],
          type: "installation",
        });
      } catch {
        unavailable("token_mint");
      }
      const parsedAuthentication = z
        .object({
          permissions: permissionSchema,
          repositoryIds: z.array(z.number().int()),
          repositorySelection: z.enum(["all", "selected"]),
          token: tokenSchema,
          type: z.literal("token"),
        })
        .safeParse(authentication);
      if (!parsedAuthentication.success) {
        unavailable("token_shape");
      }
      if (!exactTemplateRepositoryIds(parsedAuthentication.data.repositoryIds)) {
        unavailable("token_shape");
      }
      if (!readOnlyReaderPermissions(parsedAuthentication.data.permissions)) {
        unavailable("token_shape");
      }
      const { token } = parsedAuthentication.data;

      let inventory;
      try {
        inventory = await createGitHubTokenOctokit({
          fetch: input.fetch,
          token,
        }).request("GET /installation/repositories", {
          page: 1,
          per_page: 100,
        });
      } catch {
        unavailable("repository_inventory");
      }
      const parsedInventory = repositoryInventorySchema.safeParse(inventory.data);
      if (!parsedInventory.success) {
        unavailable("repository_shape");
      }
      if (parsedInventory.data.total_count !== 1) {
        unavailable("repository_shape");
      }
      const [repository] = parsedInventory.data.repositories;
      if (repository === undefined || !privateTemplateRepository(repository)) {
        unavailable("repository_shape");
      }
      return { token };
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
