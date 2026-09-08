import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import {
  choiceRequest,
  semanticChoiceRequest,
} from "@/.storybook/create-app/mcp-fixtures";
import { McpBlockStoryLayout } from "@/.storybook/create-app/layouts";
import { InputControl } from "./view";

const meta = {
  title: "Create App/MCP Blocks/Choice Request",
  component: InputControl,
  args: { request: choiceRequest, onAnswer: fn() },
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
export const Generic: Story = {};
export const UnselectedIndicators: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByText("✓")).not.toBeInTheDocument();
    await expect(canvas.getAllByRole("radio")[0]).not.toBeChecked();
  },
};
export const Selected: Story = {
  args: {
    answer: { kind: "answer", optionId: "cursor", value: "Cursor" },
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.getByText("✓")).toBeVisible();
    await expect(canvas.getByRole("radio", { name: "Cursor" })).toBeChecked();
  },
};
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
