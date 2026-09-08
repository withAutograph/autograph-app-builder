import { createHash } from "node:crypto";

import { cimd } from "@better-auth/cimd";
import { mcp } from "@better-auth/mcp";
import type { BetterAuthOptions } from "better-auth";
import { jwt } from "better-auth/plugins";
import { getTestInstance } from "better-auth/test";
import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it, vi } from "vitest";

import {
  buildPreviewCimdOptions,
  buildPreviewMcpOAuthOptions,
} from "./preview-oauth-contract";
import { previewOAuthRateLimit } from "./preview-oauth-runtime";

const origin = "https://builder.example.test";
const issuer = `${origin}/api/auth`;
const resource = `${origin}/mcp`;
const clientId = "https://client.withautograph.com/portable.json";
const redirectUri = "http://127.0.0.1:43123/auth/callback";
const requestedScope = "autograph:session autograph:start offline_access";

const codexClientId =
  "https://chatgpt.com/oauth/codex/4-bzS8rt42zJ/client.json";
const codexRedirectUris = [
  "http://127.0.0.1/callback/4-bzS8rt42zJ",
  "http://localhost/callback/4-bzS8rt42zJ",
] as const;
const codexClientMetadata = {
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

function authorizationUrl(
  challenge: string,
  state: string,
  client: { id: string; redirectUri: string } = {
    id: clientId,
    redirectUri,
  },
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

async function setup(
  activeWorkspaces: string[] = ["workspace_1"],
  clientMetadata: Record<string, unknown> = {
    client_name: "Portable client",
    redirect_uris: [redirectUri],
    token_endpoint_auth_method: "none",
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  },
  rateLimit: BetterAuthOptions["rateLimit"] = { enabled: false },
) {
  const membershipState = { activeWorkspaces };
  const fetchClientMetadata = vi.fn(async (input: RequestInfo | URL) =>
    Response.json({
      ...clientMetadata,
      client_id: input instanceof Request ? input.url : String(input),
    }),
  );
  const options = buildPreviewMcpOAuthOptions({
    config: { issuer, resource },
    membership: {
      activeWorkspaceForUser: vi.fn(async () =>
        membershipState.activeWorkspaces.length === 1
          ? membershipState.activeWorkspaces[0]
          : undefined,
      ),
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
    signIn: async () => {
      const response = await instance.customFetchImpl(
        `${issuer}/sign-in/email`,
        {
          method: "POST",
          headers: {
            origin,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            email: instance.testUser.email,
            password: instance.testUser.password,
          }),
        },
      );
      if (!response.ok) throw new Error("Test sign-in failed.");
      const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
      if (cookie === undefined)
        throw new Error("Test session was unavailable.");
      return new Headers({ cookie });
    },
  }));
}

describe("real Better Auth Preview OAuth handler", () => {
  it("serves exact OAuth AS discovery and an ES256 public JWKS", async () => {
    const { customFetchImpl } = await setup();
    const discovery = await customFetchImpl(
      `${issuer}/.well-known/oauth-authorization-server`,
    );
    expect(discovery.status).toBe(200);
    await expect(discovery.json()).resolves.toMatchObject({
      issuer,
      authorization_endpoint: `${issuer}/oauth2/authorize`,
      token_endpoint: `${issuer}/oauth2/token`,
      jwks_uri: `${issuer}/jwks`,
      code_challenge_methods_supported: ["S256"],
      grant_types_supported: ["authorization_code", "refresh_token"],
    });

    const jwksResponse = await customFetchImpl(`${issuer}/jwks`);
    expect(jwksResponse.status).toBe(200);
    const jwks = (await jwksResponse.json()) as {
      keys: Array<Record<string, unknown>>;
    };
    expect(jwks.keys).toHaveLength(1);
    expect(jwks.keys[0]).toMatchObject({
      alg: "ES256",
      kty: "EC",
      crv: "P-256",
    });
    expect(jwks.keys[0]).not.toHaveProperty("d");

    const openId = await customFetchImpl(
      `${issuer}/.well-known/openid-configuration`,
    );
    expect(openId.status).toBe(404);
  });

  it("denies authenticated client and resource management endpoints", async () => {
    const { customFetchImpl, signIn } = await setup();
    const signedIn = await signIn();
    const clientList = await customFetchImpl(`${issuer}/oauth2/get-clients`, {
      headers: signedIn,
    });
    expect(clientList.status).toBe(401);
    const resourceList = await customFetchImpl(
      `${issuer}/admin/oauth2/resources`,
      { headers: signedIn },
    );
    // Better Auth 1.7.1 does not expose this route when resource management is
    // disabled. A missing route is the fail-closed result for this handler.
    expect(resourceList.status).toBe(404);
  });

  it("completes signed consent and a resource-bound S256 token exchange", async () => {
    const { customFetchImpl, signIn, testUser, fetchClientMetadata } =
      await setup();
    const signedIn = await signIn();
    const sessionResponse = await customFetchImpl(`${issuer}/get-session`, {
      headers: signedIn,
    });
    expect(sessionResponse.status).toBe(200);
    await expect(sessionResponse.json()).resolves.toMatchObject({
      user: { email: testUser.email },
    });
    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const url = authorizationUrl(challenge, "state_allow");
    const getResponse = await customFetchImpl(url, {
      headers: signedIn,
      redirect: "manual",
    });
    expect(getResponse.status).toBe(302);
    const consentLocation = new URL(
      getResponse.headers.get("location")!,
      origin,
    );
    expect(consentLocation.pathname).toBe("/auth/consent");
    expect(consentLocation.searchParams.get("sig")).toMatch(
      /^[A-Za-z0-9+/=]+$/u,
    );
    const consentQuery = consentLocation.search.slice(1);

    const prelogin = await customFetchImpl(
      `${issuer}/oauth2/public-client-prelogin`,
      {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          client_id: clientId,
          oauth_query: consentQuery,
        }),
      },
    );
    expect(prelogin.status).toBe(200);
    await expect(prelogin.json()).resolves.toMatchObject({
      client_id: clientId,
      client_name: "Portable client",
    });

    const consent = await customFetchImpl(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/json",
      }),
      body: JSON.stringify({ accept: true, oauth_query: consentQuery }),
    });
    expect(consent.status).toBe(200);
    const consentBody = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const callback = new URL(consentBody.redirect_uri ?? consentBody.url!);
    expect(callback.origin + callback.pathname).toBe(redirectUri);
    expect(callback.searchParams.get("state")).toBe("state_allow");
    const code = callback.searchParams.get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/u);

    const token = await customFetchImpl(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
      scope: string;
      token_type: string;
    };
    expect(tokenBody).toMatchObject({
      expires_in: 300,
      scope: requestedScope,
      token_type: "Bearer",
    });
    expect(tokenBody.refresh_token).toMatch(/^[A-Za-z0-9_-]+$/u);

    const refreshed = await customFetchImpl(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        client_id: clientId,
        refresh_token: tokenBody.refresh_token!,
        resource,
      }),
    });
    expect(refreshed.status).toBe(200);
    await expect(refreshed.json()).resolves.toMatchObject({
      access_token: expect.any(String),
      expires_in: 300,
      refresh_token: expect.any(String),
      scope: requestedScope,
      token_type: "Bearer",
    });

    const jwksResponse = await customFetchImpl(`${issuer}/jwks`);
    const jwks = (await jwksResponse.json()) as { keys: JsonWebKey[] };
    const verified = await jwtVerify(
      tokenBody.access_token,
      createLocalJWKSet(jwks),
      { issuer, audience: resource, algorithms: ["ES256"] },
    );
    expect(verified.payload).toMatchObject({
      sub: expect.any(String),
      workspace_id: "workspace_1",
      aud: resource,
      iss: issuer,
    });
    expect(Number.isInteger(verified.payload.nbf)).toBe(true);
    expect(Number.isInteger(verified.payload.iat)).toBe(true);
    expect(Number.isInteger(verified.payload.exp)).toBe(true);
    expect(verified.payload.exp! - verified.payload.iat!).toBe(300);
    expect(fetchClientMetadata).toHaveBeenCalledWith(
      clientId,
      expect.any(Object),
    );
  });

  it("keeps a Codex token exchange standards-shaped after a retry burst", async () => {
    const { customFetchImpl, signIn } = await setup(
      ["workspace_1"],
      codexClientMetadata,
      previewOAuthRateLimit,
    );
    const signedIn = await signIn();
    const verifier = "r".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await customFetchImpl(
      authorizationUrl(challenge, "state_codex_retry", {
        id: codexClientId,
        redirectUri: codexRedirectUris[0],
      }),
      { headers: signedIn, redirect: "manual" },
    );
    const consentLocation = new URL(authorize.headers.get("location")!, origin);
    const consent = await customFetchImpl(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        accept: true,
        oauth_query: consentLocation.search.slice(1),
      }),
    });
    const consentBody = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const code = new URL(
      consentBody.redirect_uri ?? consentBody.url!,
    ).searchParams.get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/u);

    for (let attempt = 0; attempt < 60; attempt += 1) {
      const retry = await customFetchImpl(`${issuer}/oauth2/token`, {
        method: "POST",
        headers: {
          origin,
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          client_id: codexClientId,
          code: `discarded-retry-${attempt}`,
          code_verifier: verifier,
          redirect_uri: codexRedirectUris[0],
          resource,
        }),
      });
      expect(retry.status).not.toBe(429);
    }

    const token = await customFetchImpl(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: codexClientId,
        code: code!,
        code_verifier: verifier,
        redirect_uri: codexRedirectUris[0],
        resource,
      }),
    });
    expect(token.status).toBe(200);
    const tokenBody = (await token.json()) as Record<string, unknown>;
    expect(tokenBody).toMatchObject({
      access_token: expect.any(String),
      expires_in: 300,
      refresh_token: expect.any(String),
      scope: requestedScope,
      token_type: "Bearer",
    });
    expect(tokenBody).not.toHaveProperty("accessToken");
    expect(tokenBody).not.toHaveProperty("expiresIn");
    expect(tokenBody).not.toHaveProperty("tokenType");

    const signInStatuses: number[] = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const response = await customFetchImpl(`${issuer}/sign-in/email`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({
          email: `unknown-${attempt}@example.test`,
          password: "not-a-valid-password",
        }),
      });
      signInStatuses.push(response.status);
    }
    expect(signInStatuses.at(-1)).toBe(429);

    const jwksResponse = await customFetchImpl(`${issuer}/jwks`);
    const jwks = (await jwksResponse.json()) as { keys: JsonWebKey[] };
    await expect(
      jwtVerify(tokenBody.access_token as string, createLocalJWKSet(jwks), {
        issuer,
        audience: resource,
        algorithms: ["ES256"],
      }),
    ).resolves.toMatchObject({
      payload: {
        aud: resource,
        iss: issuer,
        workspace_id: "workspace_1",
      },
    });
  });

  it("accepts the native Codex CIMD metadata without weakening PKCE or redirects", async () => {
    const { customFetchImpl, fetchClientMetadata, signIn } = await setup(
      ["workspace_1"],
      codexClientMetadata,
    );
    const signedIn = await signIn();
    const response = await customFetchImpl(
      authorizationUrl("k".repeat(43), "state_codex", {
        id: codexClientId,
        redirectUri: codexRedirectUris[0],
      }),
      { headers: signedIn, redirect: "manual" },
    );

    expect(response.status).toBe(302);
    const consentLocation = new URL(response.headers.get("location")!, origin);
    expect(consentLocation.pathname).toBe("/auth/consent");
    expect(consentLocation.searchParams.get("client_id")).toBe(codexClientId);
    expect(consentLocation.searchParams.get("redirect_uri")).toBe(
      codexRedirectUris[0],
    );
    expect(consentLocation.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(fetchClientMetadata).toHaveBeenCalledWith(
      codexClientId,
      expect.any(Object),
    );

    const alteredRedirect = authorizationUrl("k".repeat(43), "state_bad", {
      id: codexClientId,
      redirectUri: "http://127.0.0.1/callback/not-codex",
    });
    const rejected = await customFetchImpl(alteredRedirect, {
      headers: signedIn,
      redirect: "manual",
    });
    expect(rejected.status).toBe(302);
    const errorLocation = new URL(rejected.headers.get("location")!);
    expect(errorLocation.origin + errorLocation.pathname).toBe(
      `${issuer}/error`,
    );
    expect(errorLocation.searchParams.get("error")).toBe("invalid_redirect");
  });

  it("normalizes a form POST authorization request", async () => {
    const { customFetchImpl, signIn } = await setup();
    const signedIn = await signIn();
    const url = authorizationUrl("c".repeat(43), "state_post");
    const response = await customFetchImpl(`${issuer}/oauth2/authorize`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/x-www-form-urlencoded",
      }),
      body: url.searchParams,
      redirect: "manual",
    });
    expect(response.status).toBe(302);
    const location = new URL(response.headers.get("location")!, origin);
    expect(location.pathname).toBe("/auth/consent");
    expect(location.searchParams.get("client_id")).toBe(clientId);
    expect(location.searchParams.get("sig")).toMatch(/^[A-Za-z0-9+/=]+$/u);
  });

  it.each([
    ["zero", []],
    ["multiple", ["workspace_1", "workspace_2"]],
  ] as const)(
    "fails %s active memberships before consent or code issuance",
    async (_label, activeWorkspaces) => {
      const { auth, customFetchImpl, signIn } = await setup([
        ...activeWorkspaces,
      ]);
      const signedIn = await signIn();
      const response = await customFetchImpl(
        (() => {
          const url = authorizationUrl("m".repeat(43), "state_membership");
          url.searchParams.set("prompt", "consent");
          return url;
        })(),
        { headers: signedIn, redirect: "manual" },
      );
      expect(response.status).toBe(500);
      expect(response.headers.get("location")).toBeNull();
      await expect(
        auth.api.getOAuthConsents({ headers: signedIn }),
      ).resolves.toEqual([]);
    },
  );

  it("fails membership drift before allow without consent or code", async () => {
    const { auth, customFetchImpl, membershipState, signIn } = await setup();
    const signedIn = await signIn();
    const authorize = await customFetchImpl(
      authorizationUrl("a".repeat(43), "state_drift_allow"),
      { headers: signedIn, redirect: "manual" },
    );
    const consentLocation = new URL(authorize.headers.get("location")!, origin);
    expect(consentLocation.pathname).toBe("/auth/consent");
    membershipState.activeWorkspaces = [];
    const consent = await customFetchImpl(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        accept: true,
        oauth_query: consentLocation.search.slice(1),
      }),
    });
    expect(consent.status).toBe(500);
    expect(consent.headers.get("location")).toBeNull();
    await expect(
      auth.api.getOAuthConsents({ headers: signedIn }),
    ).resolves.toEqual([]);
  });

  it("fails membership drift before exchange without issuing a token", async () => {
    const { customFetchImpl, db, membershipState, signIn } = await setup();
    const signedIn = await signIn();
    const verifier = "x".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await customFetchImpl(
      authorizationUrl(challenge, "state_drift_exchange"),
      { headers: signedIn, redirect: "manual" },
    );
    const consentLocation = new URL(authorize.headers.get("location")!, origin);
    const consent = await customFetchImpl(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        accept: true,
        oauth_query: consentLocation.search.slice(1),
      }),
    });
    const consentBody = (await consent.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const code = new URL(
      consentBody.redirect_uri ?? consentBody.url!,
    ).searchParams.get("code");
    expect(code).toMatch(/^[A-Za-z0-9_-]+$/u);
    membershipState.activeWorkspaces = [];
    const token = await customFetchImpl(`${issuer}/oauth2/token`, {
      method: "POST",
      headers: {
        origin,
        "content-type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: clientId,
        code: code!,
        code_verifier: verifier,
        redirect_uri: redirectUri,
        resource,
      }),
    });
    expect(token.status).toBe(500);
    expect(await token.text()).not.toContain("access_token");
    await expect(db.findMany({ model: "oauthAccessToken" })).resolves.toEqual(
      [],
    );
  });

  it("returns access_denied without persisting consent", async () => {
    const { auth, customFetchImpl, db, signIn } = await setup();
    const signedIn = await signIn();
    const authorize = await customFetchImpl(
      authorizationUrl("d".repeat(43), "state_deny"),
      { headers: signedIn, redirect: "manual" },
    );
    const consentLocation = new URL(authorize.headers.get("location")!, origin);
    const denial = await customFetchImpl(`${issuer}/oauth2/consent`, {
      method: "POST",
      headers: new Headers({
        ...Object.fromEntries(signedIn.entries()),
        origin,
        "content-type": "application/json",
      }),
      body: JSON.stringify({
        accept: false,
        oauth_query: consentLocation.search.slice(1),
      }),
    });
    expect(denial.status).toBe(200);
    const denialBody = (await denial.json()) as {
      redirect_uri?: string;
      url?: string;
    };
    const denialLocation = new URL(denialBody.redirect_uri ?? denialBody.url!);
    expect(denialLocation.searchParams.get("error")).toBe("access_denied");
    expect(denialLocation.searchParams.get("state")).toBe("state_deny");
    expect(denialLocation.searchParams.get("code")).toBeNull();
    await expect(
      auth.api.getOAuthConsents({ headers: signedIn }),
    ).resolves.toEqual([]);
    await expect(db.findMany({ model: "oauthAccessToken" })).resolves.toEqual(
      [],
    );
  });
});
