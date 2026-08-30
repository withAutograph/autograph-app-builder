import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { ConnectionsSection } from "./app-builder";
import { CreateAppStoryFrame } from "./create-app-story-frame";

const meta = {
  title: "Create App/Sections/Connections",
  component: ConnectionsSection,
  args: {
    connected: [],
    onAdd: fn(),
    onCustomize: fn(),
    onRemove: fn(),
    onSearchChange: fn(),
    onShowMore: fn(),
    search: "",
    selected: [],
    showMore: false,
  },
  decorators: [
    (Story) => (
      <CreateAppStoryFrame>
        <Story />
      </CreateAppStoryFrame>
    ),
  ],
} satisfies Meta<typeof ConnectionsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Expanded: Story = { args: { showMore: true } };
export const Filtered: Story = { args: { search: "quick" } };
export const EmptySearch: Story = { args: { search: "missing" } };
export const Added: Story = { args: { selected: ["QuickBooks"] } };
export const Connected: Story = {
  args: { selected: ["QuickBooks"], connected: ["QuickBooks"] },
};
export const AddRemoveAndCustomize: Story = {
  args: { selected: ["QuickBooks"], connected: ["QuickBooks"] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await userEvent.click(
      canvas.getByRole("button", { name: "Remove QuickBooks" }),
    );
    await expect(args.onCustomize).toHaveBeenCalledWith("QuickBooks");
    await expect(args.onRemove).toHaveBeenCalledWith("QuickBooks");
  },
};
export const SearchClearAndShowMore: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(
      canvas.getByPlaceholderText("Search connections…"),
      "quick",
    );
    await expect(args.onSearchChange).toHaveBeenCalled();
    await userEvent.click(
      canvas.getByRole("button", { name: "Show more connections" }),
    );
    await expect(args.onShowMore).toHaveBeenCalledOnce();
  },
};
