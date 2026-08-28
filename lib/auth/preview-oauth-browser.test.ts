import { afterEach, describe, expect, it, vi } from "vitest";

import {
  currentOAuthQuery,
  loadPreviewConsentContext,
  postPreviewOAuthInteraction,
} from "./preview-oauth-browser";

const originalWindow = globalThis.window;

afterEach(() => {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: originalWindow,
  });
});

function installWindow() {
  Object.defineProperty(globalThis, "window", {
    configurable: true,
    value: { location: { origin: "https://builder.example.test" } },
  });
}

describe("Preview OAuth browser interaction", () => {
  it("posts a closed JSON interaction and accepts HTTPS or loopback redirects", async () => {
    installWindow();
    const fetcher = vi.fn(async () =>
      Response.json({ redirect_uri: "http://127.0.0.1:43123/callback" }),
    );
    await expect(
      postPreviewOAuthInteraction({
        endpoint: "/api/auth/oauth2/consent",
        body: { accept: true, oauth_query: "sig=signed" },
        fetcher,
      }),
    ).resolves.toBe("http://127.0.0.1:43123/callback");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/oauth2/consent",
      expect.objectContaining({
        method: "POST",
        credentials: "same-origin",
        redirect: "manual",
      }),
    );
  });

  it("rejects unsafe redirects and failed interactions", async () => {
    installWindow();
    await expect(
      postPreviewOAuthInteraction({
        endpoint: "/api/auth/oauth2/consent",
        body: { accept: true },
        fetcher: vi.fn(async () =>
          Response.json({ url: "http://attacker.example/callback" }),
        ),
      }),
    ).rejects.toThrow("unsafe redirect");
    await expect(
      postPreviewOAuthInteraction({
        endpoint: "/api/auth/sign-in/social",
        body: {},
        fetcher: vi.fn(async () =>
          Response.json({ error: "invalid" }, { status: 401 }),
        ),
      }),
    ).rejects.toThrow("rejected");
  });

  it("starts the signed OAuth continuation through GitHub without credentials", async () => {
    installWindow();
    const fetcher = vi.fn(async () =>
      Response.json({ url: "https://github.com/login/oauth/authorize" }),
    );
    await expect(
      postPreviewOAuthInteraction({
        endpoint: "/api/auth/sign-in/social",
        body: { provider: "github", oauth_query: "sig=signed" },
        fetcher,
      }),
    ).resolves.toBe("https://github.com/login/oauth/authorize");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/sign-in/social",
      expect.objectContaining({
        body: JSON.stringify({
          provider: "github",
          oauth_query: "sig=signed",
        }),
      }),
    );
  });

  it("posts denial and preserves the server access_denied redirect", async () => {
    installWindow();
    const fetcher = vi.fn(async () =>
      Response.json({
        redirect_uri:
          "http://127.0.0.1:43123/callback?error=access_denied&state=one",
      }),
    );
    await expect(
      postPreviewOAuthInteraction({
        endpoint: "/api/auth/oauth2/consent",
        body: { accept: false, oauth_query: "sig=signed" },
        fetcher,
      }),
    ).resolves.toContain("error=access_denied");
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/oauth2/consent",
      expect.objectContaining({
        body: JSON.stringify({ accept: false, oauth_query: "sig=signed" }),
      }),
    );
  });

  it("preserves only the signed query text supplied by the OAuth server", () => {
    expect(currentOAuthQuery("?client_id=one&sig=signed")).toBe(
      "client_id=one&sig=signed",
    );
    expect(currentOAuthQuery("sig=signed")).toBe("sig=signed");
  });

  it("renders identity and exact scopes only after signed-query prelogin", async () => {
    const fetcher = vi.fn(async () =>
      Response.json({
        client_id: "https://client.example/metadata.json",
        client_name: "Portable client",
        client_uri: "https://client.example",
      }),
    );
    await expect(
      loadPreviewConsentContext({
        search:
          "?client_id=https%3A%2F%2Fclient.example%2Fmetadata.json&scope=eve%3Asession+eve%3Aget&sig=signed",
        fetcher,
      }),
    ).resolves.toEqual({
      clientId: "https://client.example/metadata.json",
      clientName: "Portable client",
      clientUri: "https://client.example",
      requestedScopes: ["eve:session", "eve:get"],
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/api/auth/oauth2/public-client-prelogin",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"oauth_query"'),
      }),
    );
  });

  it("rejects unsigned, duplicate-scope, and rebound client context", async () => {
    await expect(
      loadPreviewConsentContext({ search: "?client_id=one&scope=eve:get" }),
    ).rejects.toThrow("signed authorization request");
    await expect(
      loadPreviewConsentContext({
        search: "?client_id=one&scope=eve:get+eve:get&sig=signed",
      }),
    ).rejects.toThrow("authorization scopes");
    await expect(
      loadPreviewConsentContext({
        search: "?client_id=one&scope=eve:get&sig=signed",
        fetcher: vi.fn(async () => Response.json({ client_id: "two" })),
      }),
    ).rejects.toThrow("identity changed");
  });
});
