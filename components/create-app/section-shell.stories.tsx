import type { Meta, StoryObj } from "@storybook/nextjs-vite";

import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";

import { SectionShell } from "./choice-card";

import styles from "../../app/ui/app-builder.module.css";

const meta = {
  args: {
    children: <button type="button">Add connection</button>,
    className: styles.sectionField,
    description: "Give this app access to tools and data from other services.",
    section: "connections",
    title: "Connections",
  },
  component: SectionShell,
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
  title: "Components/Create App/Primitives/Section Shell",
} satisfies Meta<typeof SectionShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
