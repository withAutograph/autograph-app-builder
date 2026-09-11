import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { freeformRequest } from "@/.storybook/create-app/mcp-fixtures";

import { InputControl } from "./view";

const meta = {
  args: { onAnswer: fn(), request: freeformRequest },
  component: InputControl,
  decorators: [
    (Story) => (
      <McpBlockStoryLayout>
        <Story />
      </McpBlockStoryLayout>
    ),
  ],
  title: "MCP/Inputs/Freeform Request",
} satisfies Meta<typeof InputControl>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const Answered: Story = {
  args: { answer: { kind: "answer", value: "Finance operators" } },
};
export const TypeAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.type(
      within(canvasElement).getByLabelText("Who will use this app?"),
      "Finance operators"
    );
    await expect(args.onAnswer).toHaveBeenCalled();
  },
};
