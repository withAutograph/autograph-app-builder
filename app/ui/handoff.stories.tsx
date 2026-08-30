import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import { Handoff } from "./app-builder";

const meta = {
  title: "Create App/Flow/Handoff",
  component: Handoff,
  args: { onReady: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Handoff>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Progress: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", { name: "Handoff" }),
    ).toBeVisible();
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Preparing App Brief",
    );
  },
};
