import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { Ready } from "./app-builder";
import { storyForm } from "./create-app-story-fixtures";

const meta = {
  title: "Create App/Flow/Ready",
  component: Ready,
  args: {
    form: storyForm,
    initialAttempt: "attempted",
    initialClipboardState: "copied",
    onReset: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Ready>;
export default meta;
type Story = StoryObj<typeof meta>;
export const LaunchRequested: Story = {};
export const ClipboardFailed: Story = {
  args: { initialAttempt: "blocked", initialClipboardState: "failed" },
};
export const BriefTooLong: Story = {
  args: {
    form: { ...storyForm, brief: "x".repeat(8_100) },
    initialAttempt: "too-long",
    initialClipboardState: "failed",
  },
};
export const DismissInstallInstructions: Story = {
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Dismiss install instructions" }),
    );
    await expect(
      canvas.queryByRole("heading", { name: "Install App Builder Plugin" }),
    ).not.toBeInTheDocument();
  },
};
export const ResetAction: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(
      within(canvasElement).getByRole("button", { name: "Create Another App" }),
    );
    await expect(args.onReset).toHaveBeenCalledOnce();
  },
};
