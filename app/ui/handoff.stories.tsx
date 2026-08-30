import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, within } from "storybook/test";
import {
  storyForm,
  storyProvisioning,
} from "@/.storybook/create-app/app-builder-fixtures";
import { Handoff } from "./app-builder";

const meta = {
  title: "Create App/Flow/Handoff",
  component: Handoff,
  args: {
    form: storyForm,
    requestId: storyProvisioning.requestId,
    provisioningEnabled: false,
    onReady: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Handoff>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProvisioningDisabled: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", { name: "Handoff" }),
    ).toBeVisible();
    await expect(within(canvasElement).getByRole("status")).toHaveTextContent(
      "Provider setup complete. Opening your selected client.",
    );
  },
};
