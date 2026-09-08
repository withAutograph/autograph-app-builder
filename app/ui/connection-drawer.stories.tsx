import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ConnectionDrawer } from "./app-builder";

const meta = {
  title: "Create App/Flow/Connection Drawer",
  component: ConnectionDrawer,
  args: {
    flow: { name: "QuickBooks", stage: "connect" },
    onClose: fn(),
    onConnected: fn(),
    onStageChange: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ConnectionDrawer>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Connect: Story = {};
export const Configure: Story = {
  args: { flow: { name: "QuickBooks", stage: "configure" } },
};
export const Customize: Story = {
  args: { flow: { name: "QuickBooks", stage: "customize" } },
};
export const CloseAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Close" }),
    );
    await expect(args.onClose).toHaveBeenCalledOnce();
  },
};
export const ConfigureAction: Story = {
  args: { flow: { name: "QuickBooks", stage: "configure" } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Continue" }),
    );
    await expect(args.onStageChange).toHaveBeenCalledWith("customize");
  },
};
export const AddAction: Story = {
  args: { flow: { name: "QuickBooks", stage: "customize" } },
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Add Connection" }),
    );
    await expect(args.onConnected).toHaveBeenCalledOnce();
  },
};
