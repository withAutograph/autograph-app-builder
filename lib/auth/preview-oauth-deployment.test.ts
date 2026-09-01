import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import {
  createPreviewOAuthRequestHandler,
  createPreviewOAuthWellKnownHandler,
  ensurePreviewSessionOrganization,
  selfServiceSignupAuthority,
} from "./preview-oauth-deployment";

describe("Preview OAuth deployment handlers", () => {
  it("enables self-service signup only for the gated local emulator", async () => {
    const managedAuthority = vi.fn(async () => false);

    await expect(
      selfServiceSignupAuthority("local", managedAuthority)(),
    ).resolves.toBe(true);
    await expect(
      selfServiceSignupAuthority("preview", managedAuthority)(),
    ).resolves.toBe(false);
    await expect(
      selfServiceSignupAuthority("production", managedAuthority)(),
    ).resolves.toBe(false);
    expect(managedAuthority).toHaveBeenCalledTimes(2);
  });

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
    ).resolves.toEqual({
      user: {
        id: "user_one",
        name: "Person",
        email: "person@example.com",
      },
      organization: {
        organizationId: "organization_one",
        workspaceId: "workspace_one",
      },
    });
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
    const [
      config,
      deployment,
      runtime,
      providers,
      authClient,
      signIn,
      providerButton,
      settingUp,
    ] = await Promise.all([
      readFile("next.config.ts", "utf8"),
      readFile("lib/auth/preview-oauth-deployment.ts", "utf8"),
      readFile("lib/auth/preview-oauth-runtime.ts", "utf8"),
      readFile("components/providers.tsx", "utf8"),
      readFile("lib/auth-client.ts", "utf8"),
      readFile("components/auth/sign-in.tsx", "utf8"),
      readFile("components/auth/provider-button.tsx", "utf8"),
      readFile("app/auth/setting-up/page.tsx", "utf8"),
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
    expect(deployment).toContain("readProviderEmulation(environment)");
    expect(deployment).toContain("providerEmulation");
    expect(deployment).toContain("async () => true");
    expect(providers).toContain('id: "vercel"');
    expect(providers).toContain('["github"] as const');
    expect(providers).toContain("emailAndPassword={{ enabled: false }}");
    expect(authClient).toContain("oauthProviderClient()");
    expect(signIn).toContain("<ProviderButtons");
    expect(signIn).not.toContain("SignUp");
    expect(signIn).not.toContain("/oauth2/continue");
    expect(signIn).toContain(
      '<ProviderButtons socialLayout={socialLayout} view="signIn" />',
    );
    expect(providerButton).not.toContain("Setting up your workspace…");
    expect(settingUp).toContain("Setting up your workspace…");
    await expect(
      readFile("app/auth/workspace/page.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile("app/auth/workspace/workspace-form.tsx", "utf8"),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses Better Auth organizations for every signed-in workspace boundary", async () => {
    const [builder, ...authoritySources] = await Promise.all(
      [
        "lib/integrations/builder-integration-deployment.ts",
        "lib/integrations/vercel-installation-deployment.ts",
        "lib/auth/github-app-installation-deployment.ts",
        "lib/mcp/browser-preview-deployment.ts",
      ].map((path) => readFile(path, "utf8")),
    );

    expect(builder).toContain("authenticated: true");
    expect(builder).toContain("organizationId: string");
    expect(builder).toContain("workspaceId: string");
    expect(builder).not.toContain("activeWorkspaceForUser");
    for (const source of authoritySources) {
      expect(source).toContain("createPostgresPreviewOrganizationAuthority");
      expect(source).not.toContain("createPostgresOAuthMembershipAuthority");
    }
  });

  it("uses the Better Auth UI passkey registry surfaces", async () => {
    const [providers, signIn, signUp, accountSettings, passkeyButton] =
      await Promise.all([
        readFile("components/providers.tsx", "utf8"),
        readFile("components/auth/sign-in.tsx", "utf8"),
        readFile("components/auth/sign-up.tsx", "utf8"),
        readFile(
          "components/auth/settings/account/account-settings.tsx",
          "utf8",
        ),
        readFile("components/auth/passkey/passkey-button.tsx", "utf8"),
      ]);

    expect(providers).toContain(
      'import { passkeyPlugin } from "@/lib/auth/passkey-plugin"',
    );
    expect(providers).toContain("passkeysEnabled");
    expect(providers).toContain("passkeyUiPlugins(passkeysEnabled");
    expect(providers).toContain("authButtons: [PasskeyButton]");
    expect(providers).toContain("securityCards: [Passkeys]");
    expect(signIn).toContain("plugin.authButtons");
    expect(signIn).toContain('className="flex flex-col gap-3"');
    expect(signIn).not.toContain('className="flex flex-col gap-6"');
    expect(signUp).toContain("plugin.authButtons");
    expect(signUp).toContain('view="signUp"');
    expect(signUp).toContain('className="flex flex-col gap-3"');
    expect(accountSettings).toContain("plugin.securityCards");
    expect(accountSettings).toContain("plugin.accountCards");
    expect(passkeyButton).toContain("useSignInPasskey(authClient)");
    expect(passkeyButton).toContain("useAddPasskey(authClient)");
    expect(passkeyButton).toContain("await signInPasskey.mutateAsync");
    expect(passkeyButton).toContain("await addPasskey.mutateAsync");
    expect(passkeyButton).toContain("passkeyClientError(result)");
    expect(passkeyButton).toContain('"Passkey failed (try again)"');
    expect(passkeyButton).toContain('view === "signUp"');
    expect(passkeyButton).toContain("returnWebAuthnResponse: true");
    expect(passkeyButton).not.toContain('"Create a passkey"');
    expect(passkeyButton).not.toContain("New to Autograph?");
    expect(passkeyButton).not.toContain("setShowRegistration");
    expect(passkeyButton).not.toContain('if (view === "signUp") return null');
    expect(passkeyButton).toContain(
      'fetch("/api/auth/passkey/onboarding-context"',
    );
  });

  it("keeps the OAuth provider choices visible during local development", async () => {
    const layout = await readFile("app/layout.tsx", "utf8");

    expect(layout).toContain(
      'const showLocalAuthProviders = process.env.NODE_ENV === "development"',
    );
    expect(layout.match(/showLocalAuthProviders \|\|/g)).toHaveLength(2);
    expect(layout.match(/showPreviewEmulatedAuthProviders \|\|/g)).toHaveLength(
      2,
    );
    expect(layout).toContain(
      'process.env.APP_BUILDER_PREVIEW_PROVIDER_EMULATION === "1"',
    );
    expect(layout).toContain("process.env.GITHUB_CLIENT_ID");
    expect(layout).toContain("process.env.VERCEL_AUTH_CLIENT_ID");
  });
});
