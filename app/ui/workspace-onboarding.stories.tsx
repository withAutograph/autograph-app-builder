import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { WorkspaceOnboarding } from "./workspace-onboarding";

const meta = {
  title: "Components/Workspace Onboarding",
  component: WorkspaceOnboarding,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspaceOnboarding>;

export default meta;
type Story = StoryObj<typeof meta>;

export const SetupRetry: Story = { args: { status: "workspace-setup-retry" } };
export const Ambiguous: Story = { args: { status: "workspace-ambiguous" } };
export const AccessDenied: Story = {
  args: { status: "access-denied" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "Sign out" }),
    ).toHaveAttribute("href", "/auth/sign-out");
  },
};
