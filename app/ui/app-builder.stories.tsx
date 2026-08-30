import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  disconnectedBuilderIntegrationState,
  type BuilderIntegrationState,
} from "@/lib/integrations/builder-state";
import { storybookAuthenticatedSession } from "../../.storybook/auth-session";

import {
  AnonymousBuilder,
  AppBuilder,
  Builder,
  ConnectionDrawer,
  Handoff,
  Ready,
  type BuilderForm,
} from "./app-builder";
import type { BuilderProvisionResponse } from "@/lib/provisioning/contracts";

const integrations = {
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
      {
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
        provider: "anthropic",
        capabilities: [],
        zdr: "none",
      },
    ],
    defaultModelId: "openai/gpt-5.6-sol",
    cached: false,
  },
} satisfies BuilderIntegrationState;

const form: BuilderForm = {
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

const provisioning = {
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

const connectionsEnabled =
  process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED === "true";

const meta = {
  title: "Pages/Create App/App Builder",
  component: AppBuilder,
  args: {
    authenticated: true,
    connectionsEnabled,
    integrations: disconnectedBuilderIntegrationState,
  },
  parameters: {
    layout: "fullscreen",
    authSession: storybookAuthenticatedSession,
  },
} satisfies Meta<typeof AppBuilder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Authenticated: Story = {
  play: async ({ canvasElement }) => {
    await expect(window.getComputedStyle(canvasElement).fontFamily).toContain(
      "GeistSans",
    );

    const avatar = canvasElement.querySelector<HTMLElement>(
      '[data-slot="avatar"]',
    );
    await expect(avatar).not.toBeNull();
    await expect(window.getComputedStyle(avatar!).width).toBe("32px");
    await expect(
      canvasElement.querySelector('[data-slot="avatar-fallback"]'),
    ).toHaveTextContent("AU");
  },
};

export const ConnectedProviders: Story = {
  args: { integrations },
};

export const ProviderUnavailable: Story = {
  args: {
    integrations: {
      ...integrations,
      vercel: {
        status: "unavailable",
        scopes: [],
        unavailableReason: "configuration-unavailable",
      },
      github: {
        status: "unavailable",
        scopes: [],
        unavailableReason: "configuration-unavailable",
      },
    },
    providerNotices: [
      { provider: "vercel", status: "failed" },
      { provider: "github", status: "connected" },
    ],
  },
};

export const ModelUnavailable: Story = {
  args: {
    integrations: {
      ...integrations,
      models: { status: "unavailable", entries: [], cached: false },
    },
  },
};

export const Anonymous: Story = {
  args: { authenticated: false },
  parameters: { authSession: null },
};

export const AnonymousBriefAction: Story = {
  render: () => <AnonymousBuilder onContinue={fn()} />,
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("What should this app do?"),
      "Create a vendor portal",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(
      canvas.getByRole("button", { name: "Continue" }),
    ).toBeEnabled();
  },
};

export const RestoredDraft: Story = {
  render: () => (
    <Builder
      initialBrief=""
      connectionsEnabled={connectionsEnabled}
      integrations={integrations}
      providerNotices={[]}
      onCreate={fn()}
      initialDraft={{
        version: 1,
        form,
        team: "vercel-autograph",
        gitScope: "101",
        model: form.modelId,
        zdrOnly: false,
        showMoreConnections: true,
        search: "",
        connectedConnections: ["QuickBooks"],
        focusOrigin: "github",
        appNameEditedByUser: true,
        repositoryEditedByUser: true,
      }}
    />
  ),
};

export const BuilderInteractions: Story = {
  render: () => (
    <Builder
      initialBrief=""
      connectionsEnabled={connectionsEnabled}
      integrations={integrations}
      providerNotices={[]}
      onCreate={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText("App Name"));
    await userEvent.type(canvas.getByLabelText("App Name"), "Finance Hub");
    await expect(canvas.getByPlaceholderText("my-app")).toHaveValue(
      "finance-hub",
    );
    if (!connectionsEnabled) {
      expect(
        canvas.queryByRole("button", { name: "Show more connections" }),
      ).toBeNull();
      return;
    }
    await userEvent.click(
      canvas.getByRole("button", { name: "Show more connections" }),
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Add QuickBooks" }),
    );
    await expect(canvas.getByLabelText("Added connections")).toHaveTextContent(
      "QuickBooks",
    );
  },
};

export const ConnectionDrawerConnect: Story = {
  render: () => (
    <ConnectionDrawer
      flow={{ name: "QuickBooks", stage: "connect" }}
      onClose={fn()}
      onConnected={fn()}
      onStageChange={fn()}
    />
  ),
  parameters: { layout: "fullscreen" },
};

export const ConnectionDrawerConfigure: Story = {
  render: () => (
    <ConnectionDrawer
      flow={{ name: "QuickBooks", stage: "configure" }}
      onClose={fn()}
      onConnected={fn()}
      onStageChange={fn()}
    />
  ),
};

export const ConnectionDrawerCustomize: Story = {
  render: () => (
    <ConnectionDrawer
      flow={{ name: "QuickBooks", stage: "customize" }}
      onClose={fn()}
      onConnected={fn()}
      onStageChange={fn()}
    />
  ),
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.clear(canvas.getByLabelText("Display Name"));
    await userEvent.type(canvas.getByLabelText("Display Name"), "Finance data");
    await expect(canvas.getByLabelText("Display Name")).toHaveValue(
      "Finance data",
    );
  },
};

export const HandoffProgress: Story = {
  render: () => (
    <Handoff
      form={form}
      requestId={provisioning.requestId}
      provisioningEnabled={false}
      onReady={fn()}
    />
  ),
};

export const ReadyToLaunch: Story = {
  render: () => (
    <Ready
      form={form}
      requestId={provisioning.requestId}
      initialProvisioning={provisioning}
      provisioningEnabled
      initialAttempt="attempted"
      initialClipboardState="copied"
      onReset={fn()}
    />
  ),
};

export const ReadyLongBrief: Story = {
  render: () => (
    <Ready
      form={{ ...form, brief: "x".repeat(8_100) }}
      requestId={provisioning.requestId}
      initialProvisioning={{
        ...provisioning,
        vercel: {
          status: "failed",
          code: "provider_rejected",
          retryable: true,
        },
      }}
      provisioningEnabled
      initialAttempt="too-long"
      initialClipboardState="failed"
      onReset={fn()}
    />
  ),
};

export const ReadyGitHubOnly: Story = {
  render: () => (
    <Ready
      form={{ ...form, vercelInstallationId: undefined }}
      requestId={provisioning.requestId}
      initialProvisioning={{
        ...provisioning,
        vercel: {
          status: "skipped",
          code: "not_selected",
          retryable: false,
        },
      }}
      provisioningEnabled
      initialAttempt="attempted"
      initialClipboardState="copied"
      onReset={fn()}
    />
  ),
};

export const ReadyVercelOnly: Story = {
  render: () => (
    <Ready
      form={{ ...form, githubInstallationId: undefined }}
      requestId={provisioning.requestId}
      initialProvisioning={{
        ...provisioning,
        github: {
          status: "skipped",
          code: "not_selected",
          retryable: false,
        },
        vercel: {
          ...provisioning.vercel,
          linkedGitHubRepository: undefined,
        },
      }}
      provisioningEnabled
      initialAttempt="attempted"
      initialClipboardState="copied"
      onReset={fn()}
    />
  ),
};

export const ReadyWithoutProviders: Story = {
  render: () => (
    <Ready
      form={{
        ...form,
        githubInstallationId: undefined,
        vercelInstallationId: undefined,
      }}
      requestId={provisioning.requestId}
      initialProvisioning={{
        ...provisioning,
        github: {
          status: "skipped",
          code: "not_selected",
          retryable: false,
        },
        vercel: {
          status: "skipped",
          code: "not_selected",
          retryable: false,
        },
      }}
      provisioningEnabled
      initialAttempt="attempted"
      initialClipboardState="copied"
      onReset={fn()}
    />
  ),
};

export const ReadyPartialFailure: Story = {
  render: () => (
    <Ready
      form={form}
      requestId={provisioning.requestId}
      initialProvisioning={{
        ...provisioning,
        vercel: {
          status: "failed",
          code: "provider_rejected",
          retryable: true,
        },
      }}
      provisioningEnabled
      initialAttempt="attempted"
      initialClipboardState="copied"
      onReset={fn()}
    />
  ),
};
