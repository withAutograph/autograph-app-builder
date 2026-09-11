import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import { storybookAuthenticatedSession } from "@/.storybook/auth-session";
import { storyIntegrations } from "@/.storybook/create-app/app-builder-fixtures";

import { AppBuilder } from "./app-builder";

const connectionsEnabled =
  process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED === "true";
const comingSoonEnabled =
  process.env.STORYBOOK_BUILDER_COMING_SOON_ENABLED === "true";
const provisioningEnabled =
  process.env.STORYBOOK_BUILDER_PROVISIONING_ENABLED === "true";

const meta = {
  args: {
    authenticated: true,
    comingSoonEnabled,
    connectionsEnabled,
    integrations: storyIntegrations,
    provisioningEnabled,
  },
  component: AppBuilder,
  parameters: {
    authSession: storybookAuthenticatedSession,
    layout: "fullscreen",
  },
  title: "Create App/Flow/Page",
} satisfies Meta<typeof AppBuilder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(window.getComputedStyle(canvasElement).fontFamily).toContain(
      "GeistSans"
    );

    const avatar = canvasElement.querySelector<HTMLElement>(
      '[data-slot="avatar"]'
    );
    await expect(avatar).not.toBeNull();
    await expect(window.getComputedStyle(avatar!).width).toBe("32px");
    await expect(
      canvasElement.querySelector('[data-slot="avatar-fallback"]')
    ).toHaveTextContent("AU");
  },
};
