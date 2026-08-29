import { createPostgresOAuthMembershipAuthority } from "../eve/postgres-workspace-membership";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
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

  try {
    const preview = readPreviewOAuthRuntimeConfig(input.environment);
    const database = openHostedPostgresDatabase(preview.databaseUrl);
    const membership = createPostgresOAuthMembershipAuthority(database);
    const workspaceId = await membership.activeWorkspaceForUser({
      issuer: preview.issuer,
      audience: preview.resource,
      ownerUserId: input.userId,
    });
    if (!workspaceId) throw new Error("workspace-unavailable");
    const authority = {
      issuer: preview.issuer,
      audience: preview.resource,
      workspaceId,
      ownerUserId: input.userId,
    };

    const githubStore = createPostgresHostedGitHubInstallationStore(database);
    const githubBindings = (await githubStore.list?.(authority)) ?? [];
    const legacy = await githubStore.read(authority);
    const github = mergeHostedGitHubInstallationBindings(githubBindings, legacy)
      .filter((binding) => binding.active)
      .map((binding) => ({
        installationId: binding.installationId,
        status: "connected" as const,
        accountLogin: binding.accountLogin,
        accountType: binding.accountType,
      }));

    let vercel: BuilderIntegrationState["vercel"] = {
      status: "unavailable",
      scopes: [],
    };
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
    } catch {
      vercel = { status: "unavailable", scopes: [] };
    }

    return builderIntegrationStateSchema.parse({
      vercel,
      github: {
        status: github.length ? "connected" : "disconnected",
        scopes: github,
      },
      models: await modelsPromise,
    });
  } catch {
    return builderIntegrationStateSchema.parse({
      vercel: { status: "unavailable", scopes: [] },
      github: { status: "unavailable", scopes: [] },
      models: await modelsPromise,
    });
  }
}
