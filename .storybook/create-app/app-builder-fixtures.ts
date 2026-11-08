import type { BuilderForm } from "@/app/ui/builder-types";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

const storyDefaultModelId = "openai/gpt-5.6-sol";
const storyVercelInstallationId = "vercel-autograph";
const storyAppId = "vendor-portal";

const storyGithubScopes: {
  accountLogin: string;
  accountType: "Organization" | "User";
  installationId: string;
  status: "connected";
}[] = [
  {
    accountLogin: "withAutograph",
    accountType: "Organization",
    installationId: "101",
    status: "connected",
  },
  {
    accountLogin: "jasonmorganson",
    accountType: "User",
    installationId: "202",
    status: "connected",
  },
];
const storyVercelScopes: {
  displayName: string;
  installationId: string;
  plan: string;
  slug: string;
  status: "connected";
}[] = [
  {
    displayName: "Autograph",
    installationId: storyVercelInstallationId,
    plan: "Pro",
    slug: "autograph",
    status: "connected",
  },
  {
    displayName: "Sandbox",
    installationId: "vercel-sandbox",
    plan: "Hobby",
    slug: "sandbox",
    status: "connected",
  },
];

// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
export const storyIntegrations = {
  github: {
    scopes: storyGithubScopes,
    status: "connected",
  },
  models: {
    cached: false,
    defaultModelId: storyDefaultModelId,
    entries: [
      {
        capabilities: ["tool-use"],
        id: storyDefaultModelId,
        name: "GPT 5.6 Sol",
        provider: "openai",
        zdr: "all",
      },
      {
        capabilities: ["tool-use"],
        id: "openai/gpt-5.6-terra",
        name: "GPT 5.6 Terra",
        provider: "openai",
        zdr: "all",
      },
    ],
    status: "ready",
  },
  vercel: {
    scopes: storyVercelScopes,
    status: "connected",
  },
} satisfies BuilderIntegrationState;

export const storyForm: BuilderForm = {
  appName: "Vendor Portal",
  brief: "Build a vendor onboarding portal with a guided approval workflow.",
  buildDestination: "codex",
  connections: ["QuickBooks"],
  githubInstallationId: "101",
  modelId: storyDefaultModelId,
  privateRepository: true,
  repository: storyAppId,
  vercelInstallationId: storyVercelInstallationId,
};

// oxlint-disable-next-line typescript/no-unsafe-assignment -- Preserve the existing assignment while its type remains unresolved.
export const storyProvisioning = {
  appId: storyAppId,
  github: {
    defaultBranch: "main",
    fullName: "withAutograph/vendor-portal",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "101",
    name: storyAppId,
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
    installationId: storyVercelInstallationId,
    linkedGitHubRepository: "withAutograph/vendor-portal",
    name: "apps-vendor-portal",
    projectId: "prj_123",
    rootDirectory: "apps/vendor-portal",
    scope: { id: "team_123", slug: "autograph", type: "team" },
    status: "succeeded",
  },
  version: 1,
} satisfies BuilderProvisionResponse;

export const storyTeamOptions = storyVercelScopes.map((scope) => ({
  detail: scope.plan,
  label: scope.displayName,
  value: scope.installationId,
}));

export const storyGitScopeOptions = storyGithubScopes.map((scope) => ({
  detail: scope.accountType,
  label: scope.accountLogin,
  value: scope.installationId,
}));
