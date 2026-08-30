import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";
import { AutographMark } from "./app-builder";

const meta = {
  title: "Create App/Primitives/Brand",
  component: AutographMark,
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
} satisfies Meta<typeof AutographMark>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
