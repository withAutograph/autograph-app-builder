import { createRemoteJWKSet, customFetch, decodeProtectedHeader, jwtVerify } from "jose";
import { z } from "zod";

import { verifiedHostedClaimsSchema } from "../eve/hosted-auth";
import type { VerifiedHostedClaims } from "../eve/hosted-auth";

const strongAlgorithmSchema = z.enum(["RS256", "PS256", "ES256", "EdDSA"]);

export const hostedMcpAuthConfigSchema = z
  .object({
    algorithm: strongAlgorithmSchema,
    audience: z.string().url().startsWith("https://"),
    issuer: z.string().url().startsWith("https://"),
    jwksUrl: z.string().url().startsWith("https://"),
    resourceUrl: z.string().url().startsWith("https://"),
  })
  .strict()
  .superRefine((config, context) => {
    for (const [field, value] of [
      ["issuer", config.issuer],
      ["jwksUrl", config.jwksUrl],
      ["resourceUrl", config.resourceUrl],
    ] as const) {
      const url = new URL(value);
      if (url.username || url.password || url.hash || url.search) {
        context.addIssue({
          code: "custom",
          message: `${field} cannot contain credentials, query, or fragment.`,
          path: [field],
        });
      }
    }
    if (config.audience !== config.resourceUrl) {
      context.addIssue({
        code: "custom",
        message: "audience must equal the protected resource URL.",
        path: ["audience"],
      });
    }
    const issuer = new URL(config.issuer);
    const resource = new URL(config.resourceUrl);
    const jwks = new URL(config.jwksUrl);
    if (issuer.pathname !== "/api/auth") {
      context.addIssue({
        code: "custom",
        message: "issuer must be the exact /api/auth URL.",
        path: ["issuer"],
      });
    }
    if (resource.pathname !== "/mcp") {
      context.addIssue({
        code: "custom",
        message: "resourceUrl must be the exact /mcp URL.",
        path: ["resourceUrl"],
      });
    }
    if (issuer.origin !== resource.origin) {
      context.addIssue({
        code: "custom",
        message: "issuer and resourceUrl must share one origin.",
        path: ["resourceUrl"],
      });
    }
    if (jwks.origin !== issuer.origin || jwks.pathname !== "/api/auth/jwks") {
      context.addIssue({
        code: "custom",
        message: "jwksUrl must be the exact issuer /api/auth/jwks URL.",
        path: ["jwksUrl"],
      });
    }
  });

export type HostedMcpAuthConfig = z.infer<typeof hostedMcpAuthConfigSchema>;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function readHostedMcpAuthConfig(
  environment: NodeJS.ProcessEnv | Record<string, string | undefined>,
): HostedMcpAuthConfig {
  return hostedMcpAuthConfigSchema.parse({
    algorithm: environment.MCP_OAUTH_ALGORITHM,
    audience: environment.MCP_OAUTH_AUDIENCE,
    issuer: environment.MCP_OAUTH_ISSUER,
    jwksUrl: environment.MCP_OAUTH_JWKS_URL,
    resourceUrl: environment.MCP_RESOURCE_URL,
  });
}

export class BearerAuthorizationError extends Error {
  constructor() {
    super("A single strict Bearer authorization value is required.");
    this.name = "BearerAuthorizationError";
  }
}

// RFC 6750 b64token: one or more token characters followed only by optional
// padding. In particular, embedded padding and combined header values fail.
const bearerTokenPattern = /^[A-Za-z0-9._~+/-]+=*$/u;

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function parseStrictBearerAuthorization(authorization: string | null): string {
  if (authorization === null) {throw new BearerAuthorizationError();}
  const match = /^Bearer (?<token>[^ ]+)$/iu.exec(authorization);
  if (match === null || !bearerTokenPattern.test(match[1]) || match[1].includes(",")) {
    throw new BearerAuthorizationError();
  }
  return match[1];
}

export interface HostedAccessTokenVerifier {
  verify: (input: { token: string; nowEpochSeconds: number }) => Promise<VerifiedHostedClaims>;
}

const oauthScopeTokenPattern =
  /^[\u0021\u0023-\u005B\u005D-\u007E]+(?: [\u0021\u0023-\u005B\u005D-\u007E]+)*$/u;

/**
 * Exact remote-JWKS verifier. Redirects are rejected and the configured URL,
 * issuer, audience, algorithm, key ID, expiry, and not-before time are all
 * mandatory. Only the closed claims projection leaves this boundary.
 */
// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function createRemoteJwksAccessTokenVerifier(input: {
  config: HostedMcpAuthConfig;
  fetchImplementation?: typeof fetch;
}): HostedAccessTokenVerifier {
  const config = hostedMcpAuthConfigSchema.parse(input.config);
  const configuredJwksUrl = new URL(config.jwksUrl);
  const fetchImplementation = input.fetchImplementation ?? fetch;
  const remoteJwks = createRemoteJWKSet(configuredJwksUrl, {
    cacheMaxAge: 600_000,
    cooldownDuration: 30_000,
    [customFetch]: async (url, options) => {
      if (url !== configuredJwksUrl.href) {
        throw new Error("Refusing an unexpected JWKS URL.");
      }
      const response = await fetchImplementation(url, {
        ...options,
        redirect: "manual",
      });
      if (response.status >= 300 && response.status < 400) {
        throw new Error("JWKS redirects are not allowed.");
      }
      return response;
    },
    timeoutDuration: 5000,
  });

  return {
    async verify({ token, nowEpochSeconds }) {
      const protectedHeader = decodeProtectedHeader(token);
      if (
        protectedHeader.alg !== config.algorithm ||
        typeof protectedHeader.kid !== "string" ||
        protectedHeader.kid.length === 0 ||
        protectedHeader.kid.length > 200
      ) {
        throw new Error("Invalid protected token header.");
      }
      const { payload } = await jwtVerify(token, remoteJwks, {
        algorithms: [config.algorithm],
        audience: config.audience,
        clockTolerance: 0,
        currentDate: new Date(nowEpochSeconds * 1000),
        issuer: config.issuer,
        requiredClaims: ["iss", "aud", "sub", "exp", "iat", "nbf", "scope"],
      });
      const { exp, iat, nbf } = payload;
      if (
        payload.iss !== config.issuer ||
        payload.aud !== config.audience ||
        typeof payload.sub !== "string" ||
        typeof exp !== "number" ||
        !Number.isInteger(exp) ||
        typeof iat !== "number" ||
        !Number.isInteger(iat) ||
        typeof nbf !== "number" ||
        !Number.isInteger(nbf) ||
        exp <= nowEpochSeconds ||
        nbf > nowEpochSeconds ||
        iat > nowEpochSeconds ||
        // Issuance precedes async membership claims; nbf can legitimately be later.
        exp - nbf > 300 ||
        exp - iat > 300 ||
        typeof payload.scope !== "string" ||
        !oauthScopeTokenPattern.test(payload.scope) ||
        typeof payload.workspace_id !== "string"
      ) {
        throw new Error("Invalid verified token claims.");
      }
      return verifiedHostedClaimsSchema.parse({
        audience: payload.aud,
        issuer: payload.iss,
        scopes: payload.scope.split(" "),
        subject: payload.sub,
        workspaceId: payload.workspace_id,
      });
    },
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function protectedResourceMetadata(configInput: HostedMcpAuthConfig) {
  const config = hostedMcpAuthConfigSchema.parse(configInput);
  return {
    authorization_servers: [config.issuer],
    bearer_methods_supported: ["header"],
    resource: config.resourceUrl,
    scopes_supported: [
      "autograph:session",
      "autograph:start",
      "autograph:get",
      "autograph:send",
      "autograph:respond",
      "autograph:cancel",
    ],
  };
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
function challenge(config: HostedMcpAuthConfig, attributes: string[]) {
  const metadataUrl = new URL("/.well-known/oauth-protected-resource", config.resourceUrl).href;
  return `Bearer ${[...attributes, `resource_metadata="${metadataUrl}"`].join(", ")}`;
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function unauthorizedResponse(
  config: HostedMcpAuthConfig,
  scopes = ["autograph:session"],
): Response {
  return Response.json(
    { error: "unauthorized" },
    {
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge(config, [
          'error="invalid_token"',
          'error_description="Sign in to Autograph App Builder to continue"',
          `scope="${scopes.join(" ")}"`,
        ]),
      },
      status: 401,
    },
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function forbiddenResponse(
  config: HostedMcpAuthConfig,
  scopes = ["autograph:session"],
): Response {
  return Response.json(
    { error: "forbidden" },
    {
      headers: {
        "Cache-Control": "no-store",
        "WWW-Authenticate": challenge(config, [
          'error="insufficient_scope"',
          'error_description="Reconnect Autograph App Builder to grant the required permissions"',
          `scope="${scopes.join(" ")}"`,
        ]),
      },
      status: 403,
    },
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function notFoundResponse(): Response {
  return Response.json(
    { error: "not_found" },
    { headers: { "Cache-Control": "no-store" }, status: 404 },
  );
}

// eslint-disable-next-line eslint/func-style -- Preserve function declaration hoisting and initialization timing.
export function unavailableResponse(): Response {
  return Response.json(
    { error: "service_unavailable" },
    { headers: { "Cache-Control": "no-store" }, status: 503 },
  );
}
