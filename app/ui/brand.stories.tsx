import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AutographMark } from "./app-builder";
import { CreateAppStoryFrame } from "./create-app-story-frame";

const meta = {
  title: "Create App/Primitives/Brand",
  component: AutographMark,
  decorators: [
    (Story) => (
      <CreateAppStoryFrame>
        <Story />
      </CreateAppStoryFrame>
    ),
  ],
} satisfies Meta<typeof AutographMark>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
