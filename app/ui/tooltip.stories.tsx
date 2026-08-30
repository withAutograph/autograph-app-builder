import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";
import { InfoTooltip } from "./app-builder";

const meta = {
  title: "Create App/Primitives/Tooltip",
  component: InfoTooltip,
  args: { children: "Only use approved providers." },
} satisfies Meta<typeof InfoTooltip>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Focused: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.tab();
    await expect(canvas.getByRole("button")).toHaveFocus();
    await expect(canvas.getByRole("tooltip")).toHaveTextContent(
      "Only use approved providers.",
    );
  },
};
