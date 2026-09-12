import { beforeEach, expect, it, vi } from "vitest";

import { readProductionNavigationRuntimeConfig } from "./production-navigation";

const artifact = vi.hoisted(() => ({ productionNavigationArtifact: false }));
vi.mock("./production-navigation-artifact", () => artifact);

const fixture = {
  NODE_ENV: "production",
  APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: "https://localhost:3107",
  BETTER_AUTH_URL: "https://localhost:3107/api/auth",
  MCP_RESOURCE_URL: "https://localhost:3107/mcp",
  BETTER_AUTH_SECRET: "production-navigation-fixture-secret-only",
  DATABASE_URL: "postgresql://postgres@127.0.0.1:54321/autograph_navigation_fixture",
  GITHUB_CLIENT_ID: "navigation-github-client",
  GITHUB_CLIENT_SECRET: "navigation-github-secret",
  VERCEL_AUTH_CLIENT_ID: "navigation-vercel-client",
  VERCEL_AUTH_CLIENT_SECRET: "navigation-vercel-secret",
};

beforeEach(() => {
  artifact.productionNavigationArtifact = false;
});

it("cannot be activated by environment variables in the committed artifact", () => {
  expect(
    readProductionNavigationRuntimeConfig({ ...fixture, APP_BUILDER_PRODUCTION_NAVIGATION: "1" }),
  ).toBeNull();
  expect(readProductionNavigationRuntimeConfig({ ...fixture, VERCEL: "1" })).toBeNull();
});

it("admits only guarded disposable artifacts and returns real-session auth configuration", () => {
  artifact.productionNavigationArtifact = true;
  expect(readProductionNavigationRuntimeConfig(fixture)).toEqual({
    hostedAdapter: "1",
    environment: "local",
    issuer: fixture.BETTER_AUTH_URL,
    resource: fixture.MCP_RESOURCE_URL,
    trustedOrigins: [fixture.APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN],
    secret: fixture.BETTER_AUTH_SECRET,
    databaseUrl: fixture.DATABASE_URL,
    githubClientId: fixture.GITHUB_CLIENT_ID,
    githubClientSecret: fixture.GITHUB_CLIENT_SECRET,
    vercelClientId: fixture.VERCEL_AUTH_CLIENT_ID,
    vercelClientSecret: fixture.VERCEL_AUTH_CLIENT_SECRET,
    passkeyOnboarding: null,
  });
});

it.each([
  "VERCEL",
  "VERCEL_ENV",
  "VERCEL_URL",
  "VERCEL_DEPLOYMENT_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_ORG_ID",
  "DEPLOYMENT_ID",
  "PROJECT_ID",
  "APP_BUILDER_DEPLOYMENT_ID",
  "APP_BUILDER_PROJECT_ID",
])("rejects deployment identity %s even in a modified artifact", (key) => {
  artifact.productionNavigationArtifact = true;
  expect(() => readProductionNavigationRuntimeConfig({ ...fixture, [key]: "present" })).toThrow(
    "deployment identity",
  );
});

it.each([
  { NODE_ENV: "development" },
  { APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: "http://localhost:3107" },
  { APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: "https://example.com:3107" },
  { APP_BUILDER_PRODUCTION_NAVIGATION_ORIGIN: "https://localhost:3107/" },
  { BETTER_AUTH_URL: "https://localhost:3107/api/auth?test=1" },
  { MCP_RESOURCE_URL: "https://localhost:3108/mcp" },
  { DATABASE_URL: "postgresql://postgres@remote.example:54321/autograph_navigation_fixture" },
  { DATABASE_URL: "postgresql://postgres@127.0.0.1:54321/autograph_app_builder" },
  {
    DATABASE_URL:
      "postgresql://postgres@127.0.0.1:54321/autograph_navigation_fixture?host=remote.example",
  },
  { BETTER_AUTH_SECRET: "short" },
  { GITHUB_CLIENT_SECRET: undefined },
  { APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1" },
  { APP_BUILDER_LOCAL_AUTH_EMULATION: "1" },
  { APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1" },
])("rejects unsafe fixture override %o", (override) => {
  artifact.productionNavigationArtifact = true;
  expect(() => readProductionNavigationRuntimeConfig({ ...fixture, ...override })).toThrow();
});
