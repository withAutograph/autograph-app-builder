import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";
import { BuildWithSection } from "./app-builder";

const meta = {
  title: "Create App/Sections/Build With",
  component: BuildWithSection,
  args: { selected: "codex", onChange: fn() },
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
} satisfies Meta<typeof BuildWithSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const CodexSelected: Story = {};
export const CursorSelected: Story = { args: { selected: "cursor" } };
export const SelectCursor: Story = {
  play: async ({ canvasElement, args }) => {
    await userEvent.click(within(canvasElement).getByText("Cursor"));
    await expect(args.onChange).toHaveBeenCalledWith("cursor");
    await expect(
      within(canvasElement).getByRole("radio", { name: /Web Chat/ }),
    ).toBeDisabled();
  },
};
