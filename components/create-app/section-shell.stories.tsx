import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";

import styles from "../../app/ui/app-builder.module.css";
import { SectionShell } from "./choice-card";

const meta = {
  title: "Create App/Primitives/Section Shell",
  component: SectionShell,
  args: {
    className: styles.sectionField,
    section: "connections",
    title: "Connections",
    description: "Give this app access to tools and data from other services.",
    children: <button type="button">Add connection</button>,
  },
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
} satisfies Meta<typeof SectionShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
