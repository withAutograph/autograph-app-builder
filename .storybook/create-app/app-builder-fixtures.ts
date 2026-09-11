import type {
  BuilderForm,
  BuilderHandoffReference,
} from "@/app/ui/app-builder";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

export const storyIntegrations = {
  github: {
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
    status: "connected",
  },
  models: {
    cached: false,
    defaultModelId: "openai/gpt-5.6-sol",
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
    status: "ready",
  },
  vercel: {
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
    status: "connected",
  },
} satisfies BuilderIntegrationState;

export const storyForm: BuilderForm = {
  appName: "Vendor Portal",
  brief: "Build a vendor onboarding portal with a guided approval workflow.",
  buildDestination: "codex",
  connections: ["QuickBooks"],
  githubInstallationId: "101",
  modelId: "openai/gpt-5.6-sol",
  privateRepository: true,
  repository: "vendor-portal",
  vercelInstallationId: "vercel-autograph",
};

export const storyProvisioning = {
  appId: "vendor-portal",
  github: {
    defaultBranch: "main",
    fullName: "withAutograph/vendor-portal",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "101",
    name: "vendor-portal",
    owner: "withAutograph",
    repositoryId: "202",
    scope: { id: "88", login: "withAutograph", type: "organization" },
    starter: {
      archiveBytes: 1024,
      archiveSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
      sourceSha: "c".repeat(40),
      sourceTree: "b".repeat(40),
    },
    status: "succeeded",
    url: "https://github.com/withAutograph/vendor-portal",
    visibility: "private",
  },
  requestDigest: "1".repeat(64),
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  status: "settled",
  updatedAt: "2026-08-30T12:00:00.000Z",
  vercel: {
    dashboardUrl: "https://vercel.com/autograph/apps-vendor-portal",
    framework: "nextjs",
    installationId: "vercel-autograph",
    linkedGitHubRepository: "withAutograph/vendor-portal",
    name: "apps-vendor-portal",
    projectId: "prj_123",
    rootDirectory: "apps/vendor-portal",
    scope: { id: "team_123", slug: "autograph", type: "team" },
    status: "succeeded",
  },
  version: 1,
} satisfies BuilderProvisionResponse;

export const storyHandoff = {
  expiresAt: "2026-09-08T12:00:00.000Z",
  handoffId: "123e4567-e89b-42d3-a456-426614174001",
  version: 1,
} satisfies BuilderHandoffReference;

export const storyTeamOptions = storyIntegrations.vercel.scopes.map(
  (scope) => ({
    detail: scope.plan,
    label: scope.displayName,
    value: scope.installationId,
  })
);

export const storyGitScopeOptions = storyIntegrations.github.scopes.map(
  (scope) => ({
    detail: scope.accountType,
    label: scope.accountLogin,
    value: scope.installationId,
  })
);
