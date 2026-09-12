import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { readGitHubAppInstallationEnvironment } from "../auth/github-app-installation";
import {
  createPostgresHostedGitHubInstallationStore,
  mergeHostedGitHubInstallationBindings,
} from "../repository/postgres-github-installation-store";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { loadGatewayModels } from "./ai-gateway-models";
import { builderIntegrationStateSchema } from "./builder-state";
import type { BuilderIntegrationState } from "./builder-state";
import { createPostgresVercelInstallationStore } from "./postgres-vercel-installation";
import { readVercelIntegrationEnvironment } from "./vercel-installation";
import { providerEmulationEnvironment } from "./local-provider-emulation";

type BuilderIntegrationRequest = {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  forceModels?: boolean;
} & (
  | { authenticated: false }
  | {
      authenticated: true;
      userId: string;
      organizationId: string;
      workspaceId: string;
    }
);

const databases = new Map<string, ReturnType<typeof openHostedPostgresDatabase>>();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function databaseFor(databaseUrl: string) {
  const existing = databases.get(databaseUrl);
  if (existing) return existing;
  const database = openHostedPostgresDatabase(databaseUrl);
  databases.set(databaseUrl, database);
  return database;
}

// Keep state loading scoped to the integration deployment boundary.
// oxlint-disable-next-line unicorn/consistent-function-scoping
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export async function loadBuilderIntegrationState(
  input: BuilderIntegrationRequest,
  loadModels: (input: { force?: boolean }) => Promise<BuilderIntegrationState["models"]> = () =>
    loadGatewayModels(),
): Promise<BuilderIntegrationState> {
  const environment = providerEmulationEnvironment(input.environment);
  const modelsPromise = loadModels({
    force: input.forceModels,
  });
  if (!input.authenticated) {
    return builderIntegrationStateSchema.parse({
      vercel: { status: "disconnected", scopes: [] },
      github: { status: "disconnected", scopes: [] },
      models: await modelsPromise,
    });
  }

  // Keep the state helper local to the integration boundary.
  // oxlint-disable-next-line unicorn/consistent-function-scoping
  const unavailable = (reason: "configuration-unavailable") => ({
    status: "unavailable" as const,
    scopes: [],
    unavailableReason: reason,
  });

  let preview: ReturnType<typeof readPreviewOAuthRuntimeConfig>;
  let database: ReturnType<typeof openHostedPostgresDatabase>;
  try {
    preview = readPreviewOAuthRuntimeConfig(environment);
    database = databaseFor(preview.databaseUrl);
  } catch {
    return builderIntegrationStateSchema.parse({
      vercel: unavailable("configuration-unavailable"),
      github: unavailable("configuration-unavailable"),
      models: await modelsPromise,
    });
  }

  const authority = {
    issuer: preview.issuer,
    audience: preview.resource,
    workspaceId: input.workspaceId,
    ownerUserId: input.userId,
  };

  const githubPromise = (async (): Promise<BuilderIntegrationState["github"]> => {
    try {
      readGitHubAppInstallationEnvironment(environment);
      const githubStore = createPostgresHostedGitHubInstallationStore(database);
      const [githubBindings = [], legacy] = await Promise.all([
        githubStore.list?.(authority),
        githubStore.read(authority),
      ]);
      const scopes = mergeHostedGitHubInstallationBindings(githubBindings, legacy)
        .filter((binding) => binding.active)
        .map((binding) => ({
          installationId: binding.installationId,
          status: "connected" as const,
          accountLogin: binding.accountLogin,
          accountType: binding.accountType,
        }));
      return { status: scopes.length ? "connected" : "disconnected", scopes };
    } catch {
      return unavailable("configuration-unavailable");
    }
  })();

  const vercelPromise = (async (): Promise<BuilderIntegrationState["vercel"]> => {
    try {
      const config = readVercelIntegrationEnvironment(environment);
      const bindings = await createPostgresVercelInstallationStore({
        database,
        config,
      }).list(authority);
      const scopes = bindings
        .filter((binding) => binding.active)
        .map((binding) => ({
          installationId: binding.installationId,
          status: "connected" as const,
          displayName: binding.displayName,
          slug: binding.slug,
          plan: binding.plan,
        }));
      return { status: scopes.length ? "connected" : "disconnected", scopes };
    } catch {
      return unavailable("configuration-unavailable");
    }
  })();

  const [github, vercel, models] = await Promise.all([githubPromise, vercelPromise, modelsPromise]);

  return builderIntegrationStateSchema.parse({
    vercel,
    github,
    models,
  });
}
