import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { storyIntegrations } from "@/.storybook/create-app/app-builder-fixtures";

import { AppBuilder } from "./app-builder";

const meta = {
  title: "Create App/Page",
  component: AppBuilder,
  args: { authenticated: true, integrations: storyIntegrations },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppBuilder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
