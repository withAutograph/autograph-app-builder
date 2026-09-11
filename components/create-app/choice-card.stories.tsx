import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";

import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";

import { ChoiceCard } from "./choice-card";

import styles from "../../app/ui/app-builder.module.css";

const meta = {
  args: {
    checked: false,
    children: "ChatGPT / Codex",
    name: "destination",
    onChange: fn(),
    value: "codex",
  },
  component: ChoiceCard,
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <div className={styles.optionGrid}>
          <Story />
        </div>
      </CreateAppFormStoryLayout>
    ),
  ],
  title: "Components/Create App/Primitives/Choice Card",
} satisfies Meta<typeof ChoiceCard>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Unselected: Story = {};
export const Selected: Story = { args: { checked: true } };
export const ComingSoon: Story = {
  args: { badge: "Coming soon", children: "Web Chat", disabled: true },
};
export const ToggleAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("ChatGPT / Codex"));
    await expect(args.onChange).toHaveBeenCalledOnce();
  },
};
