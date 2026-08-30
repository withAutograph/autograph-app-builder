import type { BuilderIntegrationState } from "@/lib/integrations/builder-state";

import type { BuilderForm } from "./app-builder";

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
