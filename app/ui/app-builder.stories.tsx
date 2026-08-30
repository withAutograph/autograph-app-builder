import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { AppBuilder } from "./app-builder";
import { storyIntegrations } from "./create-app-story-fixtures";

const meta = {
  title: "Create App/Page",
  component: AppBuilder,
  args: { authenticated: true, integrations: storyIntegrations },
  parameters: { layout: "fullscreen" },
} satisfies Meta<typeof AppBuilder>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};
