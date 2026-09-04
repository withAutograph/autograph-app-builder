import { describe, expect, it, vi } from "vitest";

import {
  authRateLimitForLocalEmulation,
  fetchVerifiedGitHubUserInfo,
  fetchVerifiedVercelUserInfo,
  readPreviewOAuthRuntimeConfig,
} from "./preview-oauth-runtime";

const environment = {
  EVE_HOSTED_ADAPTER: "1",
  VERCEL_ENV: "preview",
  EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
  BETTER_AUTH_URL: "https://builder.example.test/api/auth",
  MCP_RESOURCE_URL: "https://builder.example.test/mcp",
  BETTER_AUTH_SECRET: "a".repeat(32),
  DATABASE_URL: "postgresql://runtime:secret@database.example.test/app",
  GITHUB_CLIENT_ID: "github-client-id",
  GITHUB_CLIENT_SECRET: "github-client-secret",
  VERCEL_AUTH_CLIENT_ID: "vercel-client-id",
  VERCEL_AUTH_CLIENT_SECRET: "vercel-client-secret",
  PASSKEY_ONBOARDING: undefined,
} as const;

describe("Preview OAuth runtime configuration", () => {
  it("keeps hosted rate limits strict while allowing a complete local emulation run", () => {
    const hostedRateLimit = authRateLimitForLocalEmulation(false);
    const localRateLimit = authRateLimitForLocalEmulation(true);

    expect(hostedRateLimit).toMatchObject({ max: 60 });
    expect(localRateLimit).toMatchObject({ max: 600 });
    expect(localRateLimit.customRules?.["/oauth2/token"]).toEqual({
      window: 60,
      max: 180,
    });
    expect(localRateLimit).toMatchObject({
      customRules: {
        "/sign-in/social": { window: 60, max: 60 },
      },
    });
    expect("/sign-in/social" in hostedRateLimit.customRules).toBe(false);
  });

  const idToken = (claims: Record<string, unknown>) =>
    `${Buffer.from(JSON.stringify({ alg: "ES256", typ: "JWT" })).toString("base64url")}.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;

  it("binds Vercel's verified UserInfo email to the verified ID-token identity", async () => {
    const fetchImplementation = vi.fn(async () =>
      Response.json({
        sub: "vercel-user-1",
        email: "USER@EXAMPLE.COM",
        email_verified: true,
        name: "Example User",
      }),
    );

    await expect(
      fetchVerifiedVercelUserInfo(
        {
          accessToken: "sensitive-access-token",
          idToken: idToken({
            sub: "vercel-user-1",
            email: "user@example.com",
          }),
        },
        fetchImplementation,
      ),
    ).resolves.toMatchObject({
      sub: "vercel-user-1",
      email: "user@example.com",
      emailVerified: true,
      name: "Example User",
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.vercel.com/login/oauth/userinfo",
      expect.objectContaining({
        method: "POST",
        redirect: "error",
        headers: { Authorization: "Bearer sensitive-access-token" },
      }),
    );
  });

  it("uses GitHub's verified primary email when the public profile omits email", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL) => {
      if (String(url) === "https://api.github.com/user") {
        return Response.json({
          id: 123,
          login: "autograph-user",
          email: null,
          avatar_url: "https://avatars.example.test/user.png",
        });
      }
      return Response.json([
        { email: "other@example.com", primary: false, verified: true },
        { email: "USER@EXAMPLE.COM", primary: true, verified: true },
      ]);
    });

    await expect(
      fetchVerifiedGitHubUserInfo(
        { accessToken: "sensitive-access-token" },
        fetchImplementation as typeof fetch,
      ),
    ).resolves.toMatchObject({
      user: {
        name: "autograph-user",
        email: "user@example.com",
        emailVerified: true,
      },
      data: { id: 123, email: "user@example.com" },
    });
    expect(fetchImplementation).toHaveBeenCalledWith(
      "https://api.github.com/user/emails",
      expect.objectContaining({
        redirect: "error",
        headers: expect.objectContaining({
          Authorization: "Bearer sensitive-access-token",
        }),
      }),
    );
  });

  it("rejects GitHub identities without a verified email", async () => {
    const fetchImplementation = vi.fn(async (url: string | URL) =>
      String(url) === "https://api.github.com/user"
        ? Response.json({ id: 123, login: "autograph-user" })
        : Response.json([
            { email: "user@example.com", primary: true, verified: false },
          ]),
    );

    await expect(
      fetchVerifiedGitHubUserInfo(
        { accessToken: "sensitive-access-token" },
        fetchImplementation as typeof fetch,
      ),
    ).resolves.toBeNull();
  });

  it.each([
    {
      name: "unverified email",
      profile: {
        sub: "vercel-user-1",
        email: "user@example.com",
        email_verified: false,
      },
    },
    {
      name: "different subject",
      profile: {
        sub: "vercel-user-2",
        email: "user@example.com",
        email_verified: true,
      },
    },
    {
      name: "different email",
      profile: {
        sub: "vercel-user-1",
        email: "other@example.com",
        email_verified: true,
      },
    },
  ])("rejects Vercel UserInfo with $name", async ({ profile }) => {
    await expect(
      fetchVerifiedVercelUserInfo(
        {
          accessToken: "sensitive-access-token",
          idToken: idToken({
            sub: "vercel-user-1",
            email: "user@example.com",
          }),
        },
        async () => Response.json(profile),
      ),
    ).resolves.toBeNull();
  });

  it("rejects missing tokens, failed responses, and oversized profiles", async () => {
    await expect(fetchVerifiedVercelUserInfo({})).resolves.toBeNull();
    await expect(
      fetchVerifiedVercelUserInfo(
        {
          accessToken: "sensitive-access-token",
          idToken: idToken({
            sub: "vercel-user-1",
            email: "user@example.com",
          }),
        },
        async () => new Response(null, { status: 503 }),
      ),
    ).resolves.toBeNull();
    await expect(
      fetchVerifiedVercelUserInfo(
        {
          accessToken: "sensitive-access-token",
          idToken: idToken({
            sub: "vercel-user-1",
            email: "user@example.com",
          }),
        },
        async () =>
          new Response("{}", { headers: { "content-length": "16385" } }),
      ),
    ).resolves.toBeNull();
  });

  it("requires the GitHub identity provider alongside the Preview bindings", () => {
    expect(readPreviewOAuthRuntimeConfig(environment)).toMatchObject({
      environment: "preview",
      githubClientId: "github-client-id",
      githubClientSecret: "github-client-secret",
    });
    for (const field of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
      expect(() =>
        readPreviewOAuthRuntimeConfig({ ...environment, [field]: undefined }),
      ).toThrow();
    }
  });

  it("requires Vercel authentication credentials", () => {
    expect(readPreviewOAuthRuntimeConfig(environment)).toMatchObject({
      vercelClientId: "vercel-client-id",
      vercelClientSecret: "vercel-client-secret",
    });

    for (const field of [
      "VERCEL_AUTH_CLIENT_ID",
      "VERCEL_AUTH_CLIENT_SECRET",
    ] as const) {
      expect(() =>
        readPreviewOAuthRuntimeConfig({ ...environment, [field]: undefined }),
      ).toThrow();
    }
  });

  it("accepts Emulate credentials only through the explicit local gate", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        EVE_HOSTED_ADAPTER: "1",
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
        APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
        APP_BUILDER_DATABASE_PORT: "54339",
        PASSKEY_ONBOARDING: "local-preview-v1",
        BETTER_AUTH_URL: "https://localhost:3001/api/auth",
        MCP_RESOURCE_URL: "https://localhost:3001/mcp",
        BETTER_AUTH_SECRET: "a".repeat(32),
        GITHUB_CLIENT_ID: "local-github-client",
        GITHUB_CLIENT_SECRET: "local-github-secret".repeat(2),
        VERCEL_AUTH_CLIENT_ID: "local-vercel-client",
        VERCEL_AUTH_CLIENT_SECRET: "local-vercel-secret".repeat(2),
        VERCEL_EMULATOR_URL: "http://localhost:4000",
        GITHUB_EMULATOR_URL: "http://localhost:4001",
        EMULATE_PROVIDER_TOKEN: "a".repeat(20),
        EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
        EMULATE_LOCAL_RELAY_SECRET: "a".repeat(32),
      }),
    ).toMatchObject({
      environment: "local",
      databaseUrl:
        "postgresql://postgres@127.0.0.1:54339/autograph_app_builder",
      passkeyOnboarding: {
        origin: "https://localhost:3001",
        rpId: "localhost",
        deploymentId: "local",
        secureCookies: true,
      },
    });
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...environment,
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
        APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
        VERCEL_EMULATOR_URL: "http://localhost:4000",
        GITHUB_EMULATOR_URL: "http://localhost:4001",
        EMULATE_PROVIDER_TOKEN: "a".repeat(20),
        EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
        EMULATE_LOCAL_RELAY_SECRET: "a".repeat(32),
      }),
    ).toThrow("Local provider emulation is unavailable");

    expect(() =>
      readPreviewOAuthRuntimeConfig({
        EVE_HOSTED_ADAPTER: "1",
        APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
        APP_BUILDER_LOCAL_AUTH_EMULATION: "1",
        APP_BUILDER_DATABASE_PORT: "not-a-port",
        PASSKEY_ONBOARDING: "local-preview-v1",
        BETTER_AUTH_URL: "https://localhost:3001/api/auth",
        MCP_RESOURCE_URL: "https://localhost:3001/mcp",
        BETTER_AUTH_SECRET: "a".repeat(32),
        GITHUB_CLIENT_ID: "local-github-client",
        GITHUB_CLIENT_SECRET: "local-github-secret".repeat(2),
        VERCEL_AUTH_CLIENT_ID: "local-vercel-client",
        VERCEL_AUTH_CLIENT_SECRET: "local-vercel-secret".repeat(2),
        VERCEL_EMULATOR_URL: "http://localhost:4000",
        GITHUB_EMULATOR_URL: "http://localhost:4001",
        EMULATE_PROVIDER_TOKEN: "a".repeat(20),
        EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
        EMULATE_LOCAL_RELAY_SECRET: "a".repeat(32),
      }),
    ).toThrow("Local authentication database port is invalid");
  });

  it("starts an enabled Preview with passkeys and no OAuth credentials", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        ...environment,
        GITHUB_CLIENT_ID: undefined,
        GITHUB_CLIENT_SECRET: undefined,
        VERCEL_AUTH_CLIENT_ID: undefined,
        VERCEL_AUTH_CLIENT_SECRET: undefined,
        PASSKEY_ONBOARDING: "local-preview-v1",
        PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
        VERCEL_DEPLOYMENT_ID: "dpl_preview_123",
        VERCEL_URL: "builder.example.test",
        BETTER_AUTH_URL: undefined,
        MCP_RESOURCE_URL: undefined,
      }),
    ).toMatchObject({
      environment: "preview",
      issuer: "https://builder.example.test/api/auth",
      resource: "https://builder.example.test/mcp",
      githubClientId: undefined,
      vercelClientId: undefined,
      passkeyOnboarding: { deploymentId: "dpl_preview_123" },
    });
  });

  it("rejects a partially configured OAuth provider", () => {
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...environment,
        PASSKEY_ONBOARDING: "local-preview-v1",
        PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
        VERCEL_DEPLOYMENT_ID: "dpl_preview_123",
        VERCEL_URL: "builder.example.test",
        GITHUB_CLIENT_SECRET: undefined,
      }),
    ).toThrow("both client ID and client secret");
  });

  it("starts locally for passkeys without OAuth provider credentials", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        NODE_ENV: "development",
        BETTER_AUTH_URL: "http://localhost:3000/api/auth",
        BETTER_AUTH_SECRET: "a".repeat(32),
        DATABASE_URL: "postgresql://runtime:secret@localhost/app",
        PASSKEY_ONBOARDING: "local-preview-v1",
      }),
    ).toMatchObject({
      environment: "development",
      hostedAdapter: "0",
      githubClientId: undefined,
      vercelClientId: undefined,
      passkeyOnboarding: { deploymentId: "local" },
    });
  });

  it("uses same-origin seeded providers only through the exact Preview gate", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        ...environment,
        APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
        NODE_ENV: "production",
        VERCEL_BRANCH_URL: "app-git-feature-team.vercel.app",
        VERCEL_GIT_COMMIT_REF: "feature/provider-emulation",
        VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
        VERCEL_PROJECT_ID: "prj_preview",
        EMULATE_PREVIEW_RELAY_SECRET: "r".repeat(32),
        EMULATE_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client",
        EMULATE_PREVIEW_GITHUB_CLIENT_SECRET: "g".repeat(20),
        EMULATE_PREVIEW_VERCEL_CLIENT_ID: "preview-vercel-client",
        EMULATE_PREVIEW_VERCEL_CLIENT_SECRET: "v".repeat(20),
        PASSKEY_ONBOARDING: "local-preview-v1",
        PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
        VERCEL_DEPLOYMENT_ID: "dpl_preview_123",
        VERCEL_URL: "app-deployment-team.vercel.app",
      }),
    ).toMatchObject({
      environment: "preview",
      issuer: "https://app-git-feature-team.vercel.app/api/auth",
      resource: "https://app-git-feature-team.vercel.app/mcp",
      trustedOrigins: [
        "https://app-git-feature-team.vercel.app",
        "https://app-deployment-team.vercel.app",
      ],
      githubClientId: "preview-github-client",
      vercelClientId: "preview-vercel-client",
      passkeyOnboarding: {
        origin: "https://app-git-feature-team.vercel.app",
        rpId: "app-git-feature-team.vercel.app",
        deploymentId: "dpl_preview_123",
        secureCookies: true,
      },
    });
  });

  it("fails provider-emulated Preview before serving auth without exact passkey deployment protection", () => {
    const emulatedPreview = {
      ...environment,
      APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
      NODE_ENV: "production",
      VERCEL_BRANCH_URL: "app-git-feature-team.vercel.app",
      VERCEL_GIT_COMMIT_REF: "feature/provider-emulation",
      VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
      VERCEL_PROJECT_ID: "prj_preview",
      EMULATE_PREVIEW_RELAY_SECRET: "r".repeat(32),
      EMULATE_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client",
      EMULATE_PREVIEW_GITHUB_CLIENT_SECRET: "g".repeat(20),
      EMULATE_PREVIEW_VERCEL_CLIENT_ID: "preview-vercel-client",
      EMULATE_PREVIEW_VERCEL_CLIENT_SECRET: "v".repeat(20),
      PASSKEY_ONBOARDING: "local-preview-v1",
      PASSKEY_PREVIEW_PROTECTION: "vercel-authentication",
      VERCEL_DEPLOYMENT_ID: "dpl_preview_123",
      VERCEL_URL: "app-deployment-team.vercel.app",
    } as const;

    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...emulatedPreview,
        VERCEL_DEPLOYMENT_ID: undefined,
      }),
    ).toThrow("exact Vercel deployment metadata");
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...emulatedPreview,
        VERCEL_URL: undefined,
      }),
    ).toThrow("exact Vercel deployment metadata");
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...emulatedPreview,
        PASSKEY_PREVIEW_PROTECTION: undefined,
      }),
    ).toThrow("protection acknowledgement");
  });

  it("rejects a malformed deployment origin in emulated Preview auth", () => {
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...environment,
        APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
        NODE_ENV: "production",
        VERCEL_BRANCH_URL: "app-git-feature-team.vercel.app",
        VERCEL_GIT_COMMIT_REF: "feature/provider-emulation",
        VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
        VERCEL_PROJECT_ID: "prj_preview",
        EMULATE_PREVIEW_RELAY_SECRET: "r".repeat(32),
        EMULATE_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client",
        EMULATE_PREVIEW_GITHUB_CLIENT_SECRET: "g".repeat(20),
        EMULATE_PREVIEW_VERCEL_CLIENT_ID: "preview-vercel-client",
        EMULATE_PREVIEW_VERCEL_CLIENT_SECRET: "v".repeat(20),
        VERCEL_URL: "attacker.example.com",
      }),
    ).toThrow();
  });

  it("accepts Production only when Vercel and the configured environment agree", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        ...environment,
        VERCEL_ENV: "production",
        EVE_HOSTED_VERCEL_ENVIRONMENT: "production",
      }),
    ).toMatchObject({ environment: "production" });

    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...environment,
        VERCEL_ENV: "production",
      }),
    ).toThrow("exact matching Preview or Production");
  });

  it("rejects malformed provider credentials without echoing them", () => {
    const secret = "secret\nmarker";
    let message = "";
    try {
      readPreviewOAuthRuntimeConfig({
        ...environment,
        GITHUB_CLIENT_SECRET: secret,
      });
    } catch (cause) {
      message = cause instanceof Error ? cause.message : String(cause);
    }
    expect(message).not.toContain(secret);
  });
});
