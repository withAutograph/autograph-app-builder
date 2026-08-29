import { describe, expect, it } from "vitest";

import { readPreviewOAuthRuntimeConfig } from "./preview-oauth-runtime";

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
} as const;

describe("Preview OAuth runtime configuration", () => {
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
