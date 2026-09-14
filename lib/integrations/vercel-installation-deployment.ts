import { z } from "zod";

import { ensurePreviewOAuthDeploymentSessionOrganization } from "../auth/preview-oauth-deployment";
import { createPostgresPreviewOrganizationAuthority } from "../auth/postgres-organization-user-authority";
import { readPreviewOAuthRuntimeConfig } from "../auth/preview-oauth-runtime";
import { openHostedPostgresDatabase } from "../mcp/hosted-route";
import {
  createPostgresVercelAuthorizationStateStore,
  createPostgresVercelInstallationStore,
} from "./postgres-vercel-installation";
import { logProviderConnectionFailure } from "./provider-connection-logging";
import type { ProviderConnectionFailureReason } from "./provider-connection-status";
import {
  providerConnectionRedirect,
  providerConnectionReturnFromFormData,
} from "./provider-connection-return";
import type { ProviderConnectionReturn } from "./provider-connection-return";
import {
  createVercelInstallationAuthorization,
  readVercelIntegrationEnvironment,
  VercelInstallationAuthorizationError,
  verifyVercelWebhook,
} from "./vercel-installation";
import { providerEmulationEnvironment, readProviderEmulation } from "./local-provider-emulation";
import { providerEmulationFetch } from "./provider-emulation-fetch";
import {
  signInForWorkspaceRedirect,
  workspaceOnboardingRedirect,
} from "../auth/workspace-onboarding";

const noStoreHeaders = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
} as const;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function deployment(environment: NodeJS.ProcessEnv | Record<string, string | undefined>) {
  const resolvedEnvironment = providerEmulationEnvironment(environment);
  const preview = readPreviewOAuthRuntimeConfig(resolvedEnvironment);
  const config = readVercelIntegrationEnvironment(resolvedEnvironment);
  const emulation = readProviderEmulation(resolvedEnvironment);
  const database = openHostedPostgresDatabase(preview.databaseUrl);
  const membership = createPostgresPreviewOrganizationAuthority(database, {
    audience: preview.resource,
    issuer: preview.issuer,
  });
  const installations = createPostgresVercelInstallationStore({
    config,
    database,
  });
  const authorityForRequest = async (request: Request) => {
    const session = await ensurePreviewOAuthDeploymentSessionOrganization({
      environment: resolvedEnvironment,
      headers: request.headers,
    });
    return session
      ? {
          audience: preview.resource,
          issuer: preview.issuer,
          ownerUserId: session.user.id,
          workspaceId: session.organization.workspaceId,
        }
      : undefined;
  };
  return {
    authorityForRequest,
    authorization: createVercelInstallationAuthorization({
      config,
      emulation,
      fetch: emulation
        ? (resource, init) => providerEmulationFetch(resource as string | URL, init, emulation)
        : undefined,
      installations,
      membership: {
        isActiveMember: (authority) => membership.isActiveMember(authority),
      },
      states: createPostgresVercelAuthorizationStateStore(database),
    }),
    config,
    installations,
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createVercelInstallationDeploymentHandler(
  kind: "start" | "callback",
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return async (request: Request) => {
    const startedAt = Date.now();
    const resolvedEnvironment = providerEmulationEnvironment(environment);
    const { origin } = new URL(resolvedEnvironment.APP_ORIGIN ?? request.url);
    const redirect = (
      status: "connected" | "failed",
      reason?: ProviderConnectionFailureReason,
      returnState?: ProviderConnectionReturn,
    ) =>
      new Response(null, {
        headers: {
          ...noStoreHeaders,
          Location: providerConnectionRedirect({
            origin,
            provider: "vercel",
            reason,
            returnState,
            status,
          }),
        },
        status: 303,
      });
    const fail = (
      reason: ProviderConnectionFailureReason,
      returnState?: ProviderConnectionReturn,
    ) => {
      logProviderConnectionFailure({
        phase: kind,
        provider: "vercel",
        reason,
        request,
        startedAt,
      });
      return redirect("failed", reason, returnState);
    };

    if (
      (kind === "start" &&
        (request.method !== "POST" ||
          request.headers.get("origin") !== origin ||
          request.headers.get("content-type")?.split(";", 1)[0] !==
            "application/x-www-form-urlencoded")) ||
      (kind === "callback" && request.method !== "GET")
    ) {
      return fail("request-invalid");
    }

    let runtime: ReturnType<typeof deployment>;
    try {
      runtime = deployment(environment);
    } catch {
      return fail("configuration-unavailable");
    }

    let authority: Awaited<ReturnType<typeof runtime.authorityForRequest>>;
    try {
      authority = await runtime.authorityForRequest(request);
    } catch {
      return new Response(null, {
        headers: {
          ...noStoreHeaders,
          Location: workspaceOnboardingRedirect(origin, "workspace-setup-retry"),
        },
        status: 303,
      });
    }
    if (!authority) {
      return new Response(null, {
        headers: {
          ...noStoreHeaders,
          Location: signInForWorkspaceRedirect(origin),
        },
        status: 303,
      });
    }

    try {
      if (kind === "start") {
        const returnState = providerConnectionReturnFromFormData(await request.formData());
        return new Response(null, {
          headers: {
            ...noStoreHeaders,
            Location: await runtime.authorization.begin(authority, returnState),
          },
          status: 303,
        });
      }
      const result = await runtime.authorization.complete(request.url, authority);
      return redirect("connected", undefined, result.returnState);
    } catch (error) {
      if (kind === "callback") {
        const detail =
          error instanceof Error &&
          /^(?:token-exchange-failed:[0-9]{3}:[a-z0-9_-]+|scope-read-failed|state-invalid|membership-inactive)$/u.test(
            error.message,
          )
            ? error.message
            : "invalid-response";
        console.error(
          JSON.stringify({
            detail,
            level: "error",
            message: "provider_connection_callback_detail",
            provider: "vercel",
          }),
        );
      }
      return fail(
        kind === "callback" ? "callback-invalid" : "authorization-failed",
        error instanceof VercelInstallationAuthorizationError ? error.returnState : undefined,
      );
    }
  };
}

const webhookSchema = z
  .object({
    payload: z
      .object({
        configuration: z
          .object({ id: z.string().min(1) })
          .passthrough()
          .optional(),
        configurationId: z.string().min(1).optional(),
      })
      .passthrough(),
    type: z.string(),
  })
  .passthrough();

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
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
          secret: runtime.config.clientSecret,
          signature: request.headers.get("x-vercel-signature"),
        })
      ) {
        return new Response("Invalid signature", { status: 401 });
      }
      const event = webhookSchema.parse(JSON.parse(body));
      if (event.type === "integration-configuration.removed") {
        const id = event.payload.configuration?.id ?? event.payload.configurationId;
        if (!id) {
          return new Response("Invalid event", { status: 400 });
        }
        await runtime.installations.deactivate(id, new Date());
      }
      return new Response(null, { status: 204 });
    } catch {
      return new Response("Webhook unavailable", { status: 503 });
    }
  };
}
