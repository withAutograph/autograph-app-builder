import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, waitFor, within } from "storybook/test";

import {
  storyForm,
  storyHandoff,
  storyProvisioning,
} from "@/.storybook/create-app/app-builder-fixtures";

import { Handoff } from "./app-builder";

const meta = {
  title: "Create App/Flow/Handoff",
  component: Handoff,
  args: {
    form: storyForm,
    requestId: storyProvisioning.requestId,
    handoffCreationRequestId: "123e4567-e89b-42d3-a456-426614174002",
    provisioningEnabled: false,
    continuationAction: fn(async () => ({
      status: "ready" as const,
      provisioning: storyProvisioning,
      handoff: storyHandoff,
    })),
    onReady: fn(),
  },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof Handoff>;
export default meta;
type Story = StoryObj<typeof meta>;
export const ProvisioningDisabled: Story = {
  play: async ({ canvasElement }) => {
    await expect(
      within(canvasElement).getByRole("heading", { name: "Handoff" })
    ).toBeVisible();
    await waitFor(() =>
      expect(within(canvasElement).getByRole("status")).toHaveTextContent(
        "Your secure handoff is ready. Opening your selected client."
      )
    );
  },
};
