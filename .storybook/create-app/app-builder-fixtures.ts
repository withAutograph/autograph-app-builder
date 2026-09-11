import type { BuilderForm } from "@/app/ui/app-builder";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

export const storyIntegrations = {
  vercel: {
    status: "connected",
    scopes: [
      {
        installationId: "vercel-autograph",
        status: "connected",
        displayName: "Autograph",
        slug: "autograph",
        plan: "Pro",
      },
      {
        installationId: "vercel-sandbox",
        status: "connected",
        displayName: "Sandbox",
        slug: "sandbox",
        plan: "Hobby",
      },
    ],
  },
  github: {
    status: "connected",
    scopes: [
      {
        installationId: "101",
        status: "connected",
        accountLogin: "withAutograph",
        accountType: "Organization",
      },
      {
        installationId: "202",
        status: "connected",
        accountLogin: "jasonmorganson",
        accountType: "User",
      },
    ],
  },
  models: {
    status: "ready",
    entries: [
      {
        id: "openai/gpt-5.6-sol",
        name: "GPT 5.6 Sol",
        provider: "openai",
        capabilities: ["tool-use"],
        zdr: "all",
      },
      {
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        provider: "openai",
        capabilities: ["tool-use"],
        zdr: "all",
      },
    ],
    defaultModelId: "openai/gpt-5.6-sol",
    cached: false,
  },
} satisfies BuilderIntegrationState;

export const storyForm: BuilderForm = {
  appName: "Vendor Portal",
  repository: "vendor-portal",
  brief: "Build a vendor onboarding portal with a guided approval workflow.",
  privateRepository: true,
  buildDestination: "codex",
  connections: ["QuickBooks"],
  vercelInstallationId: "vercel-autograph",
  githubInstallationId: "101",
  modelId: "openai/gpt-5.6-sol",
};

export const storyProvisioning = {
  version: 1,
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  requestDigest: "1".repeat(64),
  appId: "vendor-portal",
  status: "settled",
  github: {
    status: "succeeded",
    installationId: "101",
    repositoryId: "202",
    owner: "withAutograph",
    name: "vendor-portal",
    fullName: "withAutograph/vendor-portal",
    url: "https://github.com/withAutograph/vendor-portal",
    scope: { type: "organization", id: "88", login: "withAutograph" },
    visibility: "private",
    defaultBranch: "main",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    starter: {
      sourceSha: "c".repeat(40),
      sourceTree: "b".repeat(40),
      archiveSha256: "d".repeat(64),
      archiveBytes: 1024,
      manifestSha256: "e".repeat(64),
    },
  },
  vercel: {
    status: "succeeded",
    installationId: "vercel-autograph",
    projectId: "prj_123",
    name: "apps-vendor-portal",
    dashboardUrl: "https://vercel.com/autograph/apps-vendor-portal",
    scope: { type: "team", id: "team_123", slug: "autograph" },
    framework: "nextjs",
    rootDirectory: "apps/vendor-portal",
    linkedGitHubRepository: "withAutograph/vendor-portal",
  },
  updatedAt: "2026-08-30T12:00:00.000Z",
} satisfies BuilderProvisionResponse;

export const storyTeamOptions = storyIntegrations.vercel.scopes.map(
  (scope) => ({
    value: scope.installationId,
    label: scope.displayName,
    detail: scope.plan,
  }),
);

export const storyGitScopeOptions = storyIntegrations.github.scopes.map(
  (scope) => ({
    value: scope.installationId,
    label: scope.accountLogin,
    detail: scope.accountType,
  }),
);
