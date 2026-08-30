import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { freeformRequest } from "@/.storybook/create-app/mcp-fixtures";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { InputControl } from "./view";

const meta = {
  title: "Create App/MCP Blocks/Freeform Request",
  component: InputControl,
  args: { request: freeformRequest, onAnswer: fn() },
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
export const Empty: Story = {};
export const Answered: Story = {
  args: { answer: { kind: "answer", value: "Finance operators" } },
};
export const TypeAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.type(
      within(canvasElement).getByLabelText("Who will use this app?"),
      "Finance operators",
    );
    await expect(args.onAnswer).toHaveBeenCalled();
  },
};
