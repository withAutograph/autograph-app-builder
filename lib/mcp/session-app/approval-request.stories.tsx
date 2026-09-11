import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { ApprovalRequest } from "./approval-request";

const meta = {
  title: "MCP/Authorization/Approval Request",
  component: ApprovalRequest,
  args: {
    title: "Build this app?",
    description: "Build and validate the preview shown above in the private App Builder workspace.",
    onAnswer: fn(),
  },
  decorators: [
    (Story) => (
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
} satisfies Meta<typeof ApprovalRequest>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("Keep chatting to refine your app.")).toBeVisible();
    await expect(canvas.getByRole("button", { name: "Build app" })).toBeVisible();
    await userEvent.click(canvas.getByRole("button", { name: "Make changes" }));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "deny" });
    await userEvent.click(canvas.getByRole("button", { name: "Build app" }));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "approve" });
  },
};
