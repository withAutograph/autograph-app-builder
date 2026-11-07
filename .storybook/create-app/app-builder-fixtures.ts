import type { BuilderForm } from "@/app/ui/builder-types";
import type { BuilderIntegrationState } from "../../lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "../../lib/provisioning/contracts-schema";

const STORY_CONNECTED = "connected" as const;
const STORY_DEFAULT_MODEL = "openai/gpt-5.6-sol";
const STORY_REPOSITORY = "vendor-portal";
const STORY_OWNER = "withAutograph";
const STORY_VERCEL_INSTALLATION = "vercel-autograph";

export const storyIntegrations = {
  github: {
    scopes: [
      {
        accountLogin: STORY_OWNER,
        accountType: "Organization",
        installationId: "101",
        status: STORY_CONNECTED,
      },
      {
        accountLogin: "jasonmorganson",
        accountType: "User",
        installationId: "202",
        status: STORY_CONNECTED,
      },
    ],
    status: STORY_CONNECTED,
  },
  models: {
    cached: false,
    defaultModelId: STORY_DEFAULT_MODEL,
    entries: [
      {
        capabilities: ["tool-use"],
        id: STORY_DEFAULT_MODEL,
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
    scopes: [
      {
        displayName: "Autograph",
        installationId: STORY_VERCEL_INSTALLATION,
        plan: "Pro",
        slug: "autograph",
        status: STORY_CONNECTED,
      },
      {
        displayName: "Sandbox",
        installationId: "vercel-sandbox",
        plan: "Hobby",
        slug: "sandbox",
        status: STORY_CONNECTED,
      },
    ],
    status: STORY_CONNECTED,
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
  repository: STORY_REPOSITORY,
  vercelInstallationId: STORY_VERCEL_INSTALLATION,
};

export const storyProvisioning = {
  appId: "vendor-portal",
  github: {
    defaultBranch: "main",
    fullName: `${STORY_OWNER}/${STORY_REPOSITORY}`,
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "101",
    name: STORY_REPOSITORY,
    owner: STORY_OWNER,
    repositoryId: "202",
    scope: { id: "88", login: STORY_OWNER, type: "organization" },
    starter: {
      archiveBytes: 1024,
      archiveSha256: "d".repeat(64),
      manifestSha256: "e".repeat(64),
      sourceSha: "c".repeat(40),
      sourceTree: "b".repeat(40),
    },
    status: "succeeded",
    url: `https://github.com/${STORY_OWNER}/${STORY_REPOSITORY}`,
    visibility: "private",
  },
  requestDigest: "1".repeat(64),
  requestId: "123e4567-e89b-42d3-a456-426614174000",
  status: "settled",
  updatedAt: "2026-08-30T12:00:00.000Z",
  vercel: {
    dashboardUrl: "https://vercel.com/autograph/apps-vendor-portal",
    framework: "nextjs",
    installationId: STORY_VERCEL_INSTALLATION,
    linkedGitHubRepository: `${STORY_OWNER}/${STORY_REPOSITORY}`,
    name: "apps-vendor-portal",
    projectId: "prj_123",
    rootDirectory: "apps/vendor-portal",
    scope: { id: "team_123", slug: "autograph", type: "team" },
    status: "succeeded",
  },
  version: 1,
} satisfies BuilderProvisionResponse;

export const storyTeamOptions = storyIntegrations.vercel.scopes.map((scope) => ({
  detail: scope.plan,
  label: scope.displayName,
  value: scope.installationId,
}));

export const storyGitScopeOptions = storyIntegrations.github.scopes.map((scope) => ({
  detail: scope.accountType,
  label: scope.accountLogin,
  value: scope.installationId,
}));
