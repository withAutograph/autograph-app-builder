import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import { storyIntegrations } from "@/.storybook/create-app/app-builder-fixtures";
import { storybookAuthenticatedSession } from "@/.storybook/auth-session";

import { AppBuilder } from "./app-builder";

const connectionsEnabled =
  process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED === "true";
const comingSoonEnabled = true;

const meta = {
  title: "Create App/Page",
  component: AppBuilder,
  args: {
    authenticated: true,
    connectionsEnabled,
    comingSoonEnabled,
    provisioningEnabled: true,
    integrations: storyIntegrations,
  },
  parameters: {
    layout: "fullscreen",
    authSession: storybookAuthenticatedSession,
  },
} satisfies Meta<typeof AppBuilder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(window.getComputedStyle(canvasElement).fontFamily).toContain(
      "GeistSans",
    );

    const avatar = canvasElement.querySelector<HTMLElement>(
      '[data-slot="avatar"]',
    );
    await expect(avatar).not.toBeNull();
    await expect(window.getComputedStyle(avatar!).width).toBe("32px");
    await expect(
      canvasElement.querySelector('[data-slot="avatar-fallback"]'),
    ).toHaveTextContent("AU");
  },
};
