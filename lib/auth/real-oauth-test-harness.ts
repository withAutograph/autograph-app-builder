import { createHash, randomBytes } from "node:crypto";

import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { vi } from "vitest";
import { cursorClientRegistration, cursorClientId } from "./cursor-client";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
  previewOAuthScopes,
} from "./preview-oauth-contract";

export const origin = "https://builder.example.test";
export const issuer = `${origin}/api/auth`;
export const resource = `${origin}/mcp`;
export const clientId = "https://client.withautograph.com/portable.json";
export const redirectUri = "http://127.0.0.1:43123/auth/callback";
export const requestedScope = "autograph:session autograph:start offline_access";

export const codexClientId = "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json";
export const codexRedirectUris = [
  "http://127.0.0.1/callback/4-bzS8rt42zJ",
  "http://localhost/callback/4-bzS8rt42zJ",
] as const;
export const codexClientMetadata = {
  application_type: "native",
  client_id: codexClientId,
  client_name: "Codex",
  client_uri: "https://chatgpt.com/codex",
  grant_types: ["authorization_code", "refresh_token"],
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
  redirect_uris: [...codexRedirectUris],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
  token_endpoint_auth_methods_supported: ["none"],
};

const DEFAULT_OAUTH_CLIENT = { id: clientId, redirectUri };
const DEFAULT_CLIENT_METADATA = {
  client_name: "Portable client",
  grant_types: ["authorization_code", "refresh_token"],
  redirect_uris: [redirectUri],
  response_types: ["code"],
  token_endpoint_auth_method: "none",
};
const DEFAULT_RATE_LIMIT: BetterAuthOptions["rateLimit"] = { enabled: false };

export const authorizationUrl = (
  challenge: string,
  state: string,
  client: { id: string; redirectUri: string } = DEFAULT_OAUTH_CLIENT,
) => {
  const url = new URL(`${issuer}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    client_id: client.id,
    code_challenge: challenge,
    code_challenge_method: "S256",
    redirect_uri: client.redirectUri,
    resource,
    response_type: "code",
    scope: requestedScope,
    state,
  })) {
    url.searchParams.set(key, value);
  }
  return url;
};

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export const createRealOAuthHarness = async (
  activeWorkspaces: string[] = ["workspace_1"],
  clientMetadata: Record<string, unknown> = DEFAULT_CLIENT_METADATA,
  rateLimit: BetterAuthOptions["rateLimit"] = DEFAULT_RATE_LIMIT,
) => {
  const membershipState = { activeWorkspaces };
  // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
  const fetchClientMetadata = vi.fn(async (input: RequestInfo | URL) =>
    Response.json({
      ...clientMetadata,
      client_id: input instanceof Request ? input.url : String(input),
    }),
  );
  const options = buildPreviewMcpOAuthOptions({
    config: { issuer, resource },
    membership: {
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
      activeWorkspaceForUser: vi.fn(async () =>
        membershipState.activeWorkspaces.length === 1
          ? membershipState.activeWorkspaces[0]
          : undefined,
      ),
      // oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
      isActiveMember: vi.fn(async ({ workspaceId }) =>
        membershipState.activeWorkspaces.includes(workspaceId),
      ),
    },
  });
  return getTestInstance(
    {
      basePath: "/api/auth",
      baseURL: origin,
      logger: { disabled: true },
      plugins: [
        jwt({
          disableSettingJwtHeader: true,
          jwks: { jwksPath: "/jwks", keyPairConfig: { alg: "ES256" } },
          jwt: { audience: resource, expirationTime: "5m", issuer },
        }),
        mcp(options),
        cimd(
          buildPreviewCimdOptions({
            fetchClientMetadataResource: fetchClientMetadata,
          }),
        ),
      ],
      rateLimit,
      secret: "test-secret-that-is-long-enough-for-better-auth",
    },
    { port: 3000 },
  ).then((instance) => ({
    ...instance,
    fetchClientMetadata,
    membershipState,
    signIn: async (credentials: { email: string; password: string } = instance.testUser) => {
      const response = await instance.customFetchImpl(`${issuer}/sign-in/email`, {
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
        headers: {
          "content-type": "application/json",
          origin,
        },
        method: "POST",
      });
      if (!response.ok) throw new Error("Test sign-in failed.");
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Test session was unavailable.");
      return new Headers({ cookie });
    },
  }));
};

export type RealOAuthHarness = Awaited<ReturnType<typeof createRealOAuthHarness>>;
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Local test DB only; uses the same stable fields as deployment setup. */
export const registerTestCursorClient = async (harness: RealOAuthHarness) => {
  // getTestInstance migrates after plugin initialization. Seed the resource in
  // this local DB as deployment's oauth-initialize does before client setup.
  await harness.auth.$context;
  const target = await harness.db.findOne({
    model: "oauthResource",
    where: [{ field: "identifier", value: resource }],
  });
  if (!target)
    await harness.db.create({
      data: {
        accessTokenTtl: 300,
        allowedScopes: [...previewOAuthScopes],
        disabled: false,
        identifier: resource,
        name: "Autograph",
        refreshTokenTtl: 28_800,
        signingAlgorithm: "ES256",
      },
      model: "oauthResource",
    });
  await harness.db.create({
    data: cursorClientRegistration(),
    model: "oauthClient",
  });
  await harness.db.create({
    data: { clientId: cursorClientId, resourceId: resource },
    model: "oauthClientResource",
  });
};

/** Complete an actual browser-cookie authorization/consent and PKCE exchange. */
export const verifyRealOAuthToken = async (harness: RealOAuthHarness, accessToken: string) => {
  const response = await harness.customFetchImpl(`${issuer}/jwks`);
  const jwks = (await response.json()) as { keys: JsonWebKey[] };
  const verification = await jwtVerify(accessToken, createLocalJWKSet(jwks), {
    algorithms: ["ES256"],
    audience: resource,
    issuer,
  });
  return verification.payload;
};

export const grantRealOAuth = async (
  harness: RealOAuthHarness,
  browserHeaders: Headers,
  client: { id: string; redirectUri: string },
  scope = requestedScope,
) => {
  const verifier = randomBytes(48).toString("base64url");
  const state = randomBytes(24).toString("base64url");
  const url = authorizationUrl(
    createHash("sha256").update(verifier).digest("base64url"),
    state,
    client,
  );
  url.searchParams.set("scope", scope);
  const authorization = await harness.customFetchImpl(url, {
    headers: browserHeaders,
    redirect: "manual",
  });
  const location = authorization.headers.get("location");
  if (authorization.status !== 302 || !location) throw new Error("OAuth authorization failed.");
  let callback = new URL(location, origin);
  const consentRequired = callback.pathname === "/auth/consent";
  if (consentRequired) {
    if (!callback.searchParams.has("sig")) throw new Error("Consent continuation was not signed.");
    const headers = new Headers(browserHeaders);
    headers.set("origin", origin);
    headers.set("content-type", "application/json");
    const consent = await harness.customFetchImpl(`${issuer}/oauth2/consent`, {
      body: JSON.stringify({
        accept: true,
        oauth_query: callback.search.slice(1),
      }),
      headers,
      method: "POST",
    });
    if (!consent.ok) throw new Error("OAuth consent failed.");
    const body = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const consentRedirect = body.redirect_uri ?? body.url;
    if (!consentRedirect) throw new Error("OAuth consent did not return a redirect.");
    callback = new URL(consentRedirect);
  }
  const code = callback.searchParams.get("code");
  if (
    callback.origin + callback.pathname !== client.redirectUri ||
    callback.searchParams.get("state") !== state ||
    !code
  ) {
    throw new Error("OAuth did not return the bound authorization code.");
  }
  const response = await harness.customFetchImpl(`${issuer}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: client.id,
      code,
      code_verifier: verifier,
      grant_type: "authorization_code",
      redirect_uri: client.redirectUri,
      resource,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    method: "POST",
  });
  if (!response.ok) throw new Error("OAuth token exchange failed.");
  const tokens = (await response.json()) as OAuthTokens;
  const claims = await verifyRealOAuthToken(harness, tokens.access_token);
  return { claims, consentRequired, tokens };
};

export const refreshRealOAuth = async (
  harness: RealOAuthHarness,
  client: string,
  refreshToken: string,
) => {
  const response = await harness.customFetchImpl(`${issuer}/oauth2/token`, {
    body: new URLSearchParams({
      client_id: client,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      resource,
    }),
    headers: { "content-type": "application/x-www-form-urlencoded", origin },
    method: "POST",
  });
  if (!response.ok) throw new Error("OAuth refresh failed.");
  const tokens = (await response.json()) as OAuthTokens;
  return {
    claims: await verifyRealOAuthToken(harness, tokens.access_token),
    tokens,
  };
};
