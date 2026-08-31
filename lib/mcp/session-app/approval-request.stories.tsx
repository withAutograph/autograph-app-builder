import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { approvalRequest } from "@/.storybook/create-app/mcp-fixtures";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { InputControl } from "./view";

const meta = {
  title: "Create App/MCP Blocks/Approval Request",
  component: InputControl,
  args: { request: approvalRequest, onAnswer: fn() },
  decorators: [
    (Story) => (
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
} satisfies Meta<typeof InputControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unanswered: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("✓")).not.toBeInTheDocument();
    await expect(canvas.queryByText("×")).not.toBeInTheDocument();
  },
};
export const Approved: Story = { args: { answer: { kind: "approve" } } };
export const Denied: Story = { args: { answer: { kind: "deny" } } };
export const ApproveAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("Approve"));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "approve" });
  },
};
