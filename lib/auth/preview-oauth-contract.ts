import type { CimdOptions } from "@better-auth/cimd";
import type { McpOptions } from "@better-auth/mcp";
import { z } from "zod";

const previewOAuthConfigSchema = z
  .strictObject({
    issuer: z.url(),
    resource: z.url(),
  })
  .superRefine((config, context) => {
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resource);
    const issuerUsesHttps = issuer.protocol === "https:";
    const issuerUsesLocalHttp = issuer.protocol === "http:" && issuer.hostname === "localhost";
    const issuerUsesAllowedProtocol = issuerUsesHttps || issuerUsesLocalHttp;
    if (!issuerUsesAllowedProtocol) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth requires HTTPS or HTTP localhost.",
        path: ["issuer"],
      });
    }
    const issuerHasNoCredentials = !issuer.username && !issuer.password;
    const issuerHasNoSuffix = !issuer.search && !issuer.hash;
    const issuerHasNoCredentialsOrSuffix = issuerHasNoCredentials && issuerHasNoSuffix;
    if (!issuerHasNoCredentialsOrSuffix || issuer.pathname !== "/api/auth") {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth issuer must be the exact /api/auth URL.",
        path: ["issuer"],
      });
    }
    const resourceHasNoCredentials = !resource.username && !resource.password;
    const resourceHasNoSuffix = !resource.search && !resource.hash;
    const resourceHasNoCredentialsOrSuffix = resourceHasNoCredentials && resourceHasNoSuffix;
    if (!resourceHasNoCredentialsOrSuffix || resource.pathname !== "/mcp") {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth resource must be the exact /mcp URL.",
        path: ["resource"],
      });
    }
    if (issuer.origin !== resource.origin) {
      context.addIssue({
        code: "custom",
        message: "Preview OAuth issuer and resource must share one origin.",
        path: ["resource"],
      });
    }
  });

export const previewMcpScopes = [
  "autograph:session",
  "autograph:start",
  "autograph:get",
  "autograph:send",
  "autograph:respond",
  "autograph:cancel",
] as const;

export const previewOAuthScopes = [...previewMcpScopes, "offline_access"] as const;

const refreshTokenLifetimeSeconds = 60 * 60 * 8;

export interface PreviewOAuthMembershipAuthority {
  activeWorkspaceForUser: (input: {
    issuer: string;
    audience: string;
    ownerUserId: string;
  }) => Promise<string | undefined>;
  isActiveMember: (input: {
    issuer: string;
    audience: string;
    workspaceId: string;
    ownerUserId: string;
  }) => Promise<boolean>;
}

/**
 * Pure policy builder for the lazily mounted Preview authorization server.
 * Calling it cannot issue a token or create a client/grant; database and
 * protocol side effects remain request-time behavior behind the deployment
 * gate documented in docs/hosted-eve-bridge.md.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildPreviewMcpOAuthOptions(input: {
  config: unknown;
  membership: PreviewOAuthMembershipAuthority;
  now?: () => number;
}): McpOptions {
  const config = previewOAuthConfigSchema.parse(input.config);
  const now = input.now ?? Date.now;
  return {
    accessTokenExpiresIn: 300,
    // Preview clients are resolved through CIMD. Dynamic registration remains
    // disabled, but activating CIMD can still persist discovery-owned client
    // records and therefore requires separate mutation authority.
    allowDynamicClientRegistration: false,
    allowPublicClientPrelogin: true,
    allowUnauthenticatedClientRegistration: false,
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    clientPrivileges: async () => false,
    clientRegistrationAllowedResources: [],
    clientRegistrationAllowedScopes: previewOAuthScopes.slice(1),
    clientRegistrationDefaultResources: [config.resource],
    clientRegistrationDefaultScopes: ["autograph:session", "offline_access"],
    clientRegistrationRequirePKCE: true,
    consentPage: "/auth/consent",
    customAccessTokenClaims: async ({ user, referenceId, resources }) => {
      const hasSingleConfiguredResource = resources?.length === 1;
      const hasConfiguredResource = resources?.[0] === config.resource;
      const hasValidResource = hasSingleConfiguredResource && hasConfiguredResource;
      const hasUser = user !== null && user !== undefined;
      const hasReferenceId = referenceId !== undefined;
      if (!hasUser || !hasReferenceId || !hasValidResource) {
        throw new Error("Preview OAuth membership is not active.");
      }
      const isMember = await input.membership.isActiveMember({
        audience: config.resource,
        issuer: config.issuer,
        ownerUserId: user.id,
        workspaceId: referenceId,
      });
      if (!isMember) {
        throw new Error("Preview OAuth membership is not active.");
      }
      return {
        nbf: Math.floor(now() / 1000),
        workspace_id: referenceId,
      };
    },
    grantTypes: ["authorization_code", "refresh_token"],
    loginPage: "/auth/sign-in",
    postLogin: {
      consentReferenceId: async ({ user }) => {
        const workspaceId = await input.membership.activeWorkspaceForUser({
          audience: config.resource,
          issuer: config.issuer,
          ownerUserId: user.id,
        });
        if (workspaceId === undefined) {
          throw new Error("Preview OAuth requires exactly one active workspace membership.");
        }
        return workspaceId;
      },
      // Better Auth nests consent reference binding under postLogin. Returning
      // false keeps consent as the one user confirmation instead of adding a
      // second workspace-selection continuation when only one workspace is
      // eligible.
      page: "/auth/consent",
      shouldRedirect: async ({ user }) => {
        const workspaceId = await input.membership.activeWorkspaceForUser({
          audience: config.resource,
          issuer: config.issuer,
          ownerUserId: user.id,
        });
        if (workspaceId === undefined) {
          throw new Error("Preview OAuth requires exactly one active workspace membership.");
        }
        return false;
      },
    },
    refreshTokenExpiresIn: refreshTokenLifetimeSeconds,
    resource: config.resource,
    // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
    resourcePrivileges: async () => false,
    resourceSeedMode: "overwrite",
    resources: [
      {
        accessTokenTtl: 300,
        allowedScopes: [...previewOAuthScopes],
        identifier: config.resource,
        refreshTokenTtl: refreshTokenLifetimeSeconds,
        signingAlgorithm: "ES256",
      },
    ],
    scopes: [...previewOAuthScopes],
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function buildPreviewCimdOptions(input: {
  fetchClientMetadataResource: CimdOptions["fetchClientMetadataResource"];
}): CimdOptions {
  return {
    fetchClientMetadataResource: async (resource, init) => {
      const response = await input.fetchClientMetadataResource(resource, init);
      if (!response.ok) {
        return response;
      }

      let document: unknown;
      try {
        document = await response.clone().json();
      } catch {
        throw new Error("Preview CIMD resources must be JSON documents.");
      }
      const cimdDocumentSchema = z.object({
        client_name: z.string().optional(),
        keys: z.array(z.json()).optional(),
        redirect_uris: z.array(z.url()).optional(),
        token_endpoint_auth_method: z.string().optional(),
      });
      const parsedDocument = cimdDocumentSchema.safeParse(document);
      if (!parsedDocument.success) {
        throw new Error("Preview CIMD resources must be JSON objects.");
      }
      const record = parsedDocument.data;
      const looksLikeClientMetadata =
        "client_name" in record ||
        "redirect_uris" in record ||
        "token_endpoint_auth_method" in record;
      if (!looksLikeClientMetadata && Array.isArray(record.keys)) {
        return response;
      }
      if (record.token_endpoint_auth_method !== "none") {
        throw new Error("Preview CIMD clients must use token_endpoint_auth_method none.");
      }
      return response;
    },
    metadataProfile: "mcp-2026-07-28",
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readPreviewOAuthContractConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
) {
  return previewOAuthConfigSchema.parse({
    issuer: environment.BETTER_AUTH_URL,
    resource: environment.MCP_RESOURCE_URL,
  });
}
