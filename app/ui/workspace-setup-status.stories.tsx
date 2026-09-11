import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, within } from "storybook/test";

import { WorkspaceSetupStatus } from "./workspace-setup-status";

const meta = {
  component: WorkspaceSetupStatus,
  parameters: { layout: "fullscreen" },
  title: "Pages/Auth/Workspace Setup",
} satisfies Meta<typeof WorkspaceSetupStatus>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = { args: { status: "loading" } };
export const Error: Story = {
  args: { callbackUrl: "/?mode=authenticated", status: "error" },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByRole("link", { name: "Return to sign in" })
    ).toHaveAttribute(
      "href",
      "/auth/sign-in?callbackURL=%2F%3Fmode%3Dauthenticated"
    );
  },
};
