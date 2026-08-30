import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { readGitHubAppInstallationEnvironment } from "../auth/github-app-installation";
import {
  createPostgresHostedGitHubInstallationStore,
  mergeHostedGitHubInstallationBindings,
} from "../repository/postgres-github-installation-store";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { loadGatewayModels } from "./ai-gateway-models";
import {
  builderIntegrationStateSchema,
  type BuilderIntegrationState,
} from "./builder-state";
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

const databases = new Map<
  string,
  ReturnType<typeof openHostedPostgresDatabase>
>();

function databaseFor(databaseUrl: string) {
  const existing = databases.get(databaseUrl);
  if (existing) return existing;
  const database = openHostedPostgresDatabase(databaseUrl);
  databases.set(databaseUrl, database);
  return database;
}

export async function loadBuilderIntegrationState(
  input: BuilderIntegrationRequest,
): Promise<BuilderIntegrationState> {
  const environment = providerEmulationEnvironment(input.environment);
  const modelsPromise = loadGatewayModels({
    defaultModelId: environment.EVE_MODEL,
    force: input.forceModels,
  });
  if (!input.authenticated) {
    return builderIntegrationStateSchema.parse({
      vercel: { status: "disconnected", scopes: [] },
      github: { status: "disconnected", scopes: [] },
      models: await modelsPromise,
    });
  }

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

  let github: BuilderIntegrationState["github"] = unavailable(
    "configuration-unavailable",
  );
  try {
    readGitHubAppInstallationEnvironment(environment);
    const githubStore = createPostgresHostedGitHubInstallationStore(database);
    const githubBindings = (await githubStore.list?.(authority)) ?? [];
    const legacy = await githubStore.read(authority);
    const scopes = mergeHostedGitHubInstallationBindings(githubBindings, legacy)
      .filter((binding) => binding.active)
      .map((binding) => ({
        installationId: binding.installationId,
        status: "connected" as const,
        accountLogin: binding.accountLogin,
        accountType: binding.accountType,
      }));
    github = { status: scopes.length ? "connected" : "disconnected", scopes };
  } catch {}

  let vercel: BuilderIntegrationState["vercel"] = unavailable(
    "configuration-unavailable",
  );
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
    vercel = { status: scopes.length ? "connected" : "disconnected", scopes };
  } catch {}

  return builderIntegrationStateSchema.parse({
    vercel,
    github,
    models: await modelsPromise,
  });
}
