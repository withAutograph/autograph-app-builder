import { generateKeyPairSync } from "node:crypto";
import { readFile } from "node:fs/promises";

import { describe, expect, it, vi } from "vitest";

import type {
  GitHubPublicationAdapter,
  GitHubPublicationReceiptStore,
} from "../repository/github-publication";
import type { HostedGitHubInstallationStore } from "../repository/postgres-github-installation-store";
import type { GitHubPublicationProposalStore } from "../repository/postgres-github-publication-store";
import {
  createDeploymentGitHubPublicationRuntimeResolver,
  readDeploymentGitHubPublicationConfig,
} from "./deployment-github-publication-runtime";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKeyPem = privateKey
  .export({ type: "pkcs8", format: "pem" })
  .toString();

const environment = {
  APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "1",
  EVE_HOSTED_ADAPTER: "1",
  VERCEL_ENV: "preview",
  EVE_HOSTED_VERCEL_ENVIRONMENT: "preview",
  EVE_HOSTED_VERCEL_TEAM_SLUG: "autographing",
  EVE_HOSTED_VERCEL_PROJECT_NAME: "autograph-app-builder",
  DATABASE_URL: "postgresql://runtime:secret@database.example.test/builder",
  GITHUB_APP_ID: "123",
  GITHUB_APP_PRIVATE_KEY: privateKeyPem,
};

const authority = {
  issuer: "https://builder.example.test/api/auth",
  audience: "https://builder.example.test/mcp",
  workspaceId: "workspace_one",
  ownerUserId: "user_one",
};

const forwarded = {
  attributes: {
    "eve:forwarded-by": "owner:autographing:project:autograph-app-builder",
    "mcp:audience": authority.audience,
    "mcp:scopes": ["eve:session"],
    "mcp:workspace-id": authority.workspaceId,
  },
  authenticator: "mcp-oauth-jwks",
  issuer: authority.issuer,
  principalId: authority.ownerUserId,
  principalType: "user",
  subject: authority.ownerUserId,
} as const;

const proposals: GitHubPublicationProposalStore = {
  async read() {
    return undefined;
  },
  async save() {},
};
const receipts: GitHubPublicationReceiptStore = {
  async read() {
    return undefined;
  },
  async compareAndSet() {
    return true;
  },
};

describe("deployment GitHub publication composition", () => {
  it("keeps absent and explicit-zero configurations disabled", () => {
    expect(readDeploymentGitHubPublicationConfig({})).toEqual({
      enabled: false,
    });
    expect(
      readDeploymentGitHubPublicationConfig({
        APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
      }),
    ).toEqual({ enabled: false });
  });

  it("parses only the exact enabled Preview credential binding", () => {
    expect(readDeploymentGitHubPublicationConfig(environment)).toEqual({
      enabled: true,
      databaseUrl: environment.DATABASE_URL,
      forwarderSubject:
        "owner:autographing:project:autograph-app-builder:environment:preview",
      providerCredentials: {
        appId: "123",
        privateKey: privateKeyPem,
      },
    });
    for (const invalid of [
      { ...environment, APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "true" },
      { ...environment, VERCEL_ENV: "production" },
      { ...environment, EVE_HOSTED_ADAPTER: "0" },
      { ...environment, EVE_HOSTED_VERCEL_ENVIRONMENT: "production" },
      { ...environment, EVE_HOSTED_VERCEL_TEAM_SLUG: "*" },
      { ...environment, DATABASE_URL: "mysql://database.example.test/app" },
      { ...environment, GITHUB_APP_PRIVATE_KEY: "not-a-key" },
    ]) {
      expect(() => readDeploymentGitHubPublicationConfig(invalid)).toThrow();
    }
  });

  it.each(["GITHUB_APP_INSTALLATION_ID", "GITHUB_TOKEN", "GITHUB_API_URL"])(
    "rejects forbidden ambient %s authority even when disabled",
    (key) => {
      expect(() =>
        readDeploymentGitHubPublicationConfig({
          APP_BUILDER_GITHUB_PUBLICATION_ENABLED: "0",
          [key]: "forbidden",
        }),
      ).toThrow("forbidden ambient authority");
    },
  );

  it("constructs the provider only from the live tenant installation binding", async () => {
    const database = {} as never;
    const openDatabase = vi.fn(async () => database);
    const adapter = {} as GitHubPublicationAdapter;
    const createAdapter = vi.fn(() => adapter);
    const installationStore: HostedGitHubInstallationStore = {
      read: vi.fn(async () => ({
        installationId: "456",
        accountId: "789",
        accountLogin: "withAutograph",
        accountType: "Organization" as const,
        active: true,
        updatedAt: new Date("2026-08-28T00:00:00.000Z"),
      })),
      bind: vi.fn(),
    };
    const resolver = createDeploymentGitHubPublicationRuntimeResolver({
      environment,
      openDatabase,
      createAdapter,
      resolverDependencies: {
        membership: () => ({ isMember: vi.fn(async () => true) }),
        installations: () => installationStore,
        publicationStores: () => ({ proposals, receipts }),
      },
    });

    const runtime = await resolver.resolve({
      current: structuredClone(forwarded),
      initiator: structuredClone(forwarded),
    });

    await expect(runtime.status()).resolves.toMatchObject({ enabled: true });
    expect(openDatabase).toHaveBeenCalledTimes(1);
    expect(openDatabase).toHaveBeenCalledWith(environment.DATABASE_URL);
    expect(installationStore.read).toHaveBeenCalledWith(authority);
    expect(createAdapter).toHaveBeenCalledWith({
      appId: "123",
      installationId: "456",
      privateKey: privateKeyPem,
    });
  });

  it("routes all five GitHub tools through the per-session resolver", async () => {
    for (const path of [
      "agent/tools/github_publication_status.ts",
      "agent/tools/resolve_github_source.ts",
      "agent/tools/seal_github_draft_pr_proposal.ts",
      "agent/tools/create_github_repository.ts",
      "agent/tools/publish_github_draft_pr.ts",
    ]) {
      const source = await readFile(path, "utf8");
      expect(source).toContain("githubPublicationRuntimeForSession");
      expect(source).toContain("ctx.session.auth");
      expect(source).not.toContain("githubPublicationRuntime.");
    }
  });
});
