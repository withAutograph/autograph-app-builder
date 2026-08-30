import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { approvalRequest } from "./story-fixtures";
import { McpStoryFrame } from "./story-frame";
import { InputControl } from "./view";

const meta = {
  title: "Create App/MCP Blocks/Approval Request",
  component: InputControl,
  args: { request: approvalRequest, onAnswer: fn() },
  decorators: [
    (Story) => (
      <McpStoryFrame>
        <Story />
      </McpStoryFrame>
    ),
  ],
} satisfies Meta<typeof InputControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Unanswered: Story = {};
export const Approved: Story = { args: { answer: { kind: "approve" } } };
export const Denied: Story = { args: { answer: { kind: "deny" } } };
export const ApproveAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("Approve"));
    await expect(args.onAnswer).toHaveBeenCalledWith({ kind: "approve" });
  },
};
