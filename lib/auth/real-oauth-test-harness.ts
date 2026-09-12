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
  client_id: codexClientId,
  client_uri: "https://chatgpt.com/codex",
  application_type: "native",
  redirect_uris: [...codexRedirectUris],
  token_endpoint_auth_method: "none",
  token_endpoint_auth_methods_supported: ["none"],
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
  client_name: "Codex",
  logo_uri: "https://persistent.oaistatic.com/sonic/misc/openai-logo.png",
};

const DEFAULT_OAUTH_CLIENT = { id: clientId, redirectUri };
const DEFAULT_CLIENT_METADATA = {
  client_name: "Portable client",
  redirect_uris: [redirectUri],
  token_endpoint_auth_method: "none",
  grant_types: ["authorization_code", "refresh_token"],
  response_types: ["code"],
};
const DEFAULT_RATE_LIMIT: BetterAuthOptions["rateLimit"] = { enabled: false };

export function authorizationUrl(
  challenge: string,
  state: string,
  client: { id: string; redirectUri: string } = DEFAULT_OAUTH_CLIENT,
) {
  const url = new URL(`${issuer}/oauth2/authorize`);
  for (const [key, value] of Object.entries({
    response_type: "code",
    client_id: client.id,
    redirect_uri: client.redirectUri,
    scope: requestedScope,
    state,
    resource,
    code_challenge: challenge,
    code_challenge_method: "S256",
  })) {
    url.searchParams.set(key, value);
  }
  return url;
}

// oxlint-disable-next-line eslint/require-await -- preserve Promise-returning framework or interface contract
export async function createRealOAuthHarness(
  activeWorkspaces: string[] = ["workspace_1"],
  clientMetadata: Record<string, unknown> = DEFAULT_CLIENT_METADATA,
  rateLimit: BetterAuthOptions["rateLimit"] = DEFAULT_RATE_LIMIT,
) {
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
      baseURL: origin,
      basePath: "/api/auth",
      secret: "test-secret-that-is-long-enough-for-better-auth",
      logger: { disabled: true },
      rateLimit,
      plugins: [
        jwt({
          jwks: { keyPairConfig: { alg: "ES256" }, jwksPath: "/jwks" },
          jwt: { issuer, audience: resource, expirationTime: "5m" },
          disableSettingJwtHeader: true,
        }),
        mcp(options),
        cimd(
          buildPreviewCimdOptions({
            fetchClientMetadataResource: fetchClientMetadata,
          }),
        ),
      ],
    },
    { port: 3000 },
  ).then((instance) => ({
    ...instance,
    fetchClientMetadata,
    membershipState,
    signIn: async (credentials: { email: string; password: string } = instance.testUser) => {
      const response = await instance.customFetchImpl(`${issuer}/sign-in/email`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/json",
        },
        body: JSON.stringify({
          email: credentials.email,
          password: credentials.password,
        }),
      });
      if (!response.ok) throw new Error("Test sign-in failed.");
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined) throw new Error("Test session was unavailable.");
      return new Headers({ cookie });
    },
  }));
}

export type RealOAuthHarness = Awaited<ReturnType<typeof createRealOAuthHarness>>;
export interface OAuthTokens {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  scope: string;
  token_type: string;
}

/** Local test DB only; uses the same stable fields as deployment setup. */
export async function registerTestCursorClient(harness: RealOAuthHarness) {
  // getTestInstance migrates after plugin initialization. Seed the resource in
  // this local DB as deployment's oauth-initialize does before client setup.
  await harness.auth.$context;
  const target = await harness.db.findOne({
    model: "oauthResource",
    where: [{ field: "identifier", value: resource }],
  });
  if (!target)
    await harness.db.create({
      model: "oauthResource",
      data: {
        identifier: resource,
        name: "Autograph",
        allowedScopes: [...previewOAuthScopes],
        accessTokenTtl: 300,
        refreshTokenTtl: 28_800,
        signingAlgorithm: "ES256",
        disabled: false,
      },
    });
  await harness.db.create({
    model: "oauthClient",
    data: cursorClientRegistration(),
  });
  await harness.db.create({
    model: "oauthClientResource",
    data: { clientId: cursorClientId, resourceId: resource },
  });
}

/** Complete an actual browser-cookie authorization/consent and PKCE exchange. */
export async function grantRealOAuth(
  harness: RealOAuthHarness,
  browserHeaders: Headers,
  client: { id: string; redirectUri: string },
  scope = requestedScope,
) {
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
      method: "POST",
      headers,
      body: JSON.stringify({
        accept: true,
        oauth_query: callback.search.slice(1),
      }),
    });
    if (!consent.ok) throw new Error("OAuth consent failed.");
    const body = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    callback = new URL(body.redirect_uri ?? body.url!);
  }
  if (
    callback.origin + callback.pathname !== client.redirectUri ||
    callback.searchParams.get("state") !== state ||
    !callback.searchParams.get("code")
  ) {
    throw new Error("OAuth did not return the bound authorization code.");
  }
  const response = await harness.customFetchImpl(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: client.id,
      code: callback.searchParams.get("code")!,
      code_verifier: verifier,
      redirect_uri: client.redirectUri,
      resource,
    }),
  });
  if (!response.ok) throw new Error("OAuth token exchange failed.");
  const tokens = (await response.json()) as OAuthTokens;
  const claims = await verifyRealOAuthToken(harness, tokens.access_token);
  return { tokens, claims, consentRequired };
}

export async function verifyRealOAuthToken(harness: RealOAuthHarness, accessToken: string) {
  const response = await harness.customFetchImpl(`${issuer}/jwks`);
  const jwks = (await response.json()) as { keys: JsonWebKey[] };
  return (
    await jwtVerify(accessToken, createLocalJWKSet(jwks), {
      issuer,
      audience: resource,
      algorithms: ["ES256"],
    })
  ).payload;
}

export async function refreshRealOAuth(
  harness: RealOAuthHarness,
  client: string,
  refreshToken: string,
) {
  const response = await harness.customFetchImpl(`${issuer}/oauth2/token`, {
    method: "POST",
    headers: { origin, "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      client_id: client,
      refresh_token: refreshToken,
      resource,
    }),
  });
  if (!response.ok) throw new Error("OAuth refresh failed.");
  const tokens = (await response.json()) as OAuthTokens;
  return {
    tokens,
    claims: await verifyRealOAuthToken(harness, tokens.access_token),
  };
}
