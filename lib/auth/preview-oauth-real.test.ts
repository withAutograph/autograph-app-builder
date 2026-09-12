import { createHash } from "node:crypto";
import { createLocalJWKSet, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { previewOAuthRateLimit } from "./preview-oauth-runtime";
import { cursorClientId, cursorRedirectUri } from "./cursor-client";
import { previewOAuthScopes } from "./preview-oauth-contract";
import {
  authorizationUrl,
  clientId,
  codexClientId,
  codexClientMetadata,
  codexRedirectUris,
  grantRealOAuth,
  issuer,
  origin,
  refreshRealOAuth,
  registerTestCursorClient,
  redirectUri,
  requestedScope,
  resource,
  createRealOAuthHarness as setup,
} from "./real-oauth-test-harness";

describe("real Better Auth Preview OAuth handler", () => {
  it("reuses one web login for Cursor and Codex, persists consent, and refreshes actual tokens", async () => {
    const harness = await setup(["workspace_1"], codexClientMetadata);
    await registerTestCursorClient(harness);
    const browser = await harness.signIn();
    const session = await harness.customFetchImpl(`${issuer}/get-session`, {
      headers: browser,
    });
    const { user } = (await session.json()) as { user: { id: string } };
    for (const client of [
      { id: cursorClientId, redirectUri: cursorRedirectUri },
      { id: codexClientId, redirectUri: codexRedirectUris[0] },
    ]) {
      const first = await grantRealOAuth(harness, browser, client, previewOAuthScopes.join(" "));
      expect(first.consentRequired).toBe(true);
      expect(first.claims).toMatchObject({
        sub: user.id,
        workspace_id: "workspace_1",
        aud: resource,
        iss: issuer,
      });
      expect(first.tokens).toMatchObject({
        token_type: "Bearer",
        expires_in: 300,
        refresh_token: expect.any(String),
      });
      const repeated = await grantRealOAuth(harness, browser, client, previewOAuthScopes.join(" "));
      expect(repeated.consentRequired).toBe(false);
      expect(repeated.claims.sub).toBe(user.id);
      const refreshed = await refreshRealOAuth(harness, client.id, first.tokens.refresh_token);
      expect(refreshed.claims).toMatchObject({
        sub: user.id,
        workspace_id: "workspace_1",
        aud: resource,
      });
      expect(refreshed.tokens.refresh_token).not.toBe(first.tokens.refresh_token);
      expect(refreshed.tokens.scope).toBe(previewOAuthScopes.join(" "));
    }
    expect(harness.fetchClientMetadata).not.toHaveBeenCalledWith(cursorClientId, expect.anything());
    expect(harness.fetchClientMetadata).toHaveBeenCalledWith(codexClientId, expect.anything());
    expect(await harness.auth.api.getOAuthConsents({ headers: browser })).toHaveLength(2);
  });

  it("requires Cursor PKCE, rejects every alternate callback, and keeps DCR disabled", async () => {
    const harness = await setup();
    await registerTestCursorClient(harness);
    const browser = await harness.signIn();
    for (const redirect of [
      "http://localhost:8788/callback",
      "http://127.0.0.1:8787/callback",
      "http://localhost:8787/other",
      "https://attacker.example/callback",
    ]) {
      const response = await harness.customFetchImpl(
        authorizationUrl("a".repeat(43), "invalid_redirect", {
          id: cursorClientId,
          redirectUri: redirect,
        }),
        { headers: browser, redirect: "manual" },
      );
      const destination = new URL(response.headers.get("location")!);
      expect(destination.origin + destination.pathname).toBe(`${issuer}/error`);
      expect(destination.searchParams.get("error")).toBe("invalid_redirect");
    }
    const missingPkce = authorizationUrl("a".repeat(43), "no_pkce", {
      id: cursorClientId,
      redirectUri: cursorRedirectUri,
    });
    missingPkce.searchParams.delete("code_challenge");
    missingPkce.searchParams.delete("code_challenge_method");
    const response = await harness.customFetchImpl(missingPkce, {
      headers: browser,
      redirect: "manual",
    });
    expect(new URL(response.headers.get("location")!).searchParams.has("error")).toBe(true);
    expect(await harness.auth.api.getOAuthConsents({ headers: browser })).toEqual([]);
    const registration = await harness.customFetchImpl(`${issuer}/oauth2/register`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_name: "unapproved",
        redirect_uris: [cursorRedirectUri],
      }),
    });
    expect(registration.ok).toBe(false);
    const clients = await harness.db.findMany({ model: "oauthClient" });
    expect(clients).toHaveLength(1);
  });
  it("serves exact OAuth AS discovery and an ES256 public JWKS", async () => {
    const { customFetchImpl } = await setup();
    const discovery = await customFetchImpl(`${issuer}/.well-known/oauth-authorization-server`);
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

    const openId = await customFetchImpl(`${issuer}/.well-known/openid-configuration`);
    expect(openId.status).toBe(404);
  });

  it("denies authenticated client and resource management endpoints", async () => {
    const { customFetchImpl, signIn } = await setup();
    const signedIn = await signIn();
    const clientList = await customFetchImpl(`${issuer}/oauth2/get-clients`, {
      headers: signedIn,
    });
    expect(clientList.status).toBe(401);
    const resourceList = await customFetchImpl(`${issuer}/admin/oauth2/resources`, {
      headers: signedIn,
    });
    // Better Auth 1.7.1 does not expose this route when resource management is
    // disabled. A missing route is the fail-closed result for this handler.
    expect(resourceList.status).toBe(404);
  });

  it("completes signed consent and a resource-bound S256 token exchange", async () => {
    const { customFetchImpl, signIn, testUser, fetchClientMetadata } = await setup();
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
    const consentLocation = new URL(getResponse.headers.get("location")!, origin);
    expect(consentLocation.pathname).toBe("/auth/consent");
    expect(consentLocation.searchParams.get("sig")).toMatch(/^[A-Za-z0-9+/=]+$/u);
    const consentQuery = consentLocation.search.slice(1);

    const prelogin = await customFetchImpl(`${issuer}/oauth2/public-client-prelogin`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({
        client_id: clientId,
        oauth_query: consentQuery,
      }),
    });
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
    const verified = await jwtVerify(tokenBody.access_token, createLocalJWKSet(jwks), {
      issuer,
      audience: resource,
      algorithms: ["ES256"],
    });
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
    expect(fetchClientMetadata).toHaveBeenCalledWith(clientId, expect.any(Object));
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
    const code = new URL(consentBody.redirect_uri ?? consentBody.url!).searchParams.get("code");
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
    expect(consentLocation.searchParams.get("redirect_uri")).toBe(codexRedirectUris[0]);
    expect(consentLocation.searchParams.get("code_challenge_method")).toBe("S256");
    expect(fetchClientMetadata).toHaveBeenCalledWith(codexClientId, expect.any(Object));

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
    expect(errorLocation.origin + errorLocation.pathname).toBe(`${issuer}/error`);
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
      const { auth, customFetchImpl, signIn } = await setup([...activeWorkspaces]);
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
      await expect(auth.api.getOAuthConsents({ headers: signedIn })).resolves.toEqual([]);
    },
  );

  it("fails membership drift before allow without consent or code", async () => {
    const { auth, customFetchImpl, membershipState, signIn } = await setup();
    const signedIn = await signIn();
    const authorize = await customFetchImpl(authorizationUrl("a".repeat(43), "state_drift_allow"), {
      headers: signedIn,
      redirect: "manual",
    });
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
    await expect(auth.api.getOAuthConsents({ headers: signedIn })).resolves.toEqual([]);
  });

  it("fails membership drift before exchange without issuing a token", async () => {
    const { customFetchImpl, db, membershipState, signIn } = await setup();
    const signedIn = await signIn();
    const verifier = "x".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const authorize = await customFetchImpl(authorizationUrl(challenge, "state_drift_exchange"), {
      headers: signedIn,
      redirect: "manual",
    });
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
    const code = new URL(consentBody.redirect_uri ?? consentBody.url!).searchParams.get("code");
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
    await expect(db.findMany({ model: "oauthAccessToken" })).resolves.toEqual([]);
  });

  it("returns access_denied without persisting consent", async () => {
    const { auth, customFetchImpl, db, signIn } = await setup();
    const signedIn = await signIn();
    const authorize = await customFetchImpl(authorizationUrl("d".repeat(43), "state_deny"), {
      headers: signedIn,
      redirect: "manual",
    });
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
    await expect(auth.api.getOAuthConsents({ headers: signedIn })).resolves.toEqual([]);
    await expect(db.findMany({ model: "oauthAccessToken" })).resolves.toEqual([]);
  });
});
