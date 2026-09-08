import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  storyForm,
  storyHandoff,
  storyProvisioning,
} from "@/.storybook/create-app/app-builder-fixtures";
import { Ready } from "./app-builder";

const meta = {
  title: "Create App/Flow/Ready",
  component: Ready,
  args: {
    form: storyForm,
    requestId: storyProvisioning.requestId,
    initialHandoff: storyHandoff,
    initialProvisioning: storyProvisioning,
    provisioningEnabled: true,
    initialAttempt: "attempted",
    initialClipboardState: "copied",
    onReset: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Ready>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LaunchRequested: Story = {};
export const ClipboardFailed: Story = {
  args: { initialAttempt: "blocked", initialClipboardState: "failed" },
};
export const LargeBriefUsesOpaqueHandoff: Story = {
  args: {
    form: { ...storyForm, brief: "x".repeat(8_100) },
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
        status: "skipped",
        code: "not_selected",
        retryable: false,
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
        status: "skipped",
        code: "not_selected",
        retryable: false,
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
        status: "skipped",
        code: "not_selected",
        retryable: false,
      },
      vercel: {
        status: "skipped",
        code: "not_selected",
        retryable: false,
      },
    },
  },
};
export const PartialFailure: Story = {
  args: {
    initialProvisioning: {
      ...storyProvisioning,
      vercel: {
        status: "failed",
        code: "provider_rejected",
        retryable: true,
      },
    },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("heading", { name: "App created with an issue" }),
    ).toBeInTheDocument();
    await expect(canvas.getByText("Setup needs attention")).toBeInTheDocument();
    await expect(
      canvas.getByText(/Retry to finish setting up Vercel/u),
    ).toBeInTheDocument();
    await expect(canvas.getByRole("button", { name: "Retry" })).toBeVisible();
  },
};
export const DismissInstallInstructions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Dismiss install instructions" }),
    );
    await expect(
      canvas.queryByRole("heading", { name: "Install App Builder Plugin" }),
    ).not.toBeInTheDocument();
  },
};
export const ResetAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Create Another App" }),
    );
    await expect(args.onReset).toHaveBeenCalledOnce();
  },
};
