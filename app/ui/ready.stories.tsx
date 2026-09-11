import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import {
  storyForm,
  storyHandoff,
  storyProvisioning,
} from "@/.storybook/create-app/app-builder-fixtures";

import { Ready } from "./app-builder";

const meta = {
  args: {
    form: storyForm,
    initialAttempt: "attempted",
    initialClipboardState: "copied",
    initialHandoff: storyHandoff,
    initialProvisioning: storyProvisioning,
    onReset: fn(),
    provisioningEnabled: true,
    requestId: storyProvisioning.requestId,
  },
  component: Ready,
  parameters: { layout: "fullscreen" },
  title: "Create App/Recovery/Ready",
} satisfies Meta<typeof Ready>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LaunchRequested: Story = {};
export const ClipboardFailed: Story = {
  args: { initialAttempt: "blocked", initialClipboardState: "failed" },
};
export const LargeBriefUsesOpaqueHandoff: Story = {
  args: {
    form: { ...storyForm, brief: "x".repeat(8100) },
    initialAttempt: "attempted",
    initialClipboardState: "copied",
  },
};
export const GitHubOnly: Story = {
  args: {
    form: { ...storyForm, vercelInstallationId: undefined },
    initialProvisioning: {
      ...storyProvisioning,
      vercel: {
        code: "not_selected",
        retryable: false,
        status: "skipped",
      },
    },
  },
};
export const VercelOnly: Story = {
  args: {
    form: { ...storyForm, githubInstallationId: undefined },
    initialProvisioning: {
      ...storyProvisioning,
      github: {
        code: "not_selected",
        retryable: false,
        status: "skipped",
      },
      vercel: {
        ...storyProvisioning.vercel,
        linkedGitHubRepository: undefined,
      },
    },
  },
};
export const WithoutProviders: Story = {
  args: {
    form: {
      ...storyForm,
      githubInstallationId: undefined,
      vercelInstallationId: undefined,
    },
    initialProvisioning: {
      ...storyProvisioning,
      github: {
        code: "not_selected",
        retryable: false,
        status: "skipped",
      },
      vercel: {
        code: "not_selected",
        retryable: false,
        status: "skipped",
      },
    },
  },
};
export const PartialFailure: Story = {
  args: {
    initialProvisioning: {
      ...storyProvisioning,
      vercel: {
        code: "provider_rejected",
        retryable: true,
        status: "failed",
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "App created with an issue" })
    ).toBeInTheDocument();
    await expect(canvas.getByText("Setup needs attention")).toBeInTheDocument();
    await expect(
      canvas.getByText(/Retry to finish setting up Vercel/u)
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
  },
};
export const DismissInstallInstructions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Dismiss install instructions" })
    );
    await expect(
      canvas.queryByRole("heading", { name: "Install App Builder Plugin" })
    ).not.toBeInTheDocument();
  },
};
export const ResetAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Create Another App" })
    );
    await expect(args.onReset).toHaveBeenCalledOnce();
  },
};
