import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { InputControl } from "./view";
import { choiceRequest, semanticChoiceRequest } from "./story-fixtures";
import { McpStoryFrame } from "./story-frame";

const meta = {
  title: "Create App/MCP Blocks/Choice Request",
  component: InputControl,
  args: { request: choiceRequest, onAnswer: fn() },
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
export const Generic: Story = {};
export const SemanticCreateAppChoice: Story = {
  args: { request: semanticChoiceRequest },
};
export const SelectAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("Cursor"));
    await expect(args.onAnswer).toHaveBeenCalledWith({
      kind: "answer",
      optionId: "cursor",
      value: "Cursor",
    });
  },
};
