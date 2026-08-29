import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createPreviewOAuthRequestHandler,
  createPreviewOAuthWellKnownHandler,
  ensurePreviewSessionOrganization,
} from "./preview-oauth-deployment";

describe("Preview OAuth deployment handlers", () => {
  it("provisions and activates a workspace for an existing signed-in user", async () => {
    const getSession = vi.fn(async () => ({
      session: { activeOrganizationId: null },
      user: {
        id: "user_one",
        name: "Person",
        email: "person@example.com",
      },
    }));
    const setActiveOrganization = vi.fn(async () => ({
      id: "organization_one",
    }));
    const ensureOrganizationForVerifiedUser = vi.fn(async () => ({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    }));

    await expect(
      ensurePreviewSessionOrganization({
        auth: { api: { getSession, setActiveOrganization } },
        authority: { ensureOrganizationForVerifiedUser },
        headers: new Headers(),
      }),
    ).resolves.toMatchObject({ id: "user_one" });
    expect(ensureOrganizationForVerifiedUser).toHaveBeenCalledWith({
      userId: "user_one",
    });
    expect(setActiveOrganization).toHaveBeenCalledWith({
      headers: expect.any(Headers),
      body: { organizationId: "organization_one" },
    });
  });

  it("rechecks membership without rewriting an already active organization", async () => {
    const setActiveOrganization = vi.fn();
    const ensureOrganizationForVerifiedUser = vi.fn(async () => ({
      organizationId: "organization_one",
      workspaceId: "workspace_one",
    }));

    await ensurePreviewSessionOrganization({
      auth: {
        api: {
          getSession: vi.fn(async () => ({
            session: { activeOrganizationId: "organization_one" },
            user: {
              id: "user_one",
              name: "Person",
              email: "person@example.com",
            },
          })),
          setActiveOrganization,
        },
      },
      authority: { ensureOrganizationForVerifiedUser },
      headers: new Headers(),
    });

    expect(ensureOrganizationForVerifiedUser).toHaveBeenCalledOnce();
    expect(setActiveOrganization).not.toHaveBeenCalled();
  });

  it("does not provision without an authenticated session", async () => {
    const ensureOrganizationForVerifiedUser = vi.fn();
    const setActiveOrganization = vi.fn();

    await expect(
      ensurePreviewSessionOrganization({
        auth: {
          api: {
            getSession: vi.fn(async () => null),
            setActiveOrganization,
          },
        },
        authority: { ensureOrganizationForVerifiedUser },
        headers: new Headers(),
      }),
    ).resolves.toBeUndefined();
    expect(ensureOrganizationForVerifiedUser).not.toHaveBeenCalled();
    expect(setActiveOrganization).not.toHaveBeenCalled();
  });

  it("mounts the Better Auth handler without eager runtime construction", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ path: new URL(request.url).pathname }),
    );
    const getAuth = vi.fn(() => ({ handler }) as never);
    const requestHandler = createPreviewOAuthRequestHandler({
      environment: {},
      getAuth,
    });
    expect(getAuth).not.toHaveBeenCalled();
    const response = await requestHandler(
      new Request("https://builder.example.test/api/auth/jwks"),
    );
    await expect(response.json()).resolves.toEqual({ path: "/api/auth/jwks" });
    expect(getAuth).toHaveBeenCalledTimes(1);
  });

  it("maps OAuth AS discovery to the mounted Better Auth endpoint", async () => {
    const handler = vi.fn(async (request: Request) =>
      Response.json({ path: new URL(request.url).pathname }),
    );
    const getAuth = vi.fn(() => ({ handler }) as never);
    const wellKnown = createPreviewOAuthWellKnownHandler({
      environment: {},
      getAuth,
    });
    const response = await wellKnown(
      new Request(
        "https://builder.example.test/.well-known/oauth-authorization-server/api/auth",
      ),
    );
    await expect(response.json()).resolves.toEqual({
      path: "/api/auth/.well-known/oauth-authorization-server",
    });
  });

  it("fails closed without leaking runtime configuration", async () => {
    const requestHandler = createPreviewOAuthRequestHandler({
      environment: { BETTER_AUTH_SECRET: "should-not-appear" },
      getAuth: vi.fn(() => {
        throw new Error("should-not-appear");
      }),
    });
    const response = await requestHandler(
      new Request("https://builder.example.test/api/auth/jwks"),
    );
    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.text()).toBe(
      JSON.stringify({ error: "preview_oauth_unavailable" }),
    );
  });

  it("binds every browser interaction surface to no-store anti-clickjacking headers", async () => {
    const [config, runtime, providers, authClient, signIn, providerButton] =
      await Promise.all([
        readFile("next.config.ts", "utf8"),
        readFile("lib/auth/preview-oauth-runtime.ts", "utf8"),
        readFile("components/providers.tsx", "utf8"),
        readFile("lib/auth-client.ts", "utf8"),
        readFile("components/auth/sign-in.tsx", "utf8"),
        readFile("components/auth/provider-button.tsx", "utf8"),
      ]);
    expect(config).toContain('source: "/auth/:path*"');
    expect(config).toContain('{ key: "Cache-Control", value: "no-store" }');
    expect(config).toContain("frame-ancestors 'none'");
    expect(config).toContain('{ key: "X-Frame-Options", value: "DENY" }');
    expect(runtime).toContain("baseURL: resourceOrigin");
    expect(runtime).not.toContain("baseURL: config.issuer");
    expect(runtime).toContain("disableImplicitLinking: false");
    expect(runtime).toContain("allowDifferentEmails: true");
    expect(runtime).toContain("updateUserInfoOnLink: false");
    expect(runtime).toContain("overrideUserInfoOnSignIn: false");
    expect(runtime).toContain("overrideUserInfo: false");
    expect(runtime).not.toContain("trustedProviders");
    expect(providers).toContain('id: "vercel"');
    expect(providers).toContain('"github",');
    expect(providers).not.toContain("emailAndPassword");
    expect(authClient).toContain("oauthProviderClient()");
    expect(signIn).toContain("<ProviderButtons");
    expect(signIn).not.toContain('type="email"');
    expect(signIn).not.toContain("SignUp");
    expect(signIn).not.toContain("/oauth2/continue");
    expect(signIn).toContain("Continue with GitHub or Vercel");
    expect(providerButton).toContain("Setting up your workspace…");
    await expect(
      readFile("app/auth/workspace/page.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile("app/auth/workspace/workspace-form.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});
