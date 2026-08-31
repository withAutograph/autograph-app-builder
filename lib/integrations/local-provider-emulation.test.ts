import { describe, expect, it } from "vitest";
import { readGitHubAppInstallationEnvironment } from "../auth/github-app-installation";
import {
  providerEmulationEnvironment,
  readLocalProviderEmulation,
  readPreviewProviderEmulation,
} from "./local-provider-emulation";

const environment = {
  APP_BUILDER_LOCAL_PROVIDER_EMULATION: "1",
  NODE_ENV: "development",
  VERCEL_EMULATOR_URL: "http://localhost:4000",
  GITHUB_EMULATOR_URL: "https://github.emulate.localhost",
  EMULATE_PROVIDER_TOKEN: "x".repeat(20),
  EMULATE_GITHUB_REPOSITORY: "autograph-local/demo-app",
  EMULATE_LOCAL_RELAY_SECRET: "s".repeat(32),
  BETTER_AUTH_URL: "https://localhost:3001/api/auth",
  GITHUB_CLIENT_ID: "github-client",
  GITHUB_CLIENT_SECRET: "g".repeat(20),
  VERCEL_AUTH_CLIENT_ID: "vercel-client",
  VERCEL_AUTH_CLIENT_SECRET: "v".repeat(20),
};

const previewSecrets = {
  EMULATE_PREVIEW_RELAY_SECRET: "s".repeat(32),
  EMULATE_PREVIEW_GITHUB_CLIENT_ID: "preview-github-client",
  EMULATE_PREVIEW_GITHUB_CLIENT_SECRET: "g".repeat(20),
  EMULATE_PREVIEW_VERCEL_CLIENT_ID: "preview-vercel-client",
  EMULATE_PREVIEW_VERCEL_CLIENT_SECRET: "v".repeat(20),
};

describe("local provider emulation", () => {
  it("accepts only explicit local development origins", () => {
    expect(readLocalProviderEmulation(environment)).toMatchObject({
      vercelOrigin: "http://localhost:4000",
    });
    expect(() =>
      readLocalProviderEmulation({ ...environment, VERCEL_ENV: "preview" }),
    ).toThrow();
    expect(() =>
      readLocalProviderEmulation({
        ...environment,
        GITHUB_EMULATOR_URL: "https://api.github.com",
      }),
    ).toThrow();
  });

  it("exposes the canonical local origin to deployment handlers", () => {
    expect(providerEmulationEnvironment(environment)).toMatchObject({
      APP_ORIGIN: "https://localhost:3001",
    });
  });

  it("selects an exact branch-scoped Vercel Preview transport", () => {
    const preview = readPreviewProviderEmulation({
      NODE_ENV: "production",
      VERCEL_ENV: "preview",
      APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
      VERCEL_BRANCH_URL: "app-git-feature-team.vercel.app",
      VERCEL_GIT_COMMIT_REF: "feature/provider-emulation",
      VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
      VERCEL_PROJECT_ID: "prj_preview",
      ...previewSecrets,
    });
    expect(preview).toMatchObject({
      mode: "preview",
      canonicalOrigin: "https://app-git-feature-team.vercel.app",
      githubOrigin:
        "https://app-git-feature-team.vercel.app/api/emulate/github",
      namespace:
        "autograph-app-builder:prj_preview:feature/provider-emulation:seed-v2",
    });
    expect(
      providerEmulationEnvironment({
        NODE_ENV: "production",
        VERCEL_ENV: "preview",
        APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
        VERCEL_URL: "app-commit-team.vercel.app",
        VERCEL_GIT_COMMIT_REF: "feature",
        VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
        VERCEL_PROJECT_ID: "prj_preview",
        ...previewSecrets,
      }),
    ).toMatchObject({
      BETTER_AUTH_URL: "https://app-commit-team.vercel.app/api/auth",
      MCP_RESOURCE_URL: "https://app-commit-team.vercel.app/mcp",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_SLUG: "autograph-app-builder",
      GITHUB_APP_INSTALL_STATE_SECRET:
        previewSecrets.EMULATE_PREVIEW_RELAY_SECRET,
      VERCEL_INTEGRATION_SLUG: "autograph-app-builder",
      VERCEL_INTEGRATION_TOKEN_KEY_VERSION: "preview-emulation-v1",
    });

    expect(
      readGitHubAppInstallationEnvironment(
        providerEmulationEnvironment({
          NODE_ENV: "production",
          VERCEL_ENV: "preview",
          APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
          VERCEL_URL: "app-commit-team.vercel.app",
          VERCEL_GIT_COMMIT_REF: "feature",
          VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
          VERCEL_PROJECT_ID: "prj_preview",
          DATABASE_URL: "postgresql://preview:secret@db.example.test/app",
          BETTER_AUTH_SECRET: "b".repeat(32),
          ...previewSecrets,
        }),
      ),
    ).toMatchObject({
      appId: "12345",
      appSlug: "autograph-app-builder",
      clientId: "preview-github-client",
    });
  });

  it("rejects deployed non-Preview and malformed Preview activation", () => {
    const base = {
      NODE_ENV: "production",
      APP_BUILDER_PREVIEW_PROVIDER_EMULATION: "1",
      VERCEL_ENV: "preview",
      VERCEL_GIT_COMMIT_REF: "feature",
      VERCEL_GIT_REPO_SLUG: "autograph-app-builder",
      VERCEL_PROJECT_ID: "prj_preview",
      ...previewSecrets,
    };
    expect(() =>
      readPreviewProviderEmulation({
        ...base,
        VERCEL_ENV: "production",
        VERCEL_URL: "app.vercel.app",
      }),
    ).toThrow("unavailable");
    expect(() =>
      readPreviewProviderEmulation({
        ...base,
        VERCEL_URL: "attacker.example.com",
      }),
    ).toThrow();
    expect(() =>
      readPreviewProviderEmulation({
        ...base,
        VERCEL_URL: "app.vercel.app",
        VERCEL_GIT_COMMIT_REF: "",
      }),
    ).toThrow();
  });
});
