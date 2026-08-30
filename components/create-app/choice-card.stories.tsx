import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import styles from "../../app/ui/app-builder.module.css";
import { ChoiceCard } from "./choice-card";

const meta = {
  title: "Create App/Primitives/Choice Card",
  component: ChoiceCard,
  args: {
    checked: false,
    name: "destination",
    value: "codex",
    onChange: fn(),
    children: "ChatGPT / Codex",
  },
  decorators: [
    (Story) => (
      <div className={styles.optionGrid}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof ChoiceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {};
export const Selected: Story = { args: { checked: true } };
export const ComingSoon: Story = {
  args: { badge: "Coming soon", disabled: true, children: "Web Chat" },
};
export const ToggleAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("ChatGPT / Codex"));
    await expect(args.onChange).toHaveBeenCalledOnce();
  },
};
