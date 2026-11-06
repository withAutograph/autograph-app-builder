import type { BuilderForm } from "@/app/ui/builder-types";
import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

const STORY_GITHUB_OWNER = "withAutograph";
const STORY_MODEL_ID = "openai/gpt-5.6-sol";
const STORY_VERCEL_INSTALLATION = "vercel-autograph";
const STORY_VENDOR_PORTAL = "vendor-portal";

export const storyIntegrations: BuilderIntegrationState = {
  github: {
    scopes: [
      {
        accountLogin: STORY_GITHUB_OWNER,
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
    ],
    status: "connected",
  },
  models: {
    cached: false,
    defaultModelId: STORY_MODEL_ID,
    entries: [
      {
        capabilities: ["tool-use"],
        id: STORY_MODEL_ID,
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
        status: "connected",
      },
      {
        displayName: "Sandbox",
        installationId: "vercel-sandbox",
        plan: "Hobby",
        slug: "sandbox",
        status: "connected",
      },
    ],
    status: "connected",
  },
};

export const storyForm: BuilderForm = {
  appName: "Vendor Portal",
  brief: "Build a vendor onboarding portal with a guided approval workflow.",
  buildDestination: "codex",
  connections: ["QuickBooks"],
  githubInstallationId: "101",
  modelId: STORY_MODEL_ID,
  privateRepository: true,
  repository: STORY_VENDOR_PORTAL,
  vercelInstallationId: STORY_VERCEL_INSTALLATION,
};

export const storyProvisioning: BuilderProvisionResponse = {
  appId: STORY_VENDOR_PORTAL,
  github: {
    defaultBranch: "main",
    fullName: "withAutograph/vendor-portal",
    headSha: "a".repeat(40),
    headTree: "b".repeat(40),
    installationId: "101",
    name: STORY_VENDOR_PORTAL,
    owner: STORY_GITHUB_OWNER,
    repositoryId: "202",
    scope: { id: "88", login: STORY_GITHUB_OWNER, type: "organization" },
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
    installationId: STORY_VERCEL_INSTALLATION,
    linkedGitHubRepository: "withAutograph/vendor-portal",
    name: "apps-vendor-portal",
    projectId: "prj_123",
    rootDirectory: "apps/vendor-portal",
    scope: { id: "team_123", slug: "autograph", type: "team" },
    status: "succeeded",
  },
  version: 1,
};

export const storyTeamOptions: { detail: string; label: string; value: string }[] = [
  { detail: "Pro", label: "Autograph", value: STORY_VERCEL_INSTALLATION },
  { detail: "Hobby", label: "Sandbox", value: "vercel-sandbox" },
];

export const storyGitScopeOptions: { detail: string; label: string; value: string }[] = [
  { detail: "Organization", label: STORY_GITHUB_OWNER, value: "101" },
  { detail: "User", label: "jasonmorganson", value: "202" },
];
