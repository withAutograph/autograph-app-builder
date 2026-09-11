import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";

import { ApprovalRequest } from "./approval-request";

const meta = {
  args: {
    description:
      "Build and validate the preview shown above in the private App Builder workspace.",
    onAnswer: fn(),
    title: "Build this app?",
  },
  component: ApprovalRequest,
  decorators: [
    (Story) => (
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
  title: "MCP/Authorization/Approval Request",
} satisfies Meta<typeof ApprovalRequest>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(
      canvas.getByText("Keep chatting to refine your app.")
    ).toBeVisible();
    await expect(
      canvas.getByRole("button", { name: "Build app" })
    ).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Make changes" }));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "deny" });
    await userEvent.click(canvas.getByRole("button", { name: "Build app" }));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "approve" });
  },
};
