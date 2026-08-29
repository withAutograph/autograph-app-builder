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
import { logProviderConnectionFailure } from "../integrations/provider-connection-logging";
import type { ProviderConnectionFailureReason } from "../integrations/provider-connection-status";
import {
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
  type ProviderConnectionReturn,
} from "../integrations/provider-connection-return";

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
  const redirect = (
    status: "connected" | "failed",
    reason?: ProviderConnectionFailureReason,
    returnState?: ProviderConnectionReturn,
  ) =>
    new Response(null, {
      status: 303,
      headers: {
        ...noStoreHeaders,
        Location: providerConnectionRedirect({
          origin,
          provider: "github",
          status,
          reason,
          returnState,
        }),
      },
    });

  return {
    async start(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (reason: ProviderConnectionFailureReason) => {
        logProviderConnectionFailure({
          request,
          provider: "github",
          phase: "start",
          reason,
          startedAt,
        });
        return redirect("failed", reason);
      };
      if (
        request.method !== "POST" ||
        request.headers.get("origin") !== origin ||
        request.headers.get("content-type")?.split(";", 1)[0] !==
          "application/x-www-form-urlencoded"
      ) {
        return fail("request-invalid");
      }

      let authority: Authority | undefined;
      try {
        authority = await input.authorityForRequest(request);
      } catch {
        return fail("workspace-unavailable");
      }
      if (authority === undefined) return fail("workspace-unavailable");

      try {
        const returnState = providerConnectionReturnFromFormData(
          await request.formData(),
        );
        const result = await input.authorization.begin(authority, returnState);
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: result.redirectUrl,
          },
        });
      } catch {
        return fail("authorization-failed");
      }
    },

    async callback(request: Request): Promise<Response> {
      const startedAt = Date.now();
      const fail = (reason: ProviderConnectionFailureReason) => {
        logProviderConnectionFailure({
          request,
          provider: "github",
          phase: "callback",
          reason,
          startedAt,
        });
        return redirect("failed", reason);
      };
      if (request.method !== "GET") return fail("request-invalid");

      let authority: Authority | undefined;
      try {
        authority = await input.authorityForRequest(request);
      } catch {
        return fail("workspace-unavailable");
      }
      if (authority === undefined) return fail("workspace-unavailable");

      try {
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
        return redirect("connected", undefined, result.returnState);
      } catch {
        return fail("callback-invalid");
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
    const startedAt = Date.now();
    try {
      return await getGitHubAppInstallationDeploymentHandlers(environment)[
        kind
      ](request);
    } catch {
      logProviderConnectionFailure({
        request,
        provider: "github",
        phase: kind,
        reason: "configuration-unavailable",
        startedAt,
      });
      return new Response(null, {
        status: 303,
        headers: {
          ...noStoreHeaders,
          Location:
            "/github/installations?status=failed&reason=configuration-unavailable",
        },
      });
    }
  };
}
