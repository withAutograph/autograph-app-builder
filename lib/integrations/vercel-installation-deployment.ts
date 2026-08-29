import { z } from "zod";

import { getPreviewOAuthDeploymentAuth } from "../auth/preview-oauth-deployment";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { createPostgresOAuthMembershipAuthority } from "../eve/postgres-workspace-membership";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createPostgresVercelAuthorizationStateStore,
  createPostgresVercelInstallationStore,
} from "./postgres-vercel-installation";
import {
  createVercelInstallationAuthorization,
  readVercelIntegrationEnvironment,
  verifyVercelWebhook,
} from "./vercel-installation";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

function deployment(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  const preview = readPreviewOAuthRuntimeConfig(environment);
  const config = readVercelIntegrationEnvironment(environment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  const membership = createPostgresOAuthMembershipAuthority(database);
  const installations = createPostgresVercelInstallationStore({
    database,
    config,
  });
  const auth = getPreviewOAuthDeploymentAuth(environment);
  const authorityForRequest = async (request: Request) => {
    const session = await auth.api.getSession({ headers: request.headers });
    if (!session?.user.id) return undefined;
    const workspaceId = await membership.activeWorkspaceForUser({
      issuer: preview.issuer,
      audience: preview.resource,
      ownerUserId: session.user.id,
    });
    return workspaceId
      ? {
          issuer: preview.issuer,
          audience: preview.resource,
          workspaceId,
          ownerUserId: session.user.id,
        }
      : undefined;
  };
  return {
    config,
    installations,
    authorityForRequest,
    authorization: createVercelInstallationAuthorization({
      config,
      states: createPostgresVercelAuthorizationStateStore(database),
      installations,
      membership: {
        isActiveMember: (authority) => membership.isActiveMember(authority),
      },
    }),
  };
}

export function createVercelInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request) => {
    const origin = new URL(environment.APP_ORIGIN ?? request.url).origin;
    const redirect = (status: "connected" | "failed") =>
      new Response(null, {
        status: 303,
        headers: { ...noStoreHeaders, Location: `${origin}/?vercel=${status}` },
      });
    try {
      const runtime = deployment(environment);
      const authority = await runtime.authorityForRequest(request);
      if (!authority) return redirect("failed");
      if (kind === "start") {
        if (
          request.method !== "POST" ||
          request.headers.get("origin") !== origin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/x-www-form-urlencoded"
        )
          return redirect("failed");
        return new Response(null, {
          status: 303,
          headers: {
            ...noStoreHeaders,
            Location: await runtime.authorization.begin(authority),
          },
        });
      }
      if (request.method !== "GET") return redirect("failed");
      await runtime.authorization.complete(request.url, authority);
      return redirect("connected");
    } catch {
      return redirect("failed");
    }
  };
}

const webhookSchema = z
  .object({
    type: z.string(),
    payload: z
      .object({
        configuration: z
          .object({ id: z.string().min(1) })
          .passthrough()
          .optional(),
        configurationId: z.string().min(1).optional(),
      })
      .passthrough(),
  })
  .passthrough();

export function createVercelWebhookDeploymentHandler(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request) => {
    try {
      const body = await request.text();
      const runtime = deployment(environment);
      if (
        !verifyVercelWebhook({
          body,
          signature: request.headers.get("x-vercel-signature"),
          secret: runtime.config.clientSecret,
        })
      )
        return new Response("Invalid signature", { status: 401 });
      const event = webhookSchema.parse(JSON.parse(body));
      if (event.type === "integration-configuration.removed") {
        const id =
          event.payload.configuration?.id ?? event.payload.configurationId;
        if (!id) return new Response("Invalid event", { status: 400 });
        await runtime.installations.deactivate(id, new Date());
      }
      return new Response(null, { status: 204 });
    } catch {
      return new Response("Webhook unavailable", { status: 503 });
    }
  };
}
