import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { AnonymousBuilder } from "./app-builder";

const meta = {
  title: "Create App/Flow/Anonymous Entry",
  component: AnonymousBuilder,
  args: { onContinue: fn() },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AnonymousBuilder>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Empty: Story = {};
export const ContinueAction: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("What should this app do?"),
      "Create a vendor portal",
    );
    await userEvent.click(canvas.getByRole("button", { name: "Continue" }));
    await expect(args.onContinue).toHaveBeenCalledWith(
      "Create a vendor portal",
    );
  },
};
export const SuggestionAction: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Build a customer feedback portal" }),
    );
    await expect(canvas.getByLabelText("What should this app do?")).toHaveValue(
      "Build a customer feedback portal",
    );
  },
};
