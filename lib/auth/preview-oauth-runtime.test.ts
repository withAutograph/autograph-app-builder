import { describe, expect, it, vi } from "vitest";

import {
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
} as const;

describe("Preview OAuth runtime configuration", () => {
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
      selfServiceSignupEnabled: false,
    });
    for (const field of ["GITHUB_CLIENT_ID", "GITHUB_CLIENT_SECRET"] as const) {
      expect(() =>
        readPreviewOAuthRuntimeConfig({ ...environment, [field]: undefined }),
      ).toThrow();
    }
  });

  it("enables personal workspace signup only for the exact feature flag", () => {
    expect(
      readPreviewOAuthRuntimeConfig({
        ...environment,
        SELF_SERVICE_SIGNUP_ENABLED: "1",
      }),
    ).toMatchObject({ selfServiceSignupEnabled: true });
    expect(() =>
      readPreviewOAuthRuntimeConfig({
        ...environment,
        SELF_SERVICE_SIGNUP_ENABLED: "true",
      }),
    ).toThrow();
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
        BETTER_AUTH_URL: "https://localhost:3001/api/auth",
        MCP_RESOURCE_URL: "https://localhost:3001/mcp",
        BETTER_AUTH_SECRET: "a".repeat(32),
        GITHUB_CLIENT_ID: "local-github-client",
        GITHUB_CLIENT_SECRET: "local-github-secret",
        VERCEL_AUTH_CLIENT_ID: "local-vercel-client",
        VERCEL_AUTH_CLIENT_SECRET: "local-vercel-secret",
        VERCEL_EMULATOR_URL: "http://localhost:4000",
        GITHUB_EMULATOR_URL: "http://localhost:4001",
        EMULATE_PROVIDER_TOKEN: "a".repeat(20),
        EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
        EMULATE_LOCAL_RELAY_SECRET: "a".repeat(32),
      }),
    ).toMatchObject({
      environment: "local",
      databaseUrl:
        "postgresql://postgres@127.0.0.1:54329/autograph_app_builder",
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
