import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { AutographMark } from "./app-builder";

const meta = {
  title: "Create App/Primitives/Brand",
  component: AutographMark,
} satisfies Meta<typeof AutographMark>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Compact: Story = { args: { compact: true } };
