import type { ComponentProps } from "react";
import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect } from "storybook/test";

import { storyIntegrations } from "@/.storybook/create-app/app-builder-fixtures";
import { storybookAuthenticatedSession } from "@/.storybook/auth-session";

import { AuthenticatedBuilder } from "./authenticated-builder";
import { Header } from "./builder-shell";
import styles from "./app-builder.module.css";

function AppBuilderStory(props: ComponentProps<typeof AuthenticatedBuilder>) {
  return (
    <div className={styles.appShell}>
      <Header />
      <AuthenticatedBuilder {...props} />
    </div>
  );
}

const connectionsEnabled = process.env.STORYBOOK_BUILDER_CONNECTIONS_ENABLED === "true";
const comingSoonEnabled = process.env.STORYBOOK_BUILDER_COMING_SOON_ENABLED === "true";
const provisioningEnabled = process.env.STORYBOOK_BUILDER_PROVISIONING_ENABLED === "true";

const meta = {
  title: "Create App/Flow/Page",
  component: AppBuilderStory,
  args: {
    connectionsEnabled,
    comingSoonEnabled,
    provisioningEnabled,
    integrations: storyIntegrations,
  },
  parameters: {
    layout: "fullscreen",
    authSession: storybookAuthenticatedSession,
  },
} satisfies Meta<typeof AppBuilderStory>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  play: async ({ canvasElement }) => {
    await expect(window.getComputedStyle(canvasElement).fontFamily).toContain("GeistSans");

    const avatar = canvasElement.querySelector<HTMLElement>('[data-slot="avatar"]');
    await expect(avatar).not.toBeNull();
    await expect(window.getComputedStyle(avatar!).width).toBe("32px");
    await expect(canvasElement.querySelector('[data-slot="avatar-fallback"]')).toHaveTextContent(
      "AU",
    );
  },
};
