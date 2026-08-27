import type { CimdOptions } from "@better-auth/cimd";
import type { McpOptions } from "@better-auth/mcp";
import { z } from "zod";

const previewOAuthConfigSchema = z
  .object({
    issuer: z.string().url().startsWith("https://"),
    resource: z.string().url().startsWith("https://"),
  })
  .strict()
  .superRefine((config, context) => {
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resource);
    if (
      issuer.username ||
      issuer.password ||
      issuer.search ||
      issuer.hash ||
      issuer.pathname !== "/api/auth"
    ) {
      context.addIssue({
        code: "custom",
        path: ["issuer"],
        message: "Preview OAuth issuer must be the exact /api/auth URL.",
      });
    }
    if (
      resource.username ||
      resource.password ||
      resource.search ||
      resource.hash ||
      resource.pathname !== "/mcp"
    ) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "Preview OAuth resource must be the exact /mcp URL.",
      });
    }
    if (issuer.origin !== resource.origin) {
      context.addIssue({
        code: "custom",
        path: ["resource"],
        message: "Preview OAuth issuer and resource must share one origin.",
      });
    }
  });

export const previewMcpScopes = [
  "eve:session",
  "eve:start",
  "eve:get",
  "eve:send",
  "eve:respond",
  "eve:cancel",
] as const;

export const previewEmailPasswordPolicy = {
  enabled: true,
  disableSignUp: true,
  minPasswordLength: 12,
  maxPasswordLength: 128,
} as const;

export interface PreviewOAuthMembershipAuthority {
  activeWorkspaceForUser(input: {
    issuer: string;
    audience: string;
    ownerUserId: string;
  }): Promise<string | undefined>;
  isActiveMember(input: {
    issuer: string;
    audience: string;
    workspaceId: string;
    ownerUserId: string;
  }): Promise<boolean>;
}

/**
 * Pure policy builder for the lazily mounted Preview authorization server.
 * Calling it cannot issue a token or create a client/grant; database and
 * protocol side effects remain request-time behavior behind the deployment
 * gate documented in docs/hosted-eve-bridge.md.
 */
export function buildPreviewMcpOAuthOptions(input: {
  config: unknown;
  membership: PreviewOAuthMembershipAuthority;
  now?: () => number;
}): McpOptions {
  const config = previewOAuthConfigSchema.parse(input.config);
  const now = input.now ?? Date.now;
  return {
    resource: config.resource,
    loginPage: "/auth/sign-in",
    consentPage: "/auth/consent",
    scopes: [...previewMcpScopes],
    grantTypes: ["authorization_code"],
    accessTokenExpiresIn: 300,
    resources: [
      {
        identifier: config.resource,
        accessTokenTtl: 300,
        allowedScopes: [...previewMcpScopes],
        signingAlgorithm: "ES256",
      },
    ],
    resourceSeedMode: "overwrite",
    clientRegistrationDefaultResources: [config.resource],
    clientRegistrationAllowedResources: [],
    clientRegistrationDefaultScopes: ["eve:session"],
    clientRegistrationAllowedScopes: previewMcpScopes.slice(1),
    clientRegistrationRequirePKCE: true,
    allowPublicClientPrelogin: true,
    clientPrivileges: async () => false,
    resourcePrivileges: async () => false,
    // Preview clients are resolved through CIMD. Dynamic registration remains
    // disabled, but activating CIMD can still persist discovery-owned client
    // records and therefore requires separate mutation authority.
    allowDynamicClientRegistration: false,
    allowUnauthenticatedClientRegistration: false,
    postLogin: {
      // Better Auth nests consent reference binding under postLogin. Returning
      // false keeps consent as the one user confirmation instead of adding a
      // second workspace-selection continuation when only one workspace is
      // eligible.
      page: "/auth/consent",
      shouldRedirect: async ({ user }) => {
        const workspaceId = await input.membership.activeWorkspaceForUser({
          issuer: config.issuer,
          audience: config.resource,
          ownerUserId: user.id,
        });
        if (workspaceId === undefined) {
          throw new Error(
            "Preview OAuth requires exactly one active workspace membership.",
          );
        }
        return false;
      },
      consentReferenceId: async ({ user }) => {
        const workspaceId = await input.membership.activeWorkspaceForUser({
          issuer: config.issuer,
          audience: config.resource,
          ownerUserId: user.id,
        });
        if (workspaceId === undefined) {
          throw new Error(
            "Preview OAuth requires exactly one active workspace membership.",
          );
        }
        return workspaceId;
      },
    },
    customAccessTokenClaims: async ({ user, referenceId, resources }) => {
      if (
        user === null ||
        user === undefined ||
        referenceId === undefined ||
        resources?.length !== 1 ||
        resources[0] !== config.resource ||
        !(await input.membership.isActiveMember({
          issuer: config.issuer,
          audience: config.resource,
          workspaceId: referenceId,
          ownerUserId: user.id,
        }))
      ) {
        throw new Error("Preview OAuth membership is not active.");
      }
      return {
        nbf: Math.floor(now() / 1_000),
        workspace_id: referenceId,
      };
    },
  };
}

export function buildPreviewCimdOptions(input: {
  fetchClientMetadataResource: CimdOptions["fetchClientMetadataResource"];
}): CimdOptions {
  return {
    fetchClientMetadataResource: async (resource, init) => {
      const response = await input.fetchClientMetadataResource(resource, init);
      if (!response.ok) return response;

      let document: unknown;
      try {
        document = await response.clone().json();
      } catch {
        throw new Error("Preview CIMD resources must be JSON documents.");
      }
      if (typeof document !== "object" || document === null) {
        throw new Error("Preview CIMD resources must be JSON objects.");
      }

      const record = document as Record<string, unknown>;
      const looksLikeClientMetadata =
        "client_name" in record ||
        "redirect_uris" in record ||
        "token_endpoint_auth_method" in record;
      if (!looksLikeClientMetadata && Array.isArray(record.keys)) {
        return response;
      }
      if (record.token_endpoint_auth_method !== "none") {
        throw new Error(
          "Preview CIMD clients must use token_endpoint_auth_method none.",
        );
      }
      // Native Codex advertises refresh_token as an optional client
      // capability. Preview intentionally has no continuation credential and
      // Better Auth requires every persisted client grant to be supported by
      // the server. Intersect only this known metadata pair with the closed
      // authorization-code grant; every other field still reaches Better Auth
      // for its normal redirect, response-type, and public-client validation.
      if (
        record.application_type === "native" &&
        Array.isArray(record.response_types) &&
        record.response_types.length === 1 &&
        record.response_types[0] === "code" &&
        Array.isArray(record.grant_types) &&
        record.grant_types.length === 2 &&
        record.grant_types.includes("authorization_code") &&
        record.grant_types.includes("refresh_token")
      ) {
        return Response.json(
          { ...record, grant_types: ["authorization_code"] },
          { status: response.status, statusText: response.statusText },
        );
      }
      return response;
    },
    metadataProfile: "mcp-2026-07-28",
  };
}

export function readPreviewOAuthContractConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return previewOAuthConfigSchema.parse({
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
  });
}
