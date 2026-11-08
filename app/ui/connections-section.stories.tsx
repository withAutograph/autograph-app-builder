import type { Meta, StoryObj } from "@storybook/nextjs-vite";
import { expect, fn, userEvent, within } from "storybook/test";
import { CreateAppFormStoryLayout } from "@/.storybook/create-app/layouts";
import { ConnectionsSection } from "./builder-connections";

const meta = {
  args: {
    connected: [],
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    onAdd: fn(),
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    onCustomize: fn(),
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    onRemove: fn(),
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    onSearchChange: fn(),
    // oxlint-disable-next-line typescript/strict-void-return -- Preserve the existing callback return contract.
    onShowMore: fn(),
    search: "",
    selected: [],
    showMore: false,
  },
  component: ConnectionsSection,
  decorators: [
    (Story) => (
      <CreateAppFormStoryLayout>
        <Story />
      </CreateAppFormStoryLayout>
    ),
  ],
  title: "Components/Create App/Sections/Connections",
} satisfies Meta<typeof ConnectionsSection>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const Expanded: Story = { args: { showMore: true } };
export const Filtered: Story = { args: { search: "quick" } };
export const EmptySearch: Story = { args: { search: "missing" } };
export const Added: Story = { args: { selected: ["QuickBooks"] } };
export const Connected: Story = {
  args: { connected: ["QuickBooks"], selected: ["QuickBooks"] },
};
export const AddRemoveAndCustomize: Story = {
  args: { connected: ["QuickBooks"], selected: ["QuickBooks"] },
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.click(canvas.getByRole("button", { name: "Customize" }));
    await userEvent.click(canvas.getByRole("button", { name: "Remove QuickBooks" }));
    await expect(args.onCustomize).toHaveBeenCalledWith("QuickBooks");
    await expect(args.onRemove).toHaveBeenCalledWith("QuickBooks");
  },
};
export const SearchClearAndShowMore: Story = {
  play: async ({ canvasElement, args }) => {
    const canvas = within(canvasElement);
    await userEvent.type(canvas.getByPlaceholderText("Search connections…"), "quick");
    await expect(args.onSearchChange).toHaveBeenCalled();
    await userEvent.click(canvas.getByRole("button", { name: "Show more connections" }));
    await expect(args.onShowMore).toHaveBeenCalledOnce();
  },
};
