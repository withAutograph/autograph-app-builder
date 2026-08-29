import { createPostgresOAuthMembershipAuthority } from "../eve/postgres-workspace-membership";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import { createPostgresHostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import {
  createGitHubAppInstallationAuthorization,
  readGitHubAppInstallationEnvironment,
} from "./github-app-installation";
import { getPreviewOAuthDeploymentAuth } from "./preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "./preview-oauth-runtime";
import { createPostgresGitHubInstallationAuthorizationStateStore } from "./postgres-github-installation-state";

type Authority = {
  issuer: string;
  audience: string;
  workspaceId: string;
  ownerUserId: string;
};

type InstallationAuthorization = ReturnType<
  typeof createGitHubAppInstallationAuthorization
>;

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

export function createGitHubAppInstallationRouteHandlers(input: {
  origin: string;
  authorityForRequest(request: Request): Promise<Authority | undefined>;
  authorization: InstallationAuthorization;
}) {
  const origin = new URL(input.origin).origin;
  const redirect = (status: "connected" | "failed") =>
    new Response(null, {
      status: 303,
      headers: {
        ...noStoreHeaders,
        Location:
          status === "connected"
            ? `${origin}/?github=connected`
            : `${origin}/github/installations?status=failed`,
      },
    });

  return {
    async start(request: Request): Promise<Response> {
      try {
        if (
          request.method !== "POST" ||
          request.headers.get("origin") !== origin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/x-www-form-urlencoded"
        ) {
          return redirect("failed");
        }
        const authority = await input.authorityForRequest(request);
        if (authority === undefined) return redirect("failed");
        const result = await input.authorization.begin(authority);
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: result.redirectUrl,
          },
        });
      } catch {
        return redirect("failed");
      }
    },

    async callback(request: Request): Promise<Response> {
      try {
        if (request.method !== "GET") return redirect("failed");
        const authority = await input.authorityForRequest(request);
        if (authority === undefined) return redirect("failed");
        const result = await input.authorization.complete(
          request.url,
          authority,
        );
        if (result.status === "redirect") {
          return new Response(null, {
            status: 303,
            headers: { ...noStoreHeaders, Location: result.redirectUrl },
          });
        }
        return redirect("connected");
      } catch {
        return redirect("failed");
      }
    },
  };
}

let deploymentHandlers:
  ReturnType<typeof createGitHubAppInstallationRouteHandlers> | undefined;

export function getGitHubAppInstallationDeploymentHandlers(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  if (deploymentHandlers !== undefined) return deploymentHandlers;
  const config = readGitHubAppInstallationEnvironment(environment);
  const previewConfig = readPreviewOAuthRuntimeConfig(environment);
  const database = openHostedPostgresDatabase(previewConfig.databaseUrl);
  const membership = createPostgresOAuthMembershipAuthority(database);
  const auth = getPreviewOAuthDeploymentAuth(environment);
  const authorization = createGitHubAppInstallationAuthorization({
    config,
    stateStore:
      createPostgresGitHubInstallationAuthorizationStateStore(database),
    membership: {
      isActiveMember: (authority) => membership.isActiveMember(authority),
    },
    installationStore: createPostgresHostedGitHubInstallationStore(database),
  });
  deploymentHandlers = createGitHubAppInstallationRouteHandlers({
    origin: new URL(config.issuer).origin,
    authorization,
    async authorityForRequest(request) {
      const session = await auth.api.getSession({ headers: request.headers });
      if (session?.user.id === undefined) return undefined;
      const workspaceId = await membership.activeWorkspaceForUser({
        issuer: config.issuer,
        audience: config.resource,
        ownerUserId: session.user.id,
      });
      if (workspaceId === undefined) return undefined;
      return {
        issuer: config.issuer,
        audience: config.resource,
        workspaceId,
        ownerUserId: session.user.id,
      };
    },
  });
  return deploymentHandlers;
}

export function createGitHubAppInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request): Promise<Response> => {
    try {
      return await getGitHubAppInstallationDeploymentHandlers(environment)[
        kind
      ](request);
    } catch {
      return new Response(null, {
        status: 303,
        headers: {
          ...noStoreHeaders,
          Location: "/github/installations?status=failed",
        },
      });
    }
  };
}
