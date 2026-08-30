import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, userEvent, within } from "storybook/test";

import { WorkspaceBrief } from "./workspace-brief";

const meta = {
  title: "Pages/Workspace/Brief Composer",
  component: WorkspaceBrief,
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof WorkspaceBrief>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {};

export const Populated: Story = {
  args: {
    initialBrief: {
      objective: "Give vendors a guided onboarding experience.",
      repository: "withAutograph/vendor-portal",
      constraints: "Use the existing Better Auth and Vercel integration.",
      doneWhen: "A vendor can submit details and track approval progress.",
    },
  },
};

export const CopySuccess: Story = {
  args: {
    writeToClipboard: async () => undefined,
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByLabelText("What do you want to build?"),
      "Create an approval queue",
    );
    await userEvent.click(
      canvas.getByRole("button", { name: "Copy Autograph App Builder brief" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Autograph App Builder brief copied.",
    );
  },
};

export const CopyUnavailable: Story = {
  args: {
    writeToClipboard: async () => Promise.reject(new Error("blocked")),
  },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    await userEvent.click(
      canvas.getByRole("button", { name: "Copy Autograph App Builder brief" }),
    );
    await expect(canvas.getByRole("status")).toHaveTextContent(
      "Copy isn’t available in this browser.",
    );
  },
};
