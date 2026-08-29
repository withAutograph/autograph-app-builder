import { createPostgresOAuthMembershipAuthority } from "../eve/postgres-workspace-membership";
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

export async function loadBuilderIntegrationState(input: {
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>;
  userId?: string;
  forceModels?: boolean;
}): Promise<BuilderIntegrationState> {
  const modelsPromise = loadGatewayModels({
    defaultModelId: input.environment.EVE_MODEL,
    force: input.forceModels,
  });
  if (!input.userId) {
    return builderIntegrationStateSchema.parse({
      vercel: { status: "disconnected", scopes: [] },
      github: { status: "disconnected", scopes: [] },
      models: await modelsPromise,
    });
  }

  const unavailable = (
    reason: "configuration-unavailable" | "workspace-unavailable",
  ) => ({
    status: "unavailable" as const,
    scopes: [],
    unavailableReason: reason,
  });

  let preview: ReturnType<typeof readPreviewOAuthRuntimeConfig>;
  let database: ReturnType<typeof openHostedPostgresDatabase>;
  try {
    preview = readPreviewOAuthRuntimeConfig(input.environment);
    database = openHostedPostgresDatabase(preview.databaseUrl);
  } catch {
    return builderIntegrationStateSchema.parse({
      vercel: unavailable("configuration-unavailable"),
      github: unavailable("configuration-unavailable"),
      models: await modelsPromise,
    });
  }

  let workspaceId: string | undefined;
  try {
    const membership = createPostgresOAuthMembershipAuthority(database);
    workspaceId = await membership.activeWorkspaceForUser({
      issuer: preview.issuer,
      audience: preview.resource,
      ownerUserId: input.userId,
    });
  } catch {}
  if (!workspaceId) {
    return builderIntegrationStateSchema.parse({
      vercel: unavailable("workspace-unavailable"),
      github: unavailable("workspace-unavailable"),
      models: await modelsPromise,
    });
  }
  const authority = {
    issuer: preview.issuer,
    audience: preview.resource,
    workspaceId,
    ownerUserId: input.userId,
  };

  let github: BuilderIntegrationState["github"] = unavailable(
    "configuration-unavailable",
  );
  try {
    readGitHubAppInstallationEnvironment(input.environment);
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
    const config = readVercelIntegrationEnvironment(input.environment);
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
